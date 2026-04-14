import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, appendFileSync } from 'fs';
import { dirname, join } from 'path';
import { createInterface } from 'readline';
import { resolveAgentProvider, type Config } from './config.js';
import type { FileHandle } from 'fs/promises';
import { getState, setState, listTasks } from './task-store.js';
import { ClaudeProcess } from './claude-process.js';
import type { AgentRuntimeConfig } from './persona-process.js';
import { spawnPersona } from './persona-process.js';
import { log } from './logger.js';

/** Base log directory */
const LOG_BASE = join(import.meta.dirname, '..', 'logs');

interface BridgePersistedState {
  lastFlushAt: number;
  lastInputTokens: number;
  contextWindow: number;
}

export interface SessionBridgeOptions {
  agents: Config['agents'];
  config: Config['director'];
  /** 可选：覆盖 director 默认 agent（如 codex） */
  directorAgentName?: string;
  /** 唯一标识，如 'main' 或 chatId 的短 hash */
  label: string;
  /** 主实例标记（默认 true） */
  isMain?: boolean;
  /** 群聊名称，非主实例用于 bootstrap 消息 */
  groupName?: string;
}

export class SessionBridge extends EventEmitter {
  private config: Config['director'];
  private agents: Config['agents'];
  readonly label: string;
  readonly isMain: boolean;
  private groupName?: string;
  private directorAgent: AgentRuntimeConfig;
  private process: ClaudeProcess | null;
  private writeHandle: FileHandle | null = null;
  private sessionFile: string;
  private sessionId: string | null = null;
  private sessionName: string | null = null;
  private activeChild: ChildProcess | null = null;
  private codexQueue: string[] = [];
  private codexRunning = false;
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
  /** 有序响应分派队列 — 每条发出的消息按序记录类型，result 到达时 shift 出来决定如何分派。
   *
   *  IMPORTANT ASSUMPTION: Claude CLI guarantees FIFO response order — each `result`
   *  event corresponds to the oldest outstanding input message. If Claude CLI ever
   *  supports parallel processing or out-of-order responses, this queue-based dispatch
   *  will break and must be replaced with correlation-id matching. */
  private pendingTypes: Array<
    | { type: 'user' }
    | { type: 'system-absorbed' }
    | { type: 'system-reply'; replyToMessageId: string }
    | { type: 'system-forward' }
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

  constructor(configOrOptions: SessionBridgeOptions) {
    super();
    this.config = configOrOptions.config;
    this.agents = configOrOptions.agents;
    this.label = configOrOptions.label;
    this.isMain = configOrOptions.isMain ?? true;
    this.groupName = configOrOptions.groupName;
    this.directorAgent = resolveAgentProvider(this.agents, 'director', configOrOptions.directorAgentName);

    // 路径参数化：主 Director 保持旧路径（向后兼容），非主用子目录
    const pipeDir = this.isMain ? this.config.pipe_dir : join(this.config.pipe_dir, this.label);
    const pidFile = this.isMain ? this.config.pid_file : join(pipeDir, 'director.pid');
    this.process = this.directorAgent.type === 'claude'
      ? new ClaudeProcess({ pipeDir, pidFile, label: this.label })
      : null;
    this.sessionFile = this.isMain
      ? join(pipeDir, 'director-session')
      : join(pipeDir, 'session');
  }

  /** State key parameterized by label: 'director:main', 'director:abc12345', etc.
   *  保留 'director:' 前缀以兼容已有 SQLite 持久化数据。 */
  private get stateKey(): string {
    return `director:${this.label}`;
  }

  /** Log directory for this Director: logs/{label}/ */
  private get logDir(): string {
    return join(LOG_BASE, this.label);
  }

  private get isCodex(): boolean {
    return this.directorAgent.type === 'codex';
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
  restoreState(): BridgePersistedState | null {
    let saved = getState<BridgePersistedState>(this.stateKey);
    // 向后兼容：主 Director 旧状态键是 'director'
    if (!saved && this.isMain) {
      saved = getState<BridgePersistedState>('director');
    }
    if (!saved) return null;
    if (typeof saved.lastFlushAt === 'number') this.lastFlushAt = saved.lastFlushAt;
    if (typeof saved.lastInputTokens === 'number') this.lastInputTokens = saved.lastInputTokens;
    if (typeof saved.contextWindow === 'number') this.contextWindow = saved.contextWindow;
    return saved;
  }

  private persistState(): void {
    setState<BridgePersistedState>(this.stateKey, {
      lastFlushAt: this.lastFlushAt,
      lastInputTokens: this.lastInputTokens,
      contextWindow: this.contextWindow,
    });
  }

  /** Timeout for FIFO pipe open — if process died between alive check and open */
  private static readonly PIPE_OPEN_TIMEOUT = 30_000; // 30 seconds

  async start(): Promise<boolean> {
    if (this.isCodex) {
      this.ensureSessionDir();
      const restoredSession = this.readSession();
      this.sessionId = restoredSession;
      if (restoredSession) {
        const nameMap = getState<Record<string, string>>('session:names') ?? {};
        this.sessionName = nameMap[restoredSession] ?? null;
        console.log(`[bridge:${this.label}] Codex session ready${this.sessionName ? ` (${this.sessionName})` : ''}`);
        return false;
      }
      console.log(`[bridge:${this.label}] Codex session ready (new)`);
      return true;
    }

    const process = this.process;
    if (!process) {
      throw new Error('Claude process is not initialized');
    }

    process.ensurePipeDir();

    let freshStart = true;
    if (process.isAlive()) {
      console.log(`[bridge:${this.label}] Existing process found (pid: ${process.getPid()}), reconnecting...`);
      freshStart = false;
    } else {
      process.ensurePipes();
      this.spawnProcess();
    }

    // Open both pipe ends concurrently — this unblocks the FIFO handshake
    // Timeout prevents indefinite hang if the process died between alive check and pipe open
    const handles = await process.openPipes(SessionBridge.PIPE_OPEN_TIMEOUT);

    if (!handles) {
      throw new Error(`[bridge:${this.label}] Pipe open timeout after ${SessionBridge.PIPE_OPEN_TIMEOUT / 1000}s — process may have died`);
    }

    this.writeHandle = handles.writeHandle;
    this.sessionId = this.readSession();
    console.log(`[bridge:${this.label}] Pipes connected`);

    this.listenOutput(handles.readHandle);

    return freshStart;
  }

  /** Send SIGINT to cancel current request, then auto-restart with --resume */
  async interrupt(): Promise<void> {
    if (this.isCodex) {
      if (!this.activeChild?.pid) return;
      this.interrupted = true;
      this.killActiveChild('SIGINT');
      await new Promise<void>((resolve) => {
        this.once('restarted', resolve);
      });
      return;
    }

    if (this.flushing) {
      console.log(`[bridge:${this.label}] Interrupt skipped: flush in progress`);
      return;
    }

    const pid = this.process?.getPid();
    if (!pid) return;

    this.interrupted = true;
    console.log(`[bridge:${this.label}] Interrupting (pid: ${pid})...`);

    this.process?.kill('SIGINT');

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

  /** Kill current session and restart with a fresh one (no --conversation-id) */
  async flush(): Promise<boolean> {
    if (this.flushing) {
      console.log(`[bridge:${this.label}] FLUSH already in progress, skipping`);
      return false;
    }

    // Non-main Directors: skip checkpoint, just kill and restart
    if (!this.isMain) {
      this.flushing = true;
      if (this.isCodex) {
        this.killActiveChild('SIGTERM');
      } else {
        this.process?.kill('SIGTERM');
      }
      this.clearSession();
      await this.restart();
      this.finishFlush();
      console.log(`[bridge:${this.label}] FLUSH: complete (non-main, no checkpoint)`);
      return true;
    }

    // 7.x: Warn about running tasks before flush
    const runningTasks = listTasks({ status: 'running' });
    if (runningTasks.length > 0) {
      console.warn(`[bridge:${this.label}] FLUSH: ${runningTasks.length} task(s) still running — new Director may miss results`);
    }

    // Wait for interrupt to complete if in progress
    if (this.interrupted) {
      console.log(`[bridge:${this.label}] FLUSH: waiting for interrupt to complete...`);
      await new Promise<void>((resolve) => {
        this.once('restarted', resolve);
      });
    }

    this.flushing = true;

    // Drain: wait for in-flight messages to complete
    if (this.pendingCount > 0) {
      console.log(`[bridge:${this.label}] FLUSH: draining ${this.pendingCount} in-flight messages...`);
      const drained = await this.waitForDrain(SessionBridge.FLUSH_STEP_TIMEOUT);
      if (!drained) {
        console.warn(`[bridge:${this.label}] FLUSH: drain timeout, aborting flush`);
        this.flushing = false;
        return false;
      }
    }

    // Clear orphaned queue items — after drain, any remaining items will never
    // get a response because the Director session is about to be destroyed.
    this.emit('flush-drain-complete');

    // Step 1 - Checkpoint: ask Director to save state
    console.log(`[bridge:${this.label}] FLUSH: starting checkpoint...`);
    const checkpointDone = new Promise<void>((resolve) => {
      this.flushCheckpointResolve = resolve;
    });
    this.pendingCount++;
    await this.writeRaw(
      '[FLUSH] 系统即将进行上下文刷新。请将当前工作状态保存到 daily/state.md，包括：进行中的任务、待处理的事项、需要保留的上下文。保存完成后回复"已保存"。'
    );

    const checkpointOk = await Promise.race([
      checkpointDone.then(() => true),
      this.timeout(SessionBridge.FLUSH_STEP_TIMEOUT).then(() => false),
    ]);
    if (!checkpointOk) {
      console.warn(`[bridge:${this.label}] FLUSH: checkpoint timeout, skipping checkpoint and forcing reset`);
      this.flushCheckpointResolve = null;
      this.discardNextResponse = true;
      // Fall through to kill+restart — don't abort, otherwise the
      // checkpoint message is still in-flight and its late response
      // would leak to users.
    } else {
      console.log(`[bridge:${this.label}] FLUSH: checkpoint done`);
    }

    // Step 2 - Reset: kill process + clear session + clean pipes
    if (this.isCodex) {
      this.killActiveChild('SIGTERM');
    } else {
      this.process?.kill('SIGTERM');
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
      this.timeout(SessionBridge.FLUSH_STEP_TIMEOUT).then(() => false),
    ]);
    if (!bootstrapOk) {
      console.warn(`[bridge:${this.label}] FLUSH: bootstrap timeout — forcing flush finish`);
      this.flushBootstrapResolve = null;
      this.discardNextResponse = true;
      this.finishFlush();
    } else {
      this.finishFlush();
      console.log(`[bridge:${this.label}] FLUSH: complete`);
    }
    return true;
  }

  /** Clear context without saving — kill + discard session + restart.
   *  Unlike flush(), skips checkpoint and bootstrap entirely. */
  async clearContext(): Promise<boolean> {
    if (this.flushing) {
      console.log(`[bridge:${this.label}] CLEAR skipped: flush in progress`);
      return false;
    }
    this.flushing = true;
    if (this.isCodex) {
      this.killActiveChild('SIGTERM');
    } else {
      this.process?.kill('SIGTERM');
    }
    this.clearSession();
    await this.restart();
    this.finishFlush();
    console.log(`[bridge:${this.label}] CLEAR: context discarded, fresh session started`);
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

  /** 返回当前状态快照，供控制台使用 */
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
      alive: this.isCodex ? true : this.process?.isAlive() ?? false,
      pid: this.isCodex ? (this.activeChild?.pid ?? null) : (this.process?.getPid() ?? null),
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
  async restartProcess(): Promise<void> {
    if (this.isCodex) {
      if (!this.activeChild?.pid) return;
      this.explicitRestart = true;
      this.killActiveChild('SIGTERM');
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
      return;
    }

    this.explicitRestart = true;
    this.process?.kill('SIGTERM');
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
    if ((!this.isCodex && !this.writeHandle) || this.flushing) return;
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
    console.log(`[bridge:${this.label}] Bootstrap message sent`);

    // Wait for bootstrap response with timeout — prevents indefinite hang
    const timedOut = await Promise.race([
      done.then(() => false),
      this.timeout(SessionBridge.BOOTSTRAP_TIMEOUT).then(() => true),
    ]);
    if (timedOut) {
      console.warn(`[bridge:${this.label}] Bootstrap timeout after ${SessionBridge.BOOTSTRAP_TIMEOUT / 1000}s, continuing without bootstrap response`);
      this.bootstrapping = false;
      this.bootstrapResolve = null;
      this.decrementPending();
    }
  }

  async send(message: string): Promise<void> {
    if (!this.isCodex && !this.writeHandle) {
      throw new Error('SessionBridge not started');
    }
    if (this.flushing) {
      throw new Error('SessionBridge is flushing');
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

  /** 发送系统消息（如 cron director_msg），响应会被吸收不转发给用户 */
  async sendSystemMessage(msg: string): Promise<void> {
    if ((!this.isCodex && !this.writeHandle) || this.flushing) return;
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

  /** 发送 cron 消息给 Director，响应会通过 'cron-response' 事件转发给用户 */
  async sendCronMessage(msg: string): Promise<void> {
    if ((!this.isCodex && !this.writeHandle) || this.flushing) return;
    this.pendingTypes.push({ type: 'system-forward' });
    this.pendingCount++;
    try {
      await this.writeRaw(msg);
    } catch {
      this.pendingTypes.pop();
      this.decrementPending();
    }
  }

  private async writeRaw(content: string): Promise<void> {
    if (!this.isCodex && !this.writeHandle) {
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

    if (this.isCodex) {
      this.codexQueue.push(content);
      this.processNextCodexTurn();
      return;
    }

    await this.writeHandle!.write(pipePayload);
  }

  /** Notify the AI that a managed task has completed or failed */
  async notifyTaskDone(taskId: string, success: boolean, replyToMessageId?: string): Promise<void> {
    if ((!this.isCodex && !this.writeHandle) || this.flushing) return;
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
    if (this.isCodex) {
      this.killActiveChild('SIGTERM');
      return;
    }
    await this.writeHandle?.close();
    this.writeHandle = null;
  }

  /** Gracefully shut down: kill the process and wait for pipe close.
   *  Unlike restart(), this does NOT spawn a new process — used for /shell-restart. */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    if (this.isCodex) {
      if (this.activeChild?.pid) {
        this.killActiveChild('SIGTERM');
        return new Promise<void>((resolve) => {
          this.shutdownResolve = resolve;
          setTimeout(() => {
            if (this.shutdownResolve) {
              this.shutdownResolve();
              this.shutdownResolve = null;
            }
          }, 10_000);
        });
      }
      return;
    }

    if (!this.process?.isAlive()) {
      // Already dead, just clean up
      await this.writeHandle?.close();
      this.writeHandle = null;
      return;
    }

    return new Promise<void>((resolve) => {
      this.shutdownResolve = resolve;
      this.process?.kill('SIGTERM');
      // Safety timeout — if pipe close never fires
      setTimeout(() => {
        if (this.shutdownResolve) {
          console.warn(`[bridge:${this.label}] Shutdown timeout, forcing`);
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
      console.error(`[bridge:${this.label}] BUG: pendingCount went negative (${this.pendingCount}), clamping to 0`);
      this.pendingCount = 0;
    }
  }

  private timeout(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private shouldAutoFlushAfterTurn(turnType: 'user' | 'system' | 'bootstrap' | 'discarded'): boolean {
    return turnType === 'user';
  }

  private checkFlush(): void {
    if (this.flushing) return;

    const contextOverLimit = this.lastInputTokens > this.config.flush_context_limit;
    const timeOverLimit = Date.now() - this.lastFlushAt > this.config.flush_interval_ms;

    if (contextOverLimit || timeOverLimit) {
      const reason = contextOverLimit
        ? `context tokens ${this.lastInputTokens} > ${this.config.flush_context_limit}`
        : `time since last flush exceeded ${this.config.flush_interval_ms}ms`;
      console.log(`[bridge:${this.label}] Auto-flush triggered: ${reason}`);
      // Fire and forget — flush is async but we don't block the event loop
      this.flush().then((success) => {
        if (success) {
          this.emit('auto-flush-complete');
        } else {
          // 4.1: Notify about auto-flush failure
          this.emit('alert', `⚠️ 自动 FLUSH 未能完成（reason: ${reason}）`);
        }
      }).catch((err) => {
        console.error(`[bridge:${this.label}] Auto-flush failed:`, err);
        this.emit('alert', `⚠️ 自动 FLUSH 异常: ${String(err).slice(0, 200)}`);
      });
    }
  }

  private async restart(): Promise<void> {
    if (this.isCodex) {
      return;
    }

    // 3.2: Exponential backoff — abort if ≥3 restarts within 5 minutes
    const now = Date.now();
    const BACKOFF_WINDOW = 5 * 60_000; // 5 minutes
    const MAX_RESTARTS = 3;
    this.restartTimestamps.push(now);
    this.restartTimestamps = this.restartTimestamps.filter((t) => now - t < BACKOFF_WINDOW);
    if (this.restartTimestamps.length >= MAX_RESTARTS) {
      if (this.isMain) {
        console.error(`[bridge:${this.label}] ${this.restartTimestamps.length} restarts in ${BACKOFF_WINDOW / 1000}s — exiting to let launchd handle recovery`);
        process.exit(1);
      } else {
        console.error(`[bridge:${this.label}] ${this.restartTimestamps.length} restarts in ${BACKOFF_WINDOW / 1000}s — giving up, emitting close`);
        this.emit('stream-abort');
        this.emit('close');
        return;
      }
    }

    await this.writeHandle?.close();
    this.writeHandle = null;

    // Wait for old process to die before cleaning pipes — SIGTERM is async,
    // if we clean pipes while the process is still alive, start() will see
    // isAlive()=true and try to reconnect to non-existent pipes → hang.
    if (this.process?.isAlive()) {
      const maxWait = 5_000;
      const start = Date.now();
      while (this.process.isAlive() && Date.now() - start < maxWait) {
        await new Promise((r) => setTimeout(r, 100));
      }
      if (this.process.isAlive()) {
        console.warn(`[bridge:${this.label}] Process still alive after ${maxWait}ms, sending SIGKILL`);
        this.process.kill('SIGKILL');
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    this.process?.cleanPipes();

    await this.start();
  }

  private spawnProcess(): void {
    if (!this.process) {
      throw new Error('Claude process is not initialized');
    }
    const personaDir = this.config.persona_dir;

    const savedSession = this.readSession();
    if (savedSession) {
      console.log(`[bridge:${this.label}] Resuming session: ${savedSession}`);
    } else {
      console.log(`[bridge:${this.label}] Starting new session`);
    }

    // 生成语义化 session 名称：director-{label}-{日期T时分}[-{群名}]
    const now = new Date();
    const dateStr = now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace(/-/g, '');
    const timeStr = now.toLocaleTimeString('sv-SE', { timeZone: 'Asia/Shanghai', hour12: false, hour: '2-digit', minute: '2-digit' }).replace(':', '');
    const nameParts = ['director', this.label, `${dateStr}T${timeStr}`];
    if (this.groupName) nameParts.push(this.groupName);
    const sessionName = nameParts.join('-');
    this.sessionName = sessionName;

    const pid = this.process.spawn({
      role: 'director',
      personaDir,
      agents: this.agents,
      mcpConfigPath: join(personaDir, '.mcp.json'),
      sessionId: savedSession ?? undefined,
      sessionName,
      stderrPath: join(this.process.pipeDir, 'director-stderr.log'),
      env: { DIRECTOR_LABEL: this.label },
    });

    if (pid) {
      console.log(`[bridge:${this.label}] Spawned claude process (pid: ${pid})`);
    }

    // Persist sessionId → sessionName mapping so historical sessions can be named
    // (Claude CLI doesn't include session_name in log events)
    if (savedSession || this.sessionId) {
      const sid = savedSession || this.sessionId!;
      const nameMap = getState<Record<string, string>>('session:names') ?? {};
      nameMap[sid] = sessionName;
      setState('session:names', nameMap);
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
      // Skip stream_event (partial message deltas) to avoid log bloat —
      // assistant events already contain the complete content
      try {
        const logDir = this.logDir;
        if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
        const parsed = JSON.parse(line);
        if (parsed.type !== 'stream_event') {
          parsed._ts = new Date().toISOString();
          parsed._director = this.label;
          appendFileSync(this.outputLogPath, JSON.stringify(parsed) + '\n');
        }
      } catch {
        // JSON parse failed — write raw line as fallback
        try { appendFileSync(this.outputLogPath, line + '\n'); } catch { /* best-effort */ }
      }

      try {
        const event = JSON.parse(line);

        switch (event.type) {
          case 'system':
            log.debug(`[bridge:${this.label}] System event: ${event.subtype}`);
            // Capture session_id from init event
            if (event.subtype === 'init' && event.session_id) {
              this.sessionId = event.session_id;
              this.saveSession(event.session_id);
              log.debug(`[bridge:${this.label}] Session ID: ${event.session_id}`);
            }
            break;

          case 'assistant':
            if (event.message?.content) {
              const content = event.message.content;
              // Accumulate response text (chunk emission is handled by stream_event deltas)
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

          case 'stream_event': {
            // Token-level streaming from --include-partial-messages
            const streamEvt = event.event;
            if (streamEvt?.type === 'content_block_delta'
              && streamEvt.delta?.type === 'text_delta') {
              const text = streamEvt.delta.text;
              if (text) {
                const headType = this.pendingTypes[0]?.type;
                const shouldStream = !this.flushing && !this.bootstrapping
                  && headType === 'user' && !this.discardNextResponse;
                if (shouldStream) this.emit('chunk', text);
              }
            }
            break;
          }

          case 'result':
            // Handle stale session error — clear session and let close handler restart
            if (event.is_error && event.errors?.some((e: string) => e.includes('No conversation found'))) {
              console.warn(`[bridge:${this.label}] Session expired, clearing session for fresh start`);
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

            let resolvedTurnType: 'user' | 'system' | 'bootstrap' | 'discarded' | null = null;
            if (currentResponse) {
              if (this.flushing && this.flushCheckpointResolve) {
                // Flush checkpoint response — don't emit to users
                log.debug(`[bridge:${this.label}] FLUSH checkpoint response: ${currentResponse.trim().slice(0, 100)}`);
                this.flushCheckpointResolve();
                this.flushCheckpointResolve = null;
                resolvedTurnType = 'system';
              } else if (this.flushing && this.flushBootstrapResolve) {
                // Flush bootstrap response — don't emit to users
                log.debug(`[bridge:${this.label}] FLUSH bootstrap response: ${currentResponse.trim().slice(0, 100)}`);
                this.flushBootstrapResolve();
                this.flushBootstrapResolve = null;
                resolvedTurnType = 'bootstrap';
              } else if (this.discardNextResponse) {
                // Late response after flush timeout — discard silently
                log.debug(`[bridge:${this.label}] Discarding late post-flush response: ${currentResponse.trim().slice(0, 100)}`);
                this.discardNextResponse = false;
                resolvedTurnType = 'discarded';
              } else if (this.bootstrapping) {
                // Startup bootstrap response — absorb, don't emit to users
                log.debug(`[bridge:${this.label}] Bootstrap response: ${currentResponse.trim().slice(0, 100)}`);
                this.bootstrapping = false;
                if (this.bootstrapResolve) {
                  this.bootstrapResolve();
                  this.bootstrapResolve = null;
                }
                resolvedTurnType = 'bootstrap';
              } else {
                // Ordered dispatch: shift from pendingTypes to determine response type
                const pending = this.pendingTypes.shift();
                if (!pending || pending.type === 'user') {
                  this.messagesProcessedToday++;
                  this.emit('response', currentResponse.trim(), event.duration_ms);
                  resolvedTurnType = 'user';
                } else if (pending.type === 'system-reply') {
                  this.systemReplyQueue.shift();
                  log.debug(`[bridge:${this.label}] Task notification response (replyTo=${pending.replyToMessageId}): ${currentResponse.trim().slice(0, 100)}`);
                  this.emit('system-response', currentResponse.trim(), pending.replyToMessageId);
                  resolvedTurnType = 'system';
                } else if (pending.type === 'system-forward') {
                  // cron-response — Director 响应转发给用户
                  log.debug(`[bridge:${this.label}] Cron response forwarded: ${currentResponse.trim().slice(0, 100)}`);
                  this.emit('cron-response', currentResponse.trim());
                  resolvedTurnType = 'system';
                } else {
                  // system-absorbed — task notification without messageId
                  this.systemMessagePending--;
                  log.debug(`[bridge:${this.label}] System message response absorbed: ${currentResponse.trim().slice(0, 100)}`);
                  resolvedTurnType = 'system';
                }
              }
              currentResponse = '';
            }

            // Check if drain is complete
            if (this.pendingCount <= 0 && this.drainResolve) {
              this.drainResolve();
              this.drainResolve = null;
            }

            // Check if auto-flush is needed after a user-visible turn.
            if (!this.flushing && resolvedTurnType && this.shouldAutoFlushAfterTurn(resolvedTurnType)) {
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
        console.log(`[bridge:${this.label}] Ignoring stale close event (gen=${gen}, current=${this.generation})`);
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
        console.log(`[bridge:${this.label}] Shutdown complete`);
        await this.writeHandle?.close();
        this.writeHandle = null;
        if (this.shutdownResolve) {
          this.shutdownResolve();
          this.shutdownResolve = null;
        }
      } else if (this.explicitRestart) {
        this.explicitRestart = false;
        console.log(`[bridge:${this.label}] Explicit restart, restarting with --resume...`);
        await this.restart();
        this.emit('restarted');
      } else if (this.interrupted) {
        this.interrupted = false;
        console.log(`[bridge:${this.label}] Interrupted, restarting with --resume...`);
        await this.restart();
        this.emit('restarted');
      } else if (this.flushing) {
        // Flush handles its own restart — do nothing here
        console.log(`[bridge:${this.label}] Pipe closed during flush (expected)`);
      } else if (!this.isMain) {
        // Non-main bridge: emit 'close' for pool cleanup, don't exit
        console.log(`[bridge:${this.label}] Non-main bridge closed unexpectedly`);
        this.emit('stream-abort');
        this.emit('close');
      } else {
        // 4.1: Alert before unexpected restart — this is a genuine crash
        // Session may be corrupted, clear it and bootstrap fresh
        this.emit('stream-abort');
        this.emit('alert', `🔴 Director 进程意外退出，正在重启...`);
        console.log(`[bridge:${this.label}] Output pipe closed, clearing session and restarting...`);
        this.clearSession();
        await this.restart();
        await this.bootstrap();
      }
    });
  }

  private saveSession(sessionId: string): void {
    this.ensureSessionDir();
    writeFileSync(this.sessionFile, sessionId);
  }

  private ensureSessionDir(): void {
    const dir = dirname(this.sessionFile);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  private readSession(): string | null {
    try {
      return readFileSync(this.sessionFile, 'utf-8').trim() || null;
    } catch {
      return null;
    }
  }

  private clearSession(): void {
    this.sessionId = null;
    this.sessionName = null;
    try { unlinkSync(this.sessionFile); } catch { /* ok */ }
  }

  private buildSessionName(): string {
    const now = new Date();
    const dateStr = now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace(/-/g, '');
    const timeStr = now.toLocaleTimeString('sv-SE', { timeZone: 'Asia/Shanghai', hour12: false, hour: '2-digit', minute: '2-digit' }).replace(':', '');
    const prefix = this.isCodex ? 'codex-director' : 'director';
    const nameParts = [prefix, this.label, `${dateStr}T${timeStr}`];
    if (this.groupName) nameParts.push(this.groupName);
    return nameParts.join('-');
  }

  private rememberSessionName(sessionId: string, sessionName: string): void {
    const nameMap = getState<Record<string, string>>('session:names') ?? {};
    nameMap[sessionId] = sessionName;
    setState('session:names', nameMap);
  }

  private logOutputEvent(line: string): void {
    try {
      const logDir = this.logDir;
      if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
      const parsed = JSON.parse(line);
      if (parsed.type !== 'stream_event') {
        parsed._ts = new Date().toISOString();
        parsed._director = this.label;
        appendFileSync(this.outputLogPath, JSON.stringify(parsed) + '\n');
      }
    } catch {
      try { appendFileSync(this.outputLogPath, line + '\n'); } catch { /* best-effort */ }
    }
  }

  private killActiveChild(signal: NodeJS.Signals): void {
    const pid = this.activeChild?.pid;
    if (!pid) return;
    try {
      process.kill(-pid, signal);
    } catch {
      // already exited
    }
  }

  private processNextCodexTurn(): void {
    if (!this.isCodex || this.codexRunning) return;
    const content = this.codexQueue.shift();
    if (!content) return;

    const startedAt = Date.now();
    this.codexRunning = true;
    const currentSessionName = this.sessionName ?? this.buildSessionName();
    if (!this.sessionName) this.sessionName = currentSessionName;

    const { child } = spawnPersona({
      role: 'director',
      personaDir: this.config.persona_dir,
      agent: this.directorAgent,
      mode: 'background',
      prompt: content,
      resumeSessionId: this.sessionId ?? undefined,
      stderrPath: join(this.logDir, 'director-stderr.log'),
      env: { DIRECTOR_LABEL: this.label },
    });

    this.activeChild = child;
    child.on('error', () => {});

    if (!child.stdout || !child.pid) {
      this.activeChild = null;
      this.codexRunning = false;
      this.handleCodexTurnFailure('failed to spawn codex process');
      this.processNextCodexTurn();
      return;
    }

    let currentResponse = '';
    let sawTurnCompleted = false;

    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      this.logOutputEvent(line);

      try {
        const event = JSON.parse(line);
        if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
          this.sessionId = event.thread_id;
          this.saveSession(event.thread_id);
          this.rememberSessionName(event.thread_id, currentSessionName);
        } else if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
          currentResponse += event.item.text;
        } else if (event.type === 'turn.completed') {
          sawTurnCompleted = true;
          const usage = event.usage;
          if (usage && typeof usage === 'object') {
            // Codex's input_tokens already reflects prompt/context size.
            // cached_input_tokens is a billing/cache detail, not extra context to add again.
            const contextInput = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
            if (contextInput > 0) {
              this.lastInputTokens = contextInput;
              this.persistState();
            }
          }
        }
      } catch {
        // ignore malformed line
      }
    });

    child.on('close', (code) => {
      this.activeChild = null;
      this.codexRunning = false;
      this.currentMessagePreview = null;
      this.currentMessageStartedAt = null;
      let resolvedTurnType: 'user' | 'system' | 'bootstrap' | 'discarded' | null = null;

      if (currentResponse.trim()) {
        this.decrementPending();
        const pending = this.pendingTypes.shift();
        if (this.flushing && this.flushCheckpointResolve) {
          this.flushCheckpointResolve();
          this.flushCheckpointResolve = null;
          resolvedTurnType = 'system';
        } else if (this.flushing && this.flushBootstrapResolve) {
          this.flushBootstrapResolve();
          this.flushBootstrapResolve = null;
          resolvedTurnType = 'bootstrap';
        } else if (this.discardNextResponse) {
          this.discardNextResponse = false;
          resolvedTurnType = 'discarded';
        } else if (this.bootstrapping) {
          this.bootstrapping = false;
          if (this.bootstrapResolve) {
            this.bootstrapResolve();
            this.bootstrapResolve = null;
          }
          resolvedTurnType = 'bootstrap';
        } else if (!pending || pending.type === 'user') {
          this.messagesProcessedToday++;
          this.emit('response', currentResponse.trim(), Date.now() - startedAt);
          resolvedTurnType = 'user';
        } else if (pending.type === 'system-reply') {
          this.systemReplyQueue.shift();
          this.emit('system-response', currentResponse.trim(), pending.replyToMessageId);
          resolvedTurnType = 'system';
        } else if (pending.type === 'system-forward') {
          this.emit('cron-response', currentResponse.trim());
          resolvedTurnType = 'system';
        } else {
          this.systemMessagePending = Math.max(0, this.systemMessagePending - 1);
          resolvedTurnType = 'system';
        }
      } else if (this.shuttingDown || this.explicitRestart || this.interrupted) {
        this.decrementPending();
        const pending = this.pendingTypes.shift();
        if (pending?.type === 'system-reply') this.systemReplyQueue.shift();
        if (pending?.type === 'system-absorbed') this.systemMessagePending = Math.max(0, this.systemMessagePending - 1);
        resolvedTurnType = 'system';
      } else if (code !== 0 || !sawTurnCompleted) {
        this.handleCodexTurnFailure(`codex exited with code ${code ?? 'null'}`);
      } else {
        this.decrementPending();
        const pending = this.pendingTypes.shift();
        if (pending?.type === 'system-reply') this.systemReplyQueue.shift();
        if (pending?.type === 'system-absorbed') this.systemMessagePending = Math.max(0, this.systemMessagePending - 1);
        resolvedTurnType = pending?.type === 'user' || !pending ? 'user' : 'system';
      }

      if (this.pendingCount <= 0 && this.drainResolve) {
        this.drainResolve();
        this.drainResolve = null;
      }

      if (this.shuttingDown) {
        this.shuttingDown = false;
        if (this.shutdownResolve) {
          this.shutdownResolve();
          this.shutdownResolve = null;
        }
      } else if (this.explicitRestart) {
        this.explicitRestart = false;
        this.emit('restarted');
      } else if (this.interrupted) {
        this.interrupted = false;
        this.emit('restarted');
      }

      if (!this.flushing && resolvedTurnType && this.shouldAutoFlushAfterTurn(resolvedTurnType)) {
        this.checkFlush();
      }
      this.processNextCodexTurn();
    });
  }

  private handleCodexTurnFailure(message: string): void {
    this.decrementPending();

    if (this.flushing && this.flushCheckpointResolve) {
      this.flushCheckpointResolve();
      this.flushCheckpointResolve = null;
    } else if (this.flushing && this.flushBootstrapResolve) {
      this.flushBootstrapResolve();
      this.flushBootstrapResolve = null;
    } else if (this.bootstrapping) {
      this.bootstrapping = false;
      if (this.bootstrapResolve) {
        this.bootstrapResolve();
        this.bootstrapResolve = null;
      }
    } else {
      const pending = this.pendingTypes.shift();
      if (!pending || pending.type === 'user') {
        this.messagesProcessedToday++;
        this.emit('response', '处理失败，请稍后重试');
      } else if (pending.type === 'system-reply') {
        this.systemReplyQueue.shift();
      } else if (pending.type === 'system-absorbed') {
        this.systemMessagePending = Math.max(0, this.systemMessagePending - 1);
      }
      this.emit('alert', `⚠️ Codex Director 调用失败: ${message}`);
    }
  }
}
