import { EventEmitter } from 'events';
import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, appendFileSync } from 'fs';
import { open } from 'fs/promises';
import { join } from 'path';
import { createInterface } from 'readline';
import type { Config } from './config.js';
import type { FileHandle } from 'fs/promises';
import { getState, setState, listTasks } from './task-store.js';
import { spawnPersona } from './persona-process.js';
import { log } from './logger.js';

/** Base log directory */
const LOG_BASE = join(import.meta.dirname, '..', 'logs');

interface DirectorPersistedState {
  lastFlushAt: number;
  lastInputTokens: number;
  contextWindow: number;
}

export interface DirectorOptions {
  config: Config['director'];
  /** 唯一标识，如 'main' 或 chatId 的短 hash */
  label: string;
  /** 主 Director 标记（默认 true） */
  isMain?: boolean;
  /** 群聊名称，非主 Director 用于 bootstrap 消息 */
  groupName?: string;
}

export class Director extends EventEmitter {
  private config: Config['director'];
  readonly label: string;
  readonly isMain: boolean;
  private groupName?: string;
  private pipeIn: string;
  private pipeOut: string;
  private pipeDir: string;
  private pidFile: string;
  private writeHandle: FileHandle | null = null;
  private sessionFile: string;
  private sessionId: string | null = null;
  private sessionName: string | null = null;
  private interrupted = false;
  private flushing = false;
  private shuttingDown = false;
  private shutdownResolve: (() => void) | null = null;
  private explicitRestart = false;
  private lastTimeSyncAt = 0;
  private lastFlushAt: number = Date.now();
  private lastInputTokens = 0;
  private pendingCount = 0;
  private systemReplyQueue: string[] = [];
  /** 有序响应分派队列 — 每条发出的消息按序记录类型，result 到达时 shift 出来决定如何分派 */
  private pendingTypes: Array<
    | { type: 'user' }
    | { type: 'system-absorbed' }
    | { type: 'system-reply'; replyToMessageId: string }
  > = [];
  /** 系统消息（cron director_msg 等）的待处理计数，响应会被吸收不转发用户 */
  private systemMessagePending = 0;
  private bootstrapping = false;
  private bootstrapResolve: (() => void) | null = null;
  private flushCheckpointResolve: (() => void) | null = null;
  private flushBootstrapResolve: (() => void) | null = null;
  private drainResolve: (() => void) | null = null;
  /** Current message being processed — for dashboard display */
  private currentMessagePreview: string | null = null;
  private currentMessageStartedAt: number | null = null;
  /** Daily message counter (resets at midnight Shanghai time) */
  private messagesProcessedToday = 0;
  private currentCountDate: string = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  /** Accumulated cost from result events */
  private totalCostUsd = 0;
  /** Context window size from modelUsage (e.g. 1000000 for claude-opus) */
  private contextWindow = 0;
  /** 3.1: Generation counter — incremented on each listenOutput call to prevent stale close handlers */
  private generation = 0;
  /** 3.2: Recent restart timestamps for backoff detection */
  private restartTimestamps: number[] = [];
  /** Flag to discard the next late response after flush timeout */
  private discardNextResponse = false;

  /**
   * @param configOrOptions — 兼容两种调用方式：
   *   - `new Director(config.director)` — 向后兼容，默认 label='main', isMain=true
   *   - `new Director({ config, label, isMain, groupName })` — 新版多实例
   */
  constructor(configOrOptions: Config['director'] | DirectorOptions) {
    super();
    if ('config' in configOrOptions) {
      // New-style: DirectorOptions
      this.config = configOrOptions.config;
      this.label = configOrOptions.label;
      this.isMain = configOrOptions.isMain ?? true;
      this.groupName = configOrOptions.groupName;
    } else {
      // Legacy: Config['director'] — backward compatible
      this.config = configOrOptions;
      this.label = 'main';
      this.isMain = true;
    }

    // 路径参数化：主 Director 保持旧路径（向后兼容），非主用子目录
    if (this.isMain) {
      this.pipeDir = this.config.pipe_dir;
      this.pipeIn = join(this.pipeDir, 'director-in');
      this.pipeOut = join(this.pipeDir, 'director-out');
      this.sessionFile = join(this.pipeDir, 'director-session');
      this.pidFile = this.config.pid_file;
    } else {
      this.pipeDir = join(this.config.pipe_dir, this.label);
      this.pipeIn = join(this.pipeDir, 'director-in');
      this.pipeOut = join(this.pipeDir, 'director-out');
      this.sessionFile = join(this.pipeDir, 'session');
      this.pidFile = join(this.pipeDir, 'director.pid');
    }
  }

  /** State key parameterized by label: 'director:main', 'director:abc12345', etc. */
  private get stateKey(): string {
    return `director:${this.label}`;
  }

  /** Log directory for this Director: logs/{label}/ */
  private get logDir(): string {
    return join(LOG_BASE, this.label);
  }

  /** Today's date string for log file names (YYYYMMDD, Shanghai timezone) */
  private get logDate(): string {
    return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace(/-/g, '');
  }

  /** Current input log path: logs/{label}/input-{YYYYMMDD}.log */
  get inputLogPath(): string {
    return join(this.logDir, `input-${this.logDate}.log`);
  }

  /** Current output log path: logs/{label}/output-{YYYYMMDD}.log */
  get outputLogPath(): string {
    return join(this.logDir, `output-${this.logDate}.log`);
  }

  /** Restore persisted state (lastFlushAt, lastInputTokens, contextWindow). Returns restored data or null. */
  restoreState(): DirectorPersistedState | null {
    let saved = getState<DirectorPersistedState>(this.stateKey);
    // 向后兼容：主 Director 旧状态键是 'director'
    if (!saved && this.isMain) {
      saved = getState<DirectorPersistedState>('director');
    }
    if (!saved) return null;
    if (typeof saved.lastFlushAt === 'number') this.lastFlushAt = saved.lastFlushAt;
    if (typeof saved.lastInputTokens === 'number') this.lastInputTokens = saved.lastInputTokens;
    if (typeof saved.contextWindow === 'number') this.contextWindow = saved.contextWindow;
    return saved;
  }

  private persistState(): void {
    setState<DirectorPersistedState>(this.stateKey, {
      lastFlushAt: this.lastFlushAt,
      lastInputTokens: this.lastInputTokens,
      contextWindow: this.contextWindow,
    });
  }

  /** Timeout for FIFO pipe open — if process died between alive check and open */
  private static readonly PIPE_OPEN_TIMEOUT = 30_000; // 30 seconds

  async start(): Promise<boolean> {
    this.ensurePipeDir();

    let freshStart = true;
    if (this.isDirectorAlive()) {
      console.log(`[director:${this.label}] Existing director process found (pid: ${this.readPid()}), reconnecting...`);
      freshStart = false;
    } else {
      this.ensurePipes();
      this.spawnDirector();
    }

    // Open both pipe ends concurrently — this unblocks the shell's FIFO opens
    // Timeout prevents indefinite hang if the process died between alive check and pipe open
    const pipeOpenResult = await Promise.race([
      Promise.all([
        open(this.pipeIn, 'w'),
        open(this.pipeOut, 'r'),
      ]),
      this.timeout(Director.PIPE_OPEN_TIMEOUT).then(() => null),
    ]);

    if (!pipeOpenResult) {
      throw new Error(`[director:${this.label}] Pipe open timeout after ${Director.PIPE_OPEN_TIMEOUT / 1000}s — process may have died`);
    }

    const [writeHandle, readHandle] = pipeOpenResult;

    this.writeHandle = writeHandle;
    this.sessionId = this.readSession();
    console.log(`[director:${this.label}] Pipes connected`);

    this.listenOutput(readHandle);

    return freshStart;
  }

  /** Send SIGINT to cancel current request, then auto-restart with --resume */
  async interrupt(): Promise<void> {
    if (this.flushing) {
      console.log(`[director:${this.label}] Interrupt skipped: flush in progress`);
      return;
    }

    const pid = this.readPid();
    if (!pid) return;

    this.interrupted = true;
    console.log(`[director:${this.label}] Interrupting (pid: ${pid})...`);

    try { process.kill(-pid, 'SIGINT'); } catch { /* already dead */ }

    // Wait for close handler to finish restart
    await new Promise<void>((resolve) => {
      this.once('restarted', resolve);
    });
  }

  /**
   * Safety-net timeout for flush steps (drain / checkpoint / bootstrap).
   * Each step waits for Claude Code to complete a full conversation turn,
   * which can take minutes depending on context size.  This timeout only
   * fires when something is genuinely wrong (process crash, hang).
   */
  private static readonly FLUSH_STEP_TIMEOUT = 5 * 60_000; // 5 minutes

  /** Kill current Director and restart with a fresh session (no --conversation-id) */
  async flush(): Promise<boolean> {
    if (this.flushing) {
      console.log(`[director:${this.label}] FLUSH already in progress, skipping`);
      return false;
    }

    // Non-main Directors: skip checkpoint, just kill and restart
    if (!this.isMain) {
      this.flushing = true;
      const pid = this.readPid();
      if (pid) {
        try { process.kill(-pid, 'SIGTERM'); } catch { /* already dead */ }
      }
      this.clearSession();
      await this.restart();
      this.finishFlush();
      console.log(`[director:${this.label}] FLUSH: complete (non-main, no checkpoint)`);
      return true;
    }

    // 7.x: Warn about running tasks before flush
    const runningTasks = listTasks({ status: 'running' });
    if (runningTasks.length > 0) {
      console.warn(`[director:${this.label}] FLUSH: ${runningTasks.length} task(s) still running — new Director may miss results`);
    }

    // Wait for interrupt to complete if in progress
    if (this.interrupted) {
      console.log(`[director:${this.label}] FLUSH: waiting for interrupt to complete...`);
      await new Promise<void>((resolve) => {
        this.once('restarted', resolve);
      });
    }

    this.flushing = true;

    // Drain: wait for in-flight messages to complete
    if (this.pendingCount > 0) {
      console.log(`[director:${this.label}] FLUSH: draining ${this.pendingCount} in-flight messages...`);
      const drained = await this.waitForDrain(Director.FLUSH_STEP_TIMEOUT);
      if (!drained) {
        console.warn(`[director:${this.label}] FLUSH: drain timeout, aborting flush`);
        this.flushing = false;
        return false;
      }
    }

    // Clear orphaned queue items — after drain, any remaining items will never
    // get a response because the Director session is about to be destroyed.
    this.emit('flush-drain-complete');

    // Step 1 - Checkpoint: ask Director to save state
    console.log(`[director:${this.label}] FLUSH: starting checkpoint...`);
    const checkpointDone = new Promise<void>((resolve) => {
      this.flushCheckpointResolve = resolve;
    });
    this.pendingCount++;
    await this.writeRaw(
      '[FLUSH] 系统即将进行上下文刷新。请将当前工作状态保存到 daily/state.md，包括：进行中的任务、待处理的事项、需要保留的上下文。保存完成后回复"已保存"。'
    );

    const checkpointOk = await Promise.race([
      checkpointDone.then(() => true),
      this.timeout(Director.FLUSH_STEP_TIMEOUT).then(() => false),
    ]);
    if (!checkpointOk) {
      console.warn(`[director:${this.label}] FLUSH: checkpoint timeout, skipping checkpoint and forcing reset`);
      this.flushCheckpointResolve = null;
      this.discardNextResponse = true;
      // Fall through to kill+restart — don't abort, otherwise the
      // checkpoint message is still in-flight and its late response
      // would leak to users.
    } else {
      console.log(`[director:${this.label}] FLUSH: checkpoint done`);
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
      this.timeout(Director.FLUSH_STEP_TIMEOUT).then(() => false),
    ]);
    if (!bootstrapOk) {
      console.warn(`[director:${this.label}] FLUSH: bootstrap timeout — forcing flush finish`);
      this.flushBootstrapResolve = null;
      this.discardNextResponse = true;
      this.finishFlush();
    } else {
      this.finishFlush();
      console.log(`[director:${this.label}] FLUSH: complete`);
    }
    return true;
  }

  private finishFlush(): void {
    this.lastFlushAt = Date.now();
    this.lastInputTokens = 0;
    this.flushing = false;
    this.discardNextResponse = false;
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
    sessionName: string | null;
    flushing: boolean;
    interrupted: boolean;
    pendingCount: number;
    lastInputTokens: number;
    lastFlushAt: number;
    flushContextLimit: number;
    contextWindow: number;
    activityState: 'idle' | 'processing' | 'flushing' | 'restarting';
    currentMessagePreview: string | null;
    currentMessageStartedAt: number | null;
    messagesProcessedToday: number;
    totalCostUsd: number;
  } {
    // Reset daily counter if date changed
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
    if (today !== this.currentCountDate) {
      this.messagesProcessedToday = 0;
      this.totalCostUsd = 0;
      this.currentCountDate = today;
    }

    let activityState: 'idle' | 'processing' | 'flushing' | 'restarting';
    if (this.flushing) {
      activityState = 'flushing';
    } else if (this.interrupted) {
      activityState = 'restarting';
    } else if (this.pendingCount > 0) {
      activityState = 'processing';
    } else {
      activityState = 'idle';
    }

    return {
      alive: this.isDirectorAlive(),
      pid: this.readPid(),
      sessionId: this.sessionId,
      sessionName: this.sessionName,
      flushing: this.flushing,
      interrupted: this.interrupted,
      pendingCount: this.pendingCount,
      lastInputTokens: this.lastInputTokens,
      lastFlushAt: this.lastFlushAt,
      flushContextLimit: this.config.flush_context_limit,
      contextWindow: this.contextWindow,
      activityState,
      currentMessagePreview: this.currentMessagePreview,
      currentMessageStartedAt: this.currentMessageStartedAt,
      messagesProcessedToday: this.messagesProcessedToday,
      totalCostUsd: this.totalCostUsd,
    };
  }

  /** 公开的重启方法：杀掉当前进程并重新启动（保留 session，加载新配置） */
  async restartDirector(): Promise<void> {
    this.explicitRestart = true;
    const pid = this.readPid();
    if (pid) {
      try { process.kill(-pid, 'SIGTERM'); } catch { /* already dead */ }
    }
    // Wait for close handler to finish restart (it checks explicitRestart flag)
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.removeListener('restarted', onRestart);
        resolve();
      }, 30_000);
      const onRestart = () => {
        clearTimeout(timer);
        resolve();
      };
      this.once('restarted', onRestart);
    });
  }

  /** Timeout for bootstrap response — prevents hanging if Director is alive but unresponsive */
  private static readonly BOOTSTRAP_TIMEOUT = 3 * 60_000; // 3 minutes

  /** Send bootstrap message to initialize session and load context.
   *  Safe to call on every startup — response is absorbed, not emitted to users.
   *  Returns a Promise that resolves when the bootstrap response is received.
   *  Callers can `await` to ensure bootstrap completes before sending user messages,
   *  preventing Claude Code from merging bootstrap + user message into one turn. */
  async bootstrap(): Promise<void> {
    if (!this.writeHandle || this.flushing) return;
    this.bootstrapping = true;
    this.pendingCount++;

    const msg = this.isMain
      ? '[系统] 新 session 已启动。请读取 daily/state.md 恢复工作上下文，了解当前待处理事项。'
      : `[系统] 新 session 已启动。你正在为群「${this.groupName ?? this.label}」服务。请读取 daily/state.md 了解全局状态（只读）。`;

    // Set up completion promise before writing to avoid race
    const done = new Promise<void>((resolve) => {
      this.bootstrapResolve = resolve;
    });

    await this.writeRaw(msg);
    console.log(`[director:${this.label}] Bootstrap message sent`);

    // Wait for bootstrap response with timeout — prevents indefinite hang
    const timedOut = await Promise.race([
      done.then(() => false),
      this.timeout(Director.BOOTSTRAP_TIMEOUT).then(() => true),
    ]);
    if (timedOut) {
      console.warn(`[director:${this.label}] Bootstrap timeout after ${Director.BOOTSTRAP_TIMEOUT / 1000}s, continuing without bootstrap response`);
      this.bootstrapping = false;
      this.bootstrapResolve = null;
      this.decrementPending();
    }
  }

  async send(message: string): Promise<void> {
    if (!this.writeHandle) {
      throw new Error('Director not started');
    }
    if (this.flushing) {
      throw new Error('Director is flushing');
    }

    // Track current message for dashboard
    this.currentMessagePreview = message.slice(0, 50);
    this.currentMessageStartedAt = Date.now();

    // Inject time sync as message prefix (not a separate writeRaw call)
    let content = message;
    const now = Date.now();
    if (now - this.lastTimeSyncAt > this.config.time_sync_interval_ms) {
      const timeStr = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
      content = `[${timeStr}] ${message}`;
      this.lastTimeSyncAt = now;
    }

    this.pendingTypes.push({ type: 'user' });
    this.pendingCount++;
    await this.writeRaw(content);
  }

  /** 发送系统消息给 Director（如 cron director_msg），响应会被吸收不转发给用户 */
  async sendSystemMessage(msg: string): Promise<void> {
    if (!this.writeHandle || this.flushing) return;
    this.pendingTypes.push({ type: 'system-absorbed' });
    this.systemMessagePending++;
    this.pendingCount++;
    try {
      await this.writeRaw(msg);
    } catch {
      this.pendingTypes.pop();
      this.systemMessagePending = Math.max(0, this.systemMessagePending - 1);
      this.decrementPending();
    }
  }

  private async writeRaw(content: string): Promise<void> {
    if (!this.writeHandle) {
      throw new Error('pipe not open');
    }
    const msg = { type: 'user', message: { role: 'user', content } };
    const pipePayload = JSON.stringify(msg) + '\n';

    try {
      const logDir = this.logDir;
      if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
      const logPayload = JSON.stringify({ ...msg, timestamp: new Date().toISOString(), director: this.label }) + '\n';
      appendFileSync(this.inputLogPath, logPayload);
    } catch { /* best-effort logging */ }

    await this.writeHandle.write(pipePayload);
  }

  /** 7.3.5: Notify Director that a managed task has completed or failed */
  async notifyTaskDone(taskId: string, success: boolean, replyToMessageId?: string): Promise<void> {
    if (!this.writeHandle || this.flushing) return;
    this.pendingCount++;
    if (replyToMessageId) {
      this.pendingTypes.push({ type: 'system-reply', replyToMessageId });
      this.systemReplyQueue.push(replyToMessageId);
    } else {
      this.pendingTypes.push({ type: 'system-absorbed' });
    }
    const tag = success ? 'TASK_DONE' : 'TASK_FAILED';
    const msg = success
      ? `[${tag}] 后台任务 ${taskId} 已完成。调用 get_task MCP 工具查看详情。`
      : `[${tag}] 后台任务 ${taskId} 失败。调用 get_task MCP 工具查看错误信息。`;
    try {
      await this.writeRaw(msg);
    } catch {
      this.decrementPending();
      this.pendingTypes.pop();
      if (replyToMessageId) this.systemReplyQueue.pop();
    }
  }

  async stop(): Promise<void> {
    await this.writeHandle?.close();
    this.writeHandle = null;
  }

  /** Gracefully shut down: kill the Director process and wait for pipe close.
   *  Unlike restart(), this does NOT spawn a new process — used for /restart-shell. */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    const pid = this.readPid();
    if (!pid || !this.isDirectorAlive()) {
      // Already dead, just clean up
      await this.writeHandle?.close();
      this.writeHandle = null;
      return;
    }

    return new Promise<void>((resolve) => {
      this.shutdownResolve = resolve;
      try { process.kill(-pid, 'SIGTERM'); } catch { /* already dead */ }
      // Safety timeout — if pipe close never fires
      setTimeout(() => {
        if (this.shutdownResolve) {
          console.warn(`[director:${this.label}] Shutdown timeout, forcing`);
          this.shutdownResolve();
          this.shutdownResolve = null;
        }
      }, 10_000);
    });
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

  /** 安全递减 pendingCount，负数时记录错误而非静默钳位 */
  private decrementPending(): void {
    this.pendingCount--;
    if (this.pendingCount < 0) {
      console.error(`[director:${this.label}] BUG: pendingCount went negative (${this.pendingCount}), clamping to 0`);
      this.pendingCount = 0;
    }
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
      console.log(`[director:${this.label}] Auto-flush triggered: ${reason}`);
      // Fire and forget — flush is async but we don't block the event loop
      this.flush().then((success) => {
        if (success) {
          this.emit('auto-flush-complete');
        } else {
          // 4.1: Notify about auto-flush failure
          this.emit('alert', `⚠️ 自动 FLUSH 未能完成（reason: ${reason}）`);
        }
      }).catch((err) => {
        console.error(`[director:${this.label}] Auto-flush failed:`, err);
        this.emit('alert', `⚠️ 自动 FLUSH 异常: ${String(err).slice(0, 200)}`);
      });
    }
  }

  private async restart(): Promise<void> {
    // 3.2: Exponential backoff — abort if ≥3 restarts within 5 minutes
    const now = Date.now();
    const BACKOFF_WINDOW = 5 * 60_000; // 5 minutes
    const MAX_RESTARTS = 3;
    this.restartTimestamps.push(now);
    this.restartTimestamps = this.restartTimestamps.filter((t) => now - t < BACKOFF_WINDOW);
    if (this.restartTimestamps.length >= MAX_RESTARTS) {
      if (this.isMain) {
        console.error(`[director:${this.label}] ${this.restartTimestamps.length} restarts in ${BACKOFF_WINDOW / 1000}s — exiting to let launchd handle recovery`);
        process.exit(1);
      } else {
        console.error(`[director:${this.label}] ${this.restartTimestamps.length} restarts in ${BACKOFF_WINDOW / 1000}s — giving up, emitting close`);
        this.emit('stream-abort');
        this.emit('close');
        return;
      }
    }

    await this.writeHandle?.close();
    this.writeHandle = null;

    for (const pipe of [this.pipeIn, this.pipeOut]) {
      try { unlinkSync(pipe); } catch { /* ok */ }
    }

    await this.start();
  }

  private ensurePipeDir(): void {
    if (!existsSync(this.pipeDir)) {
      mkdirSync(this.pipeDir, { recursive: true });
    }
  }

  private ensurePipes(): void {
    for (const pipe of [this.pipeIn, this.pipeOut]) {
      if (!existsSync(pipe)) {
        execSync(`mkfifo "${pipe}"`);
        console.log(`[director:${this.label}] Created FIFO: ${pipe}`);
      }
    }
  }

  private spawnDirector(): void {
    const personaDir = this.config.persona_dir;
    const mcpConfigPath = join(personaDir, '.mcp.json');

    const savedSession = this.readSession();
    if (savedSession) {
      console.log(`[director:${this.label}] Resuming session: ${savedSession}`);
    } else {
      console.log(`[director:${this.label}] Starting new session`);
    }

    // 生成语义化 session 名称：director-{label}-{日期T时分}[-{群名}]
    const now = new Date();
    const dateStr = now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace(/-/g, '');
    const timeStr = now.toLocaleTimeString('sv-SE', { timeZone: 'Asia/Shanghai', hour12: false, hour: '2-digit', minute: '2-digit' }).replace(':', '');
    const nameParts = ['director', this.label, `${dateStr}T${timeStr}`];
    if (this.groupName) nameParts.push(this.groupName);
    const sessionName = nameParts.join('-');
    this.sessionName = sessionName;

    const { child } = spawnPersona({
      role: 'director',
      personaDir,
      claudePath: this.config.claude_path,
      mode: 'foreground',
      mcpConfigPath,
      sessionId: savedSession ?? undefined,
      sessionName,
      pipeIn: this.pipeIn,
      pipeOut: this.pipeOut,
      stderrPath: join(this.pipeDir, 'director-stderr.log'),
      env: { DIRECTOR_LABEL: this.label },
    });

    if (child.pid) {
      writeFileSync(this.pidFile, String(child.pid));
      console.log(`[director:${this.label}] Spawned claude process (pid: ${child.pid})`);
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

      // 4.2: Sidecar raw output to logs/{label}/output-{date}.log before parsing
      try {
        const logDir = this.logDir;
        if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
        const parsed = JSON.parse(line);
        parsed._ts = new Date().toISOString();
        parsed._director = this.label;
        appendFileSync(this.outputLogPath, JSON.stringify(parsed) + '\n');
      } catch {
        // JSON parse failed — write raw line as fallback
        try { appendFileSync(this.outputLogPath, line + '\n'); } catch { /* best-effort */ }
      }

      try {
        const event = JSON.parse(line);

        switch (event.type) {
          case 'system':
            log.debug(`[director:${this.label}] System event: ${event.subtype}`);
            // Capture session_id from init event
            if (event.subtype === 'init' && event.session_id) {
              this.sessionId = event.session_id;
              this.saveSession(event.session_id);
              log.debug(`[director:${this.label}] Session ID: ${event.session_id}`);
            }
            break;

          case 'assistant':
            if (event.message?.content) {
              const content = event.message.content;
              // Should we stream chunks to listeners?
              // Peek at pendingTypes head to know if current response is for a user message
              const headType = this.pendingTypes[0]?.type;
              const shouldStream = !this.flushing && !this.bootstrapping
                && headType === 'user' && !this.discardNextResponse;
              if (typeof content === 'string') {
                currentResponse += content;
                if (shouldStream && content) this.emit('chunk', content);
              } else if (Array.isArray(content)) {
                for (const block of content) {
                  if (block.type === 'text') {
                    currentResponse += block.text;
                    if (shouldStream && block.text) this.emit('chunk', block.text);
                  }
                }
              }
            }
            break;

          case 'result':
            // Handle stale session error — clear session and let close handler restart
            if (event.is_error && event.errors?.some((e: string) => e.includes('No conversation found'))) {
              console.warn(`[director:${this.label}] Session expired, clearing session for fresh start`);
              this.clearSession();
              break;
            }

            // Track input_tokens from usage — estimate per-turn context size
            // usage is cumulative across all API turns; divide by num_turns for a reasonable estimate
            if (event.usage) {
              const totalInput = (event.usage.input_tokens ?? 0)
                + (event.usage.cache_creation_input_tokens ?? 0)
                + (event.usage.cache_read_input_tokens ?? 0);
              const numTurns = event.num_turns ?? 1;
              if (totalInput > 0 && numTurns > 0) {
                this.lastInputTokens = Math.round(totalInput / numTurns);
                this.persistState();
              }
            }

            // Extract contextWindow from modelUsage (real model context limit)
            if (event.modelUsage && typeof event.modelUsage === 'object') {
              for (const model of Object.values(event.modelUsage) as Array<Record<string, unknown>>) {
                if (typeof model?.contextWindow === 'number' && model.contextWindow > 0) {
                  this.contextWindow = model.contextWindow as number;
                  break;
                }
              }
            }

            // Track cost from result events
            if (typeof event.cost_usd === 'number') {
              this.totalCostUsd += event.cost_usd;
            }

            // Clear current message tracking
            this.currentMessagePreview = null;
            this.currentMessageStartedAt = null;

            this.decrementPending();

            if (currentResponse) {
              if (this.flushing && this.flushCheckpointResolve) {
                // Flush checkpoint response — don't emit to users
                log.debug(`[director:${this.label}] FLUSH checkpoint response: ${currentResponse.trim().slice(0, 100)}`);
                this.flushCheckpointResolve();
                this.flushCheckpointResolve = null;
              } else if (this.flushing && this.flushBootstrapResolve) {
                // Flush bootstrap response — don't emit to users
                log.debug(`[director:${this.label}] FLUSH bootstrap response: ${currentResponse.trim().slice(0, 100)}`);
                this.flushBootstrapResolve();
                this.flushBootstrapResolve = null;
              } else if (this.discardNextResponse) {
                // Late response after flush timeout — discard silently
                log.debug(`[director:${this.label}] Discarding late post-flush response: ${currentResponse.trim().slice(0, 100)}`);
                this.discardNextResponse = false;
              } else if (this.bootstrapping) {
                // Startup bootstrap response — absorb, don't emit to users
                log.debug(`[director:${this.label}] Bootstrap response: ${currentResponse.trim().slice(0, 100)}`);
                this.bootstrapping = false;
                if (this.bootstrapResolve) {
                  this.bootstrapResolve();
                  this.bootstrapResolve = null;
                }
              } else {
                // Ordered dispatch: shift from pendingTypes to determine response type
                const pending = this.pendingTypes.shift();
                if (!pending || pending.type === 'user') {
                  this.messagesProcessedToday++;
                  this.emit('response', currentResponse.trim(), event.duration_ms);
                } else if (pending.type === 'system-reply') {
                  this.systemReplyQueue.shift();
                  log.debug(`[director:${this.label}] Task notification response (replyTo=${pending.replyToMessageId}): ${currentResponse.trim().slice(0, 100)}`);
                  this.emit('system-response', currentResponse.trim(), pending.replyToMessageId);
                } else {
                  // system-absorbed — cron director_msg, task notification without messageId
                  this.systemMessagePending--;
                  log.debug(`[director:${this.label}] System message response absorbed: ${currentResponse.trim().slice(0, 100)}`);
                }
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
      // 3.1: Ignore close events from stale generations
      if (gen !== this.generation) {
        console.log(`[director:${this.label}] Ignoring stale close event (gen=${gen}, current=${this.generation})`);
        return;
      }

      // Reset pending count — any in-flight messages are lost with the pipe
      this.pendingCount = 0;
      this.pendingTypes = [];
      this.systemReplyQueue = [];
      this.systemMessagePending = 0;
      if (this.drainResolve) {
        this.drainResolve();
        this.drainResolve = null;
      }
      // Resolve bootstrap if still waiting — prevents hanging on process crash during bootstrap
      if (this.bootstrapResolve) {
        this.bootstrapResolve();
        this.bootstrapResolve = null;
        this.bootstrapping = false;
      }

      if (this.shuttingDown) {
        // Graceful shutdown — do NOT restart
        console.log(`[director:${this.label}] Shutdown complete`);
        await this.writeHandle?.close();
        this.writeHandle = null;
        if (this.shutdownResolve) {
          this.shutdownResolve();
          this.shutdownResolve = null;
        }
      } else if (this.explicitRestart) {
        this.explicitRestart = false;
        console.log(`[director:${this.label}] Explicit restart, restarting with --resume...`);
        await this.restart();
        this.emit('restarted');
      } else if (this.interrupted) {
        this.interrupted = false;
        console.log(`[director:${this.label}] Interrupted, restarting with --resume...`);
        await this.restart();
        this.emit('restarted');
      } else if (this.flushing) {
        // Flush handles its own restart — do nothing here
        console.log(`[director:${this.label}] Pipe closed during flush (expected)`);
      } else if (!this.isMain) {
        // Non-main Director: emit 'close' for DirectorPool cleanup, don't exit
        console.log(`[director:${this.label}] Non-main Director closed unexpectedly`);
        this.emit('stream-abort');
        this.emit('close');
      } else {
        // 4.1: Alert before unexpected restart — this is a genuine crash
        // Session may be corrupted, clear it and bootstrap fresh
        this.emit('stream-abort');
        this.emit('alert', `🔴 Director 进程意外退出，正在重启...`);
        console.log(`[director:${this.label}] Output pipe closed, clearing session and restarting...`);
        this.clearSession();
        await this.restart();
        await this.bootstrap();
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
      const raw = readFileSync(this.pidFile, 'utf-8').trim();
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
