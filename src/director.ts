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
  private interrupted = false;
  private flushing = false;
  private lastTimeSyncAt = 0;
  private lastFlushAt: number = Date.now();
  private lastInputTokens = 0;
  private pendingCount = 0;
  private flushCheckpointResolve: (() => void) | null = null;
  private flushBootstrapResolve: (() => void) | null = null;
  private drainResolve: (() => void) | null = null;

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

  /** Send SIGINT to cancel current request, then auto-restart with --resume */
  async interrupt(): Promise<void> {
    if (this.flushing) {
      console.log('[director] Interrupt skipped: flush in progress');
      return;
    }

    const pid = this.readPid();
    if (!pid) return;

    this.interrupted = true;
    console.log(`[director] Interrupting (pid: ${pid})...`);

    try { process.kill(-pid, 'SIGINT'); } catch { /* already dead */ }

    // Wait for close handler to finish restart
    await new Promise<void>((resolve) => {
      this.once('restarted', resolve);
    });
  }

  /** Kill current Director and restart with a fresh session (no --conversation-id) */
  async flush(): Promise<boolean> {
    if (this.flushing) {
      console.log('[director] FLUSH already in progress, skipping');
      return false;
    }

    // Wait for interrupt to complete if in progress
    if (this.interrupted) {
      console.log('[director] FLUSH: waiting for interrupt to complete...');
      await new Promise<void>((resolve) => {
        this.once('restarted', resolve);
      });
    }

    this.flushing = true;

    // Drain: wait for in-flight messages to complete
    if (this.pendingCount > 0) {
      console.log(`[director] FLUSH: draining ${this.pendingCount} in-flight messages...`);
      const drained = await this.waitForDrain(30_000);
      if (!drained) {
        console.warn('[director] FLUSH: drain timeout, aborting flush');
        this.flushing = false;
        return false;
      }
    }

    // Step 1 - Checkpoint: ask Director to save state
    console.log('[director] FLUSH: starting checkpoint...');
    const checkpointDone = new Promise<void>((resolve) => {
      this.flushCheckpointResolve = resolve;
    });
    this.pendingCount++;
    await this.writeRaw(
      '[FLUSH] 系统即将进行上下文刷新。请将当前工作状态保存到 daily/state.md，包括：进行中的任务、待处理的事项、需要保留的上下文。保存完成后回复"已保存"。'
    );

    const checkpointOk = await Promise.race([
      checkpointDone.then(() => true),
      this.timeout(30_000).then(() => false),
    ]);
    if (!checkpointOk) {
      console.warn('[director] FLUSH: checkpoint timeout, skipping checkpoint and forcing reset');
      this.flushCheckpointResolve = null;
      // Fall through to kill+restart — don't abort, otherwise the
      // checkpoint message is still in-flight and its late response
      // would leak to users.
    } else {
      console.log('[director] FLUSH: checkpoint done');
    }

    // Step 2 - Reset: kill process + clear session + clean pipes
    const pid = this.readPid();
    if (pid) {
      try { process.kill(-pid, 'SIGTERM'); } catch { /* already dead */ }
    }

    this.clearSession();
    await this.restart();

    // Step 3 - Bootstrap: tell new Director to restore state
    const bootstrapDone = new Promise<void>((resolve) => {
      this.flushBootstrapResolve = resolve;
    });
    this.pendingCount++;
    await this.writeRaw(
      '[FLUSH] 你刚经历了上下文刷新。请读取 daily/state.md 恢复工作上下文。'
    );

    const bootstrapOk = await Promise.race([
      bootstrapDone.then(() => true),
      this.timeout(30_000).then(() => false),
    ]);
    if (!bootstrapOk) {
      console.warn('[director] FLUSH: bootstrap timeout, will discard late response');
      this.flushBootstrapResolve = null;
      // Keep flushing=true — the late bootstrap result will be
      // discarded by the result handler (flushing=true, both resolves null),
      // which then sets flushing=false via finishFlush().
    }

    this.finishFlush();
    console.log('[director] FLUSH: complete');
    return true;
  }

  private finishFlush(): void {
    this.lastFlushAt = Date.now();
    this.lastInputTokens = 0;
    this.flushing = false;
  }

  get isFlushing(): boolean {
    return this.flushing;
  }

  async send(message: string): Promise<void> {
    if (!this.writeHandle) {
      throw new Error('Director not started');
    }
    if (this.flushing) {
      throw new Error('Director is flushing');
    }

    // Inject time sync as message prefix (not a separate writeRaw call)
    let content = message;
    const now = Date.now();
    if (now - this.lastTimeSyncAt > this.config.time_sync_interval_ms) {
      const timeStr = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
      content = `[${timeStr}] ${message}`;
      this.lastTimeSyncAt = now;
    }

    this.pendingCount++;
    await this.writeRaw(content);
  }

  private async writeRaw(content: string): Promise<void> {
    const payload = JSON.stringify({
      type: 'user',
      message: { role: 'user', content },
    }) + '\n';

    await this.writeHandle!.write(payload);
  }

  async stop(): Promise<void> {
    await this.writeHandle?.close();
    this.writeHandle = null;
  }

  private waitForDrain(timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      if (this.pendingCount <= 0) {
        resolve(true);
        return;
      }
      const timer = setTimeout(() => {
        this.drainResolve = null;
        resolve(false);
      }, timeoutMs);
      this.drainResolve = () => {
        clearTimeout(timer);
        resolve(true);
      };
    });
  }

  private timeout(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private checkFlush(): void {
    if (this.flushing) return;

    const contextOverLimit = this.lastInputTokens > this.config.flush_context_limit;
    const timeOverLimit = Date.now() - this.lastFlushAt > this.config.flush_interval_ms;

    if (contextOverLimit || timeOverLimit) {
      const reason = contextOverLimit
        ? `context tokens ${this.lastInputTokens} > ${this.config.flush_context_limit}`
        : `time since last flush exceeded ${this.config.flush_interval_ms}ms`;
      console.log(`[director] Auto-flush triggered: ${reason}`);
      // Fire and forget — flush is async but we don't block the event loop
      this.flush().catch((err) => console.error('[director] Auto-flush failed:', err));
    }
  }

  private async restart(): Promise<void> {
    await this.writeHandle?.close();
    this.writeHandle = null;

    for (const pipe of [this.pipeIn, this.pipeOut]) {
      try { unlinkSync(pipe); } catch { /* ok */ }
    }

    await this.start();
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
            // Track input_tokens from usage
            if (event.usage?.input_tokens) {
              this.lastInputTokens = event.usage.input_tokens;
            }

            this.pendingCount = Math.max(0, this.pendingCount - 1);

            if (currentResponse) {
              if (this.flushing && this.flushCheckpointResolve) {
                // Flush checkpoint response — don't emit to users
                console.log(`[director] FLUSH checkpoint response: ${currentResponse.trim().slice(0, 100)}`);
                this.flushCheckpointResolve();
                this.flushCheckpointResolve = null;
              } else if (this.flushing && this.flushBootstrapResolve) {
                // Flush bootstrap response — don't emit to users
                console.log(`[director] FLUSH bootstrap response: ${currentResponse.trim().slice(0, 100)}`);
                this.flushBootstrapResolve();
                this.flushBootstrapResolve = null;
              } else if (this.flushing) {
                // Late flush response (bootstrap timeout) — discard and end flush
                console.log(`[director] FLUSH: discarding late response, ending flush`);
                this.finishFlush();
              } else {
                this.emit('response', currentResponse.trim());
              }
              currentResponse = '';
            }

            // Check if drain is complete
            if (this.pendingCount <= 0 && this.drainResolve) {
              this.drainResolve();
              this.drainResolve = null;
            }

            // Check if auto-flush is needed (after emitting response)
            if (!this.flushing) {
              this.checkFlush();
            }
            break;
        }
      } catch {
        // Non-JSON line, ignore
      }
    });

    rl.on('close', async () => {
      // Reset pending count — any in-flight messages are lost with the pipe
      this.pendingCount = 0;
      if (this.drainResolve) {
        this.drainResolve();
        this.drainResolve = null;
      }

      if (this.interrupted) {
        this.interrupted = false;
        console.log('[director] Interrupted, restarting with --resume...');
        await this.restart();
        this.emit('restarted');
      } else if (this.flushing) {
        // Flush handles its own restart — do nothing here
        console.log('[director] Pipe closed during flush (expected)');
      } else {
        console.log('[director] Output pipe closed, director may have exited');
        this.emit('close');
      }
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
