import { EventEmitter } from 'events';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, appendFileSync } from 'fs';
import { dirname, join } from 'path';
import { resolveAgentProvider, type Config } from './config.js';
import type { AgentRuntimeConfig } from './persona-process.js';
import { ClaudeDirectorRuntime } from './director-runtime/claude.js';
import { CodexSessionAdapter } from './director-session-adapter/codex.js';
import { ClaudeSessionAdapter } from './director-session-adapter/claude.js';
import type {
  DirectorSessionAdapter,
  DirectorSessionAdapterHooks,
  DirectorSessionAdapterOptions,
  DirectorSessionMetricsUpdate,
  DirectorTurnResult,
  RestoredSessionState,
} from './director-session-adapter/index.js';
import { getState, setState, listTasks } from './task/task-store.js';
import { log } from './logger.js';

const LOG_BASE = join(import.meta.dirname, '..', 'logs');

interface BridgePersistedState {
  lastFlushAt: number;
  lastInputTokens: number;
  contextWindow: number;
}

type PendingType =
  | { type: 'user' }
  | { type: 'system-absorbed' }
  | { type: 'system-reply'; replyToMessageId: string }
  | { type: 'system-forward' }
  | { type: 'bootstrap' }
  | { type: 'flush-checkpoint' }
  | { type: 'flush-bootstrap' };

export interface SessionBridgeOptions {
  agents: Config['agents'];
  config: Config['director'];
  directorAgentName?: string;
  label: string;
  isMain?: boolean;
  groupName?: string;
  directorFactory?: (options: DirectorSessionAdapterOptions, hooks: DirectorSessionAdapterHooks) => DirectorSessionAdapter;
}

export class SessionBridge extends EventEmitter {
  private config: Config['director'];
  private agents: Config['agents'];
  readonly label: string;
  readonly isMain: boolean;
  private groupName?: string;
  private directorAgent: AgentRuntimeConfig;
  private adapter: DirectorSessionAdapter;
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
  private systemReplyQueue: string[] = [];
  private pendingTurns: PendingType[] = [];
  private bootstrapping = false;
  private bootstrapResolve: (() => void) | null = null;
  private flushCheckpointResolve: (() => void) | null = null;
  private flushBootstrapResolve: (() => void) | null = null;
  private drainResolve: (() => void) | null = null;
  private currentMessagePreview: string | null = null;
  private currentMessageStartedAt: number | null = null;
  private messagesProcessedToday = 0;
  private currentCountDate: string = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  private totalCostUsd = 0;
  private contextWindow = 0;
  private restartTimestamps: number[] = [];
  private discardNextResponse = false;

  private static readonly PIPE_OPEN_TIMEOUT = 30_000;
  private static readonly FLUSH_STEP_TIMEOUT = 5 * 60_000;
  private static readonly BOOTSTRAP_TIMEOUT = 3 * 60_000;

  constructor(options: SessionBridgeOptions) {
    super();
    this.config = options.config;
    this.agents = options.agents;
    this.label = options.label;
    this.isMain = options.isMain ?? true;
    this.groupName = options.groupName;
    this.directorAgent = resolveAgentProvider(this.agents, 'director', options.directorAgentName);

    const pipeDir = this.isMain ? this.config.pipe_dir : join(this.config.pipe_dir, this.label);
    const pidFile = this.isMain ? this.config.pid_file : join(pipeDir, 'director.pid');
    this.sessionFile = this.isMain ? join(pipeDir, 'director-session') : join(pipeDir, 'session');

    const adapterOptions: DirectorSessionAdapterOptions = {
      label: this.label,
      isMain: this.isMain,
      groupName: this.groupName,
      config: this.config,
      agents: this.agents,
      directorAgent: this.directorAgent,
      logDir: this.logDir,
    };

    const hooks = this.buildAdapterHooks();
    this.adapter = options.directorFactory
      ? options.directorFactory(adapterOptions, hooks)
      : this.directorAgent.type === 'claude'
        ? new ClaudeSessionAdapter(new ClaudeDirectorRuntime({ pipeDir, pidFile, label: this.label }), adapterOptions, hooks)
        : new CodexSessionAdapter(adapterOptions, hooks);
  }

  private get stateKey(): string {
    return `director:${this.label}`;
  }

  private get logDir(): string {
    return join(LOG_BASE, this.label);
  }

  private get logDate(): string {
    return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace(/-/g, '');
  }

  private get pendingCount(): number {
    return this.pendingTurns.length;
  }

  get inputLogPath(): string {
    return join(this.logDir, `input-${this.logDate}.log`);
  }

  get outputLogPath(): string {
    return join(this.logDir, `output-${this.logDate}.log`);
  }

  restoreState(): BridgePersistedState | null {
    let saved = getState<BridgePersistedState>(this.stateKey);
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

  async start(): Promise<boolean> {
    const freshStart = await this.adapter.start();
    console.log(this.adapter.describeSessionReady(this.label, this.sessionId, this.sessionName));
    return freshStart;
  }

  async interrupt(): Promise<void> {
    if (this.flushing && this.adapter.shouldSkipInterruptWhileFlushing()) {
      console.log(`[bridge:${this.label}] Interrupt skipped: flush in progress`);
      return;
    }
    if (!this.adapter.hasActiveTurn()) return;

    this.interrupted = true;
    const interruptTarget = this.adapter.describeInterruptTarget();
    if (interruptTarget) {
      console.log(`[bridge:${this.label}] Interrupting ${interruptTarget}...`);
    }
    this.adapter.interrupt();

    await new Promise<void>((resolve) => {
      this.once('restarted', resolve);
    });
  }

  async flush(): Promise<boolean> {
    if (this.flushing) {
      console.log(`[bridge:${this.label}] FLUSH already in progress, skipping`);
      return false;
    }

    if (!this.isMain) {
      this.flushing = true;
      this.adapter.terminate('SIGTERM');
      this.clearSession();
      await this.restart();
      this.finishFlush();
      console.log(`[bridge:${this.label}] FLUSH: complete (non-main, no checkpoint)`);
      return true;
    }

    const runningTasks = listTasks({ status: 'running' });
    if (runningTasks.length > 0) {
      console.warn(`[bridge:${this.label}] FLUSH: ${runningTasks.length} task(s) still running — new Director may miss results`);
    }

    if (this.interrupted) {
      console.log(`[bridge:${this.label}] FLUSH: waiting for interrupt to complete...`);
      await new Promise<void>((resolve) => {
        this.once('restarted', resolve);
      });
    }

    this.flushing = true;

    if (this.pendingCount > 0) {
      console.log(`[bridge:${this.label}] FLUSH: draining ${this.pendingCount} in-flight messages...`);
      const drained = await this.waitForDrain(SessionBridge.FLUSH_STEP_TIMEOUT);
      if (!drained) {
        console.warn(`[bridge:${this.label}] FLUSH: drain timeout, aborting flush`);
        this.flushing = false;
        return false;
      }
    }

    this.emit('flush-drain-complete');

    console.log(`[bridge:${this.label}] FLUSH: starting checkpoint...`);
    const checkpointDone = new Promise<void>((resolve) => {
      this.flushCheckpointResolve = resolve;
    });
    this.enqueuePendingTurn({ type: 'flush-checkpoint' });
    await this.writeRaw('[FLUSH] 系统即将进行上下文刷新。请将当前工作状态保存到 daily/state.md，包括：进行中的任务、待处理的事项、需要保留的上下文。保存完成后回复"已保存"。');

    const checkpointOk = await Promise.race([
      checkpointDone.then(() => true),
      this.timeout(SessionBridge.FLUSH_STEP_TIMEOUT).then(() => false),
    ]);
    if (!checkpointOk) {
      console.warn(`[bridge:${this.label}] FLUSH: checkpoint timeout, skipping checkpoint and forcing reset`);
      this.flushCheckpointResolve = null;
      this.discardNextResponse = true;
    } else {
      console.log(`[bridge:${this.label}] FLUSH: checkpoint done`);
    }

    this.adapter.terminate('SIGTERM');
    this.clearSession();
    await this.restart();

    const bootstrapDone = new Promise<void>((resolve) => {
      this.flushBootstrapResolve = resolve;
    });
    this.enqueuePendingTurn({ type: 'flush-bootstrap' });
    await this.writeRaw('[FLUSH] 你刚经历了上下文刷新。请读取 daily/state.md 恢复工作上下文。');

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

  async clearContext(): Promise<boolean> {
    if (this.flushing) {
      console.log(`[bridge:${this.label}] CLEAR skipped: flush in progress`);
      return false;
    }
    this.flushing = true;
    this.adapter.terminate('SIGTERM');
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
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
    if (today !== this.currentCountDate) {
      this.messagesProcessedToday = 0;
      this.totalCostUsd = 0;
      this.currentCountDate = today;
    }

    const transportStatus = this.adapter.getStatus();
    const activityState = this.flushing
      ? 'flushing'
      : this.interrupted
        ? 'restarting'
        : this.pendingCount > 0
          ? 'processing'
          : 'idle';

    return {
      alive: transportStatus.alive,
      pid: transportStatus.pid,
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

  async restartProcess(): Promise<void> {
    if (!this.adapter.hasActiveTurn()) return;

    this.explicitRestart = true;
    this.adapter.terminate('SIGTERM');
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

  async bootstrap(): Promise<void> {
    if (!this.adapter.isReady() || this.flushing) return;

    this.bootstrapping = true;
    const pendingTurn = this.enqueuePendingTurn({ type: 'bootstrap' });

    const msg = this.isMain
      ? '[系统] 新 session 已启动。请读取 daily/state.md 恢复工作上下文，了解当前待处理事项。'
      : `[系统] 新 session 已启动。你正在为群「${this.groupName ?? this.label}」服务。请读取 daily/state.md 了解全局状态（只读）。`;

    const done = new Promise<void>((resolve) => {
      this.bootstrapResolve = resolve;
    });

    await this.writeRaw(msg);
    console.log(`[bridge:${this.label}] Bootstrap message sent`);

    const timedOut = await Promise.race([
      done.then(() => false),
      this.timeout(SessionBridge.BOOTSTRAP_TIMEOUT).then(() => true),
    ]);
    if (timedOut) {
      console.warn(`[bridge:${this.label}] Bootstrap timeout after ${SessionBridge.BOOTSTRAP_TIMEOUT / 1000}s, continuing without bootstrap response`);
      this.bootstrapping = false;
      this.bootstrapResolve = null;
      this.removePendingTurn(pendingTurn);
      this.resolveDrainIfNeeded();
    }
  }

  async send(message: string): Promise<void> {
    if (!this.adapter.isReady()) {
      throw new Error('SessionBridge not started');
    }
    if (this.flushing) {
      throw new Error('SessionBridge is flushing');
    }

    this.currentMessagePreview = message.slice(0, 50);
    this.currentMessageStartedAt = Date.now();

    let content = message;
    const now = Date.now();
    if (now - this.lastTimeSyncAt > this.config.time_sync_interval_ms) {
      const timeStr = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
      content = `[${timeStr}] ${message}`;
      this.lastTimeSyncAt = now;
    }

    this.enqueuePendingTurn({ type: 'user' });
    await this.writeRaw(content);
  }

  async sendSystemMessage(msg: string): Promise<void> {
    if (!this.adapter.isReady() || this.flushing) return;
    const pendingTurn = this.enqueuePendingTurn({ type: 'system-absorbed' });
    try {
      await this.writeRaw(msg);
    } catch {
      this.removePendingTurn(pendingTurn);
      this.resolveDrainIfNeeded();
    }
  }

  async sendCronMessage(msg: string): Promise<void> {
    if (!this.adapter.isReady() || this.flushing) return;
    const pendingTurn = this.enqueuePendingTurn({ type: 'system-forward' });
    try {
      await this.writeRaw(msg);
    } catch {
      this.removePendingTurn(pendingTurn);
      this.resolveDrainIfNeeded();
    }
  }

  private async writeRaw(content: string): Promise<void> {
    if (!this.adapter.isReady()) {
      throw new Error('transport not ready');
    }

    try {
      if (!existsSync(this.logDir)) mkdirSync(this.logDir, { recursive: true });
      const logPayload = JSON.stringify({
        type: 'user',
        message: { role: 'user', content },
        timestamp: new Date().toISOString(),
        director: this.label,
      }) + '\n';
      appendFileSync(this.inputLogPath, logPayload);
    } catch {
      // best-effort logging
    }

    await this.adapter.send(content);
  }

  async notifyTaskDone(taskId: string, success: boolean, replyToMessageId?: string): Promise<void> {
    if (!this.adapter.isReady() || this.flushing) return;
    let pendingTurn: PendingType;
    if (replyToMessageId) {
      pendingTurn = this.enqueuePendingTurn({ type: 'system-reply', replyToMessageId });
      this.systemReplyQueue.push(replyToMessageId);
    } else {
      pendingTurn = this.enqueuePendingTurn({ type: 'system-absorbed' });
    }

    const tag = success ? 'TASK_DONE' : 'TASK_FAILED';
    const msg = success
      ? `[${tag}] 后台任务 ${taskId} 已完成。调用 get_task MCP 工具查看详情。`
      : `[${tag}] 后台任务 ${taskId} 失败。调用 get_task MCP 工具查看错误信息。`;

    try {
      await this.writeRaw(msg);
    } catch {
      this.removePendingTurn(pendingTurn);
      if (replyToMessageId) this.systemReplyQueue.pop();
      this.resolveDrainIfNeeded();
    }
  }

  async stop(): Promise<void> {
    await this.adapter.stop();
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    const shouldWait = await this.adapter.prepareShutdown();
    if (!shouldWait) {
      return;
    }

    return new Promise<void>((resolve) => {
      this.shutdownResolve = resolve;
      this.adapter.terminate('SIGTERM');
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

  private enqueuePendingTurn(turn: PendingType): PendingType {
    this.pendingTurns.push(turn);
    return turn;
  }

  private shiftPendingTurn(): PendingType | undefined {
    return this.pendingTurns.shift();
  }

  private removePendingTurn(turn: PendingType): void {
    const idx = this.pendingTurns.indexOf(turn);
    if (idx >= 0) this.pendingTurns.splice(idx, 1);
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
      this.flush().then((success) => {
        if (success) {
          this.emit('auto-flush-complete');
        } else {
          this.emit('alert', `⚠️ 自动 FLUSH 未能完成（reason: ${reason}）`);
        }
      }).catch((err) => {
        console.error(`[bridge:${this.label}] Auto-flush failed:`, err);
        this.emit('alert', `⚠️ 自动 FLUSH 异常: ${String(err).slice(0, 200)}`);
      });
    }
  }

  private async restart(): Promise<void> {
    if (!this.adapter.shouldTrackRestartBackoff()) {
      await this.adapter.restartTransport();
      return;
    }

    const now = Date.now();
    const backoffWindow = 5 * 60_000;
    const maxRestarts = 3;
    this.restartTimestamps.push(now);
    this.restartTimestamps = this.restartTimestamps.filter((t) => now - t < backoffWindow);
    if (this.restartTimestamps.length >= maxRestarts) {
      if (this.isMain) {
        console.error(`[bridge:${this.label}] ${this.restartTimestamps.length} restarts in ${backoffWindow / 1000}s — exiting to let launchd handle recovery`);
        process.exit(1);
      }
      console.error(`[bridge:${this.label}] ${this.restartTimestamps.length} restarts in ${backoffWindow / 1000}s — giving up, emitting close`);
      this.emit('stream-abort');
      this.emit('close');
      return;
    }

    await this.adapter.restartTransport();
  }

  private buildAdapterHooks(): DirectorSessionAdapterHooks {
    return {
      restorePersistedSession: () => this.restorePersistedSession(),
      persistSession: (sessionId, sessionName) => this.persistSession(sessionId, sessionName),
      clearSession: () => this.clearSession(),
      getSessionId: () => this.sessionId,
      getSessionName: () => this.sessionName,
      setSessionName: (sessionName) => { this.sessionName = sessionName; },
      buildSessionName: () => this.buildSessionName(),
      logOutput: (line) => this.logOutputEvent(line),
      onChunk: (text) => this.handleStreamChunk(text),
      onMetrics: (update) => this.handleMetricsUpdate(update),
      onTurnComplete: (result) => this.handleTurnComplete(result),
      onTurnFailure: (message) => this.handleTurnFailure(message),
      onRuntimeClosed: () => this.handleRuntimeClosed(),
    };
  }

  private restorePersistedSession(): RestoredSessionState {
    this.ensureSessionDir();
    const sessionId = this.readSession();
    const sessionName = sessionId
      ? (getState<Record<string, string>>('session:names') ?? {})[sessionId] ?? null
      : null;
    this.sessionId = sessionId;
    this.sessionName = sessionName;
    return { sessionId, sessionName };
  }

  private persistSession(sessionId: string, sessionName: string | null): void {
    this.sessionId = sessionId;
    if (sessionName !== null) this.sessionName = sessionName;
    this.saveSession(sessionId);
    if (sessionName) this.rememberSessionName(sessionId, sessionName);
  }

  private handleStreamChunk(text: string): void {
    const headType = this.pendingTurns[0]?.type;
    const shouldStream = !this.flushing && !this.bootstrapping && headType === 'user' && !this.discardNextResponse;
    if (shouldStream) this.emit('chunk', text);
  }

  private handleMetricsUpdate(update: DirectorSessionMetricsUpdate): void {
    let shouldPersist = false;
    if (typeof update.lastInputTokens === 'number' && update.lastInputTokens > 0) {
      this.lastInputTokens = update.lastInputTokens;
      shouldPersist = true;
    }
    if (typeof update.contextWindow === 'number' && update.contextWindow > 0) {
      this.contextWindow = update.contextWindow;
      shouldPersist = true;
    }
    if (typeof update.costUsd === 'number') {
      this.totalCostUsd += update.costUsd;
    }
    if (shouldPersist) this.persistState();
  }

  private handleTurnComplete(result: DirectorTurnResult): void {
    this.currentMessagePreview = null;
    this.currentMessageStartedAt = null;
    const pending = this.shiftPendingTurn();

    let resolvedTurnType: 'user' | 'system' | 'bootstrap' | 'discarded' | null = null;
    const responseText = result.responseText.trim();

    if (pending?.type === 'flush-checkpoint') {
      log.debug(`[bridge:${this.label}] FLUSH checkpoint response: ${responseText.slice(0, 100)}`);
      this.flushCheckpointResolve?.();
      this.flushCheckpointResolve = null;
      resolvedTurnType = 'system';
    } else if (pending?.type === 'flush-bootstrap') {
      log.debug(`[bridge:${this.label}] FLUSH bootstrap response: ${responseText.slice(0, 100)}`);
      this.flushBootstrapResolve?.();
      this.flushBootstrapResolve = null;
      resolvedTurnType = 'bootstrap';
    } else if (this.discardNextResponse) {
      log.debug(`[bridge:${this.label}] Discarding late post-flush response: ${responseText.slice(0, 100)}`);
      this.discardNextResponse = false;
      resolvedTurnType = 'discarded';
    } else if (pending?.type === 'bootstrap' || this.bootstrapping) {
      log.debug(`[bridge:${this.label}] Bootstrap response: ${responseText.slice(0, 100)}`);
      this.bootstrapping = false;
      if (this.bootstrapResolve) {
        this.bootstrapResolve();
        this.bootstrapResolve = null;
      }
      resolvedTurnType = 'bootstrap';
    } else {
      if (!pending || pending.type === 'user') {
        if (responseText) {
          this.messagesProcessedToday++;
          this.emit('response', responseText, result.durationMs ?? undefined);
        }
        resolvedTurnType = 'user';
      } else if (pending.type === 'system-reply') {
        this.systemReplyQueue.shift();
        if (responseText) {
          log.debug(`[bridge:${this.label}] Task notification response (replyTo=${pending.replyToMessageId}): ${responseText.slice(0, 100)}`);
          this.emit('system-response', responseText, pending.replyToMessageId);
        }
        resolvedTurnType = 'system';
      } else if (pending.type === 'system-forward') {
        if (responseText) {
          log.debug(`[bridge:${this.label}] Cron response forwarded: ${responseText.slice(0, 100)}`);
          this.emit('cron-response', responseText);
        }
        resolvedTurnType = 'system';
      } else {
        if (responseText) {
          log.debug(`[bridge:${this.label}] System message response absorbed: ${responseText.slice(0, 100)}`);
        }
        resolvedTurnType = 'system';
      }
    }

    this.resolveDrainIfNeeded();
    if (!this.flushing && resolvedTurnType && this.shouldAutoFlushAfterTurn(resolvedTurnType)) {
      this.checkFlush();
    }
  }

  private handleTurnFailure(message: string): void {
    this.currentMessagePreview = null;
    this.currentMessageStartedAt = null;
    const pending = this.shiftPendingTurn();

    if (pending?.type === 'flush-checkpoint') {
      this.flushCheckpointResolve?.();
      this.flushCheckpointResolve = null;
    } else if (pending?.type === 'flush-bootstrap') {
      this.flushBootstrapResolve?.();
      this.flushBootstrapResolve = null;
    } else if (pending?.type === 'bootstrap' || this.bootstrapping) {
      this.bootstrapping = false;
      if (this.bootstrapResolve) {
        this.bootstrapResolve();
        this.bootstrapResolve = null;
      }
    } else {
      if (!pending || pending.type === 'user') {
        this.messagesProcessedToday++;
        this.emit('response', '处理失败，请稍后重试');
      } else if (pending.type === 'system-reply') {
        this.systemReplyQueue.shift();
      }
      this.emit('alert', `⚠️ Director 调用失败: ${message}`);
    }

    this.resolveDrainIfNeeded();
  }

  private async handleRuntimeClosed(): Promise<void> {
    this.pendingTurns = [];
    this.systemReplyQueue = [];
    this.resolveDrainIfNeeded();

    if (this.bootstrapResolve) {
      this.bootstrapResolve();
      this.bootstrapResolve = null;
      this.bootstrapping = false;
    }

    if (this.shuttingDown) {
      console.log(`[bridge:${this.label}] Shutdown complete`);
      await this.adapter.stop();
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
      console.log(`[bridge:${this.label}] Pipe closed during flush (expected)`);
    } else if (!this.isMain) {
      console.log(`[bridge:${this.label}] Non-main bridge closed unexpectedly`);
      this.emit('stream-abort');
      this.emit('close');
    } else {
      this.emit('stream-abort');
      this.emit('alert', '🔴 Director 进程意外退出，正在重启...');
      console.log(`[bridge:${this.label}] Output pipe closed, clearing session and restarting...`);
      this.clearSession();
      await this.restart();
      await this.bootstrap();
    }
  }

  private resolveDrainIfNeeded(): void {
    if (this.pendingCount <= 0 && this.drainResolve) {
      this.drainResolve();
      this.drainResolve = null;
    }
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
    const timeStr = now.toLocaleTimeString('sv-SE', {
      timeZone: 'Asia/Shanghai',
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
    }).replace(':', '');
    const prefix = this.directorAgent.type === 'codex' ? 'codex-director' : 'director';
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
      if (!existsSync(this.logDir)) mkdirSync(this.logDir, { recursive: true });
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
}
