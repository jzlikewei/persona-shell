import { EventEmitter } from 'events';
import { spawn, execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
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

  constructor(config: Config['director']) {
    super();
    this.config = config;
    this.pipeIn = join(config.pipe_dir, 'director-in');
    this.pipeOut = join(config.pipe_dir, 'director-out');
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
    // Use shell redirection so the shell handles FIFO opens,
    // not Node.js (which would deadlock with openSync)
    const cmd = `${this.config.claude_path} --print --input-format stream-json --output-format stream-json --verbose`;

    const child = spawn('sh', ['-c', `${cmd} < "${this.pipeIn}" > "${this.pipeOut}"`], {
      detached: true,
      stdio: 'ignore',
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
}
