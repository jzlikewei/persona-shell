import { EventEmitter } from 'events';
import { spawn, execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, openSync } from 'fs';
import { open } from 'fs/promises';
import { join } from 'path';
import { createInterface } from 'readline';
import type { Config } from './config.js';
import type { FileHandle } from 'fs/promises';

export class Director extends EventEmitter {
  private config: Config['director'];
  private pipeIn: string;
  private pipeOut: string;
  private writeHandle: FileHandle | null = null;
  private sessionFile: string;
  private sessionId: string | null = null;

  constructor(config: Config['director']) {
    super();
    this.config = config;
    this.pipeIn = join(config.pipe_dir, 'director-in');
    this.pipeOut = join(config.pipe_dir, 'director-out');
    this.sessionFile = join(config.pipe_dir, 'director-session');
  }

  async start(): Promise<void> {
    this.ensurePipeDir();

    if (this.isDirectorAlive()) {
      console.log(`[director] Existing director process found (pid: ${this.readPid()}), reconnecting...`);
    } else {
      this.ensurePipes();
      this.spawnDirector();
    }

    // Open both pipe ends concurrently — this unblocks the shell's FIFO opens
    const [writeHandle, readHandle] = await Promise.all([
      open(this.pipeIn, 'w'),
      open(this.pipeOut, 'r'),
    ]);

    this.writeHandle = writeHandle;
    console.log('[director] Pipes connected');

    this.listenOutput(readHandle);
  }

  /** Kill current Director and restart with a fresh session (no --conversation-id) */
  async flush(): Promise<void> {
    console.log('[director] FLUSH: killing current session, starting fresh...');

    // Kill existing process
    const pid = this.readPid();
    if (pid) {
      try { process.kill(pid); } catch { /* already dead */ }
    }

    // Clear session — next spawn won't pass --conversation-id
    this.clearSession();

    // Clean up handles
    await this.writeHandle?.close();
    this.writeHandle = null;

    // Clean up pipes
    for (const pipe of [this.pipeIn, this.pipeOut]) {
      try { unlinkSync(pipe); } catch { /* ok */ }
    }

    // Restart
    await this.start();
  }

  async send(message: string): Promise<void> {
    if (!this.writeHandle) {
      throw new Error('Director not started');
    }

    const payload = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: message },
    }) + '\n';

    await this.writeHandle.write(payload);
  }

  async stop(): Promise<void> {
    await this.writeHandle?.close();
    this.writeHandle = null;
  }

  private ensurePipeDir(): void {
    if (!existsSync(this.config.pipe_dir)) {
      mkdirSync(this.config.pipe_dir, { recursive: true });
    }
  }

  private ensurePipes(): void {
    for (const pipe of [this.pipeIn, this.pipeOut]) {
      if (!existsSync(pipe)) {
        execSync(`mkfifo "${pipe}"`);
        console.log(`[director] Created FIFO: ${pipe}`);
      }
    }
  }

  private spawnDirector(): void {
    const personaDir = this.config.persona_dir;
    const personasDir = join(personaDir, 'personas');
    const skillsDir = join(personaDir, 'skills');

    let cmd = `${this.config.claude_path} --print --input-format stream-json --output-format stream-json --verbose --dangerously-skip-permissions --bare --add-dir "${personaDir}" --plugin-dir "${personasDir}" --plugin-dir "${skillsDir}"`;

    // Resume previous session if available
    const savedSession = this.readSession();
    if (savedSession) {
      cmd += ` --resume ${savedSession}`;
      console.log(`[director] Resuming session: ${savedSession}`);
    } else {
      console.log('[director] Starting new session');
    }

    const stderrPath = join(this.config.pipe_dir, 'director-stderr.log');
    const stderrFd = openSync(stderrPath, 'a');

    const child = spawn('sh', ['-c', `${cmd} < "${this.pipeIn}" > "${this.pipeOut}"`], {
      detached: true,
      stdio: ['ignore', 'ignore', stderrFd],
      cwd: personaDir,
    });

    child.unref();

    if (child.pid) {
      writeFileSync(this.config.pid_file, String(child.pid));
      console.log(`[director] Spawned claude process (pid: ${child.pid})`);
    }
  }

  private listenOutput(readHandle: FileHandle): void {
    const stream = readHandle.createReadStream({ encoding: 'utf-8' });
    const rl = createInterface({ input: stream });

    let currentResponse = '';

    rl.on('line', (line) => {
      if (!line.trim()) return;

      try {
        const event = JSON.parse(line);

        switch (event.type) {
          case 'system':
            console.log(`[director] System event: ${event.subtype}`);
            // Capture session_id from init event
            if (event.subtype === 'init' && event.session_id) {
              this.sessionId = event.session_id;
              this.saveSession(event.session_id);
              console.log(`[director] Session ID: ${event.session_id}`);
            }
            break;

          case 'assistant':
            if (event.message?.content) {
              const content = event.message.content;
              if (typeof content === 'string') {
                currentResponse += content;
              } else if (Array.isArray(content)) {
                for (const block of content) {
                  if (block.type === 'text') {
                    currentResponse += block.text;
                  }
                }
              }
            }
            break;

          case 'result':
            if (currentResponse) {
              this.emit('response', currentResponse.trim());
              currentResponse = '';
            }
            break;
        }
      } catch {
        // Non-JSON line, ignore
      }
    });

    rl.on('close', () => {
      console.log('[director] Output pipe closed, director may have exited');
      this.emit('close');
    });
  }

  private isDirectorAlive(): boolean {
    const pid = this.readPid();
    if (!pid) return false;

    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private readPid(): number | null {
    try {
      const raw = readFileSync(this.config.pid_file, 'utf-8').trim();
      return parseInt(raw, 10) || null;
    } catch {
      return null;
    }
  }

  private saveSession(sessionId: string): void {
    writeFileSync(this.sessionFile, sessionId);
  }

  private readSession(): string | null {
    try {
      return readFileSync(this.sessionFile, 'utf-8').trim() || null;
    } catch {
      return null;
    }
  }

  private clearSession(): void {
    try { unlinkSync(this.sessionFile); } catch { /* ok */ }
  }
}
