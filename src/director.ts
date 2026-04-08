import { EventEmitter } from 'events';
import { spawn, execSync } from 'child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, unlinkSync, openSync } from 'fs';
import { open } from 'fs/promises';
import { join } from 'path';
import { createInterface } from 'readline';
import type { Config } from './config.js';
import type { FileHandle } from 'fs/promises';
import { saveState, loadState } from './state-store.js';

interface DirectorPersistedState {
  lastFlushAt: number;
  lastInputTokens: number;
}

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
  private currentDate: string = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  private writingDailyReport = false;
  private flushCheckpointResolve: (() => void) | null = null;
  private flushBootstrapResolve: (() => void) | null = null;
  private drainResolve: (() => void) | null = null;
  /** 3.1: Generation counter — incremented on each listenOutput call to prevent stale close handlers */
  private generation = 0;
  /** 3.2: Recent restart timestamps for backoff detection */
  private restartTimestamps: number[] = [];

  constructor(config: Config['director']) {
    super();
    this.config = config;
    this.pipeIn = join(config.pipe_dir, 'director-in');
    this.pipeOut = join(config.pipe_dir, 'director-out');
    this.sessionFile = join(config.pipe_dir, 'director-session');
  }

  /** Restore persisted state (lastFlushAt, lastInputTokens). Returns restored data or null. */
  restoreState(): DirectorPersistedState | null {
    const saved = loadState<DirectorPersistedState>('director');
    if (!saved) return null;
    if (typeof saved.lastFlushAt === 'number') this.lastFlushAt = saved.lastFlushAt;
    if (typeof saved.lastInputTokens === 'number') this.lastInputTokens = saved.lastInputTokens;
    return saved;
  }

  private persistState(): void {
    saveState<DirectorPersistedState>('director', {
      lastFlushAt: this.lastFlushAt,
      lastInputTokens: this.lastInputTokens,
    });
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
      // Keep flushing=true — the late bootstrap result will arrive later and
      // be caught by the result handler (flushing=true, both resolves null),
      // which calls finishFlush() at that point. Do NOT finishFlush() here.
      console.log('[director] FLUSH: waiting for late bootstrap response to arrive before finishing');
    } else {
      this.finishFlush();
      console.log('[director] FLUSH: complete');
    }
    return true;
  }

  private finishFlush(): void {
    this.lastFlushAt = Date.now();
    this.lastInputTokens = 0;
    this.flushing = false;
    this.persistState();
  }

  get isFlushing(): boolean {
    return this.flushing;
  }

  /** 返回 Director 当前状态快照，供控制台使用 */
  getStatus(): {
    alive: boolean;
    pid: number | null;
    sessionId: string | null;
    flushing: boolean;
    interrupted: boolean;
    pendingCount: number;
    lastInputTokens: number;
    lastFlushAt: number;
    flushContextLimit: number;
  } {
    return {
      alive: this.isDirectorAlive(),
      pid: this.readPid(),
      sessionId: this.sessionId,
      flushing: this.flushing,
      interrupted: this.interrupted,
      pendingCount: this.pendingCount,
      lastInputTokens: this.lastInputTokens,
      lastFlushAt: this.lastFlushAt,
      flushContextLimit: this.config.flush_context_limit,
    };
  }

  /** 公开的重启方法：杀掉当前进程并重新启动 */
  async restartDirector(): Promise<void> {
    const pid = this.readPid();
    if (pid) {
      try { process.kill(-pid, 'SIGTERM'); } catch { /* already dead */ }
    }
    // restart() 会在 pipe close 回调中被触发，但我们这里主动调用以确保完成
    // 等待 pipe 关闭后自动 restart
    await new Promise<void>((resolve) => {
      const onRestart = () => resolve();
      // 如果 pipe close 触发了 restart，listenOutput 的 close handler 会调用 restart()
      // 我们用一个 timeout 兜底
      const timer = setTimeout(() => {
        this.removeListener('restarted', onRestart);
        resolve();
      }, 10_000);
      this.once('restarted', () => {
        clearTimeout(timer);
        onRestart();
      });
    });
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
    if (!this.writeHandle) {
      throw new Error('pipe not open');
    }
    const payload = JSON.stringify({
      type: 'user',
      message: { role: 'user', content },
    }) + '\n';

    await this.writeHandle.write(payload);
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
      this.flush().then((success) => {
        if (success) this.emit('auto-flush-complete');
      }).catch((err) => console.error('[director] Auto-flush failed:', err));
    }
  }

  private checkDailyReport(): void {
    if (this.flushing || this.writingDailyReport) return;

    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
    if (today === this.currentDate) return;

    const yesterday = this.currentDate;
    this.currentDate = today;

    console.log(`[director] Date changed: ${yesterday} → ${today}, requesting daily report...`);
    this.writingDailyReport = true;
    this.pendingCount++;
    this.writeRaw(
      `[系统] 日期已变更为 ${today}。请为 ${yesterday} 撰写日报，保存到 daily/${yesterday}.md。同时更新 daily/state.md 的状态。`
    ).catch((err) => console.error('[director] Failed to send daily report request:', err));
  }

  private async restart(): Promise<void> {
    // 3.2: Exponential backoff — abort if ≥3 restarts within 5 minutes
    const now = Date.now();
    const BACKOFF_WINDOW = 5 * 60_000; // 5 minutes
    const MAX_RESTARTS = 3;
    this.restartTimestamps.push(now);
    this.restartTimestamps = this.restartTimestamps.filter((t) => now - t < BACKOFF_WINDOW);
    if (this.restartTimestamps.length >= MAX_RESTARTS) {
      console.error(`[director] ${this.restartTimestamps.length} restarts in ${BACKOFF_WINDOW / 1000}s — exiting to let launchd handle recovery`);
      process.exit(1);
    }

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

    // Collect all skill subdirectories as plugin dirs
    const skillPluginDirs = readdirSync(skillsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => `--plugin-dir "${join(skillsDir, d.name)}"`)
      .join(' ');

    let cmd = `${this.config.claude_path} --print --input-format stream-json --output-format stream-json --verbose --dangerously-skip-permissions --bare --add-dir "${personaDir}" --plugin-dir "${personasDir}" ${skillPluginDirs}`;

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
    // 3.1: Capture current generation so stale close handlers are ignored
    const gen = ++this.generation;
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
            // Handle stale session error — clear session and let close handler restart
            if (event.is_error && event.errors?.some((e: string) => e.includes('No conversation found'))) {
              console.warn('[director] Session expired, clearing session for fresh start');
              this.clearSession();
              break;
            }

            // Track input_tokens from usage
            if (event.usage?.input_tokens) {
              this.lastInputTokens = event.usage.input_tokens;
              this.persistState();
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
              } else if (this.writingDailyReport) {
                // Daily report response — don't emit to users
                console.log(`[director] Daily report done: ${currentResponse.trim().slice(0, 100)}`);
                this.writingDailyReport = false;
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
              this.checkDailyReport();
            }
            break;
        }
      } catch {
        // Non-JSON line, ignore
      }
    });

    rl.on('close', async () => {
      // 3.1: Ignore close events from stale generations
      if (gen !== this.generation) {
        console.log(`[director] Ignoring stale close event (gen=${gen}, current=${this.generation})`);
        return;
      }

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
        console.log('[director] Output pipe closed, restarting...');
        await this.restart();
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
