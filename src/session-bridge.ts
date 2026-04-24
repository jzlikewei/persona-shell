import { EventEmitter } from 'events';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, appendFileSync, renameSync } from 'fs';
import { execSync } from 'child_process';
import { dirname, join } from 'path';
import { resolveAgentProvider, type Config } from './config.js';
import type { AgentRuntimeConfig } from './persona-process.js';
import { loadPrompt } from './prompt-loader.js';
import { ClaudeDirectorRuntime } from './director-runtime/claude.js';
import { KimiDirectorRuntime } from './director-runtime/kimi.js';
import { CodexSessionAdapter } from './director-session-adapter/codex.js';
import { ClaudeSessionAdapter } from './director-session-adapter/claude.js';
import { KimiSessionAdapter } from './director-session-adapter/kimi.js';
import type {
  DirectorSessionAdapter,
  DirectorSessionAdapterHooks,
  DirectorSessionAdapterOptions,
  DirectorSessionMetricsUpdate,
  DirectorTurnResult,
  RestoredSessionState,
} from './director-session-adapter/index.js';
import { getState, setState, listTasks } from './task/task-store.js';
import { log, getLogDir } from './logger.js';

let _localHostName: string | null = null;
function getLocalHostName(): string {
  if (_localHostName !== null) return _localHostName;
  try {
    _localHostName = execSync('scutil --get LocalHostName', { encoding: 'utf-8' }).trim() || 'unknown';
  } catch {
    _localHostName = 'unknown';
  }
  return _localHostName;
}


interface BridgePersistedState {
  lastFlushAt: number;
  lastInputTokens: number;
  contextTokens: number;
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
  private readonly adapterFactory: (directorAgent: AgentRuntimeConfig) => DirectorSessionAdapter;
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
  private contextTokens = 0;
  private systemReplyQueue: string[] = [];
  private pendingTurns: PendingType[] = [];
  private bootstrapping = false;
  private bootstrapResolve: (() => void) | null = null;
  private flushCheckpointResolve: (() => void) | null = null;
  private flushBootstrapResolve: (() => void) | null = null;
  private runtimeCloseResolve: (() => void) | null = null;
  private drainResolve: (() => void) | null = null;
  private currentMessagePreview: string | null = null;
  private currentMessageStartedAt: number | null = null;
  private messagesProcessedToday = 0;
  private currentCountDate: string = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  private totalCostUsd = 0;
  private contextWindow = 0;
  private contextMetricsLive = false;
  private restartTimestamps: number[] = [];
  private expectedStaleCloses = 0;
  private discardNextResponse = false;
  private personaRole: string = 'director';

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

    const pipeDir = this.isMain ? this.config.pipe_dir : join(this.config.pipe_dir, this.label);
    const pidFile = this.isMain ? this.config.pid_file : join(pipeDir, 'director.pid');
    this.sessionFile = this.isMain ? join(pipeDir, 'director-session') : join(pipeDir, 'session');

    const adapterOptions: DirectorSessionAdapterOptions = {
      label: this.label,
      isMain: this.isMain,
      groupName: this.groupName,
      config: this.config,
      agents: this.agents,
      directorAgent: resolveAgentProvider(this.agents, 'director', options.directorAgentName),
      logDir: this.logDir,
    };

    const hooks = this.buildAdapterHooks();
    this.adapterFactory = (directorAgent) => {
      const resolvedOptions: DirectorSessionAdapterOptions = {
        ...adapterOptions,
        directorAgent,
        personaRole: this.personaRole,
      };
      if (options.directorFactory) {
        return options.directorFactory(resolvedOptions, hooks);
      }
      if (directorAgent.type === 'claude') {
        return new ClaudeSessionAdapter(new ClaudeDirectorRuntime({ pipeDir, pidFile, label: this.label }), resolvedOptions, hooks);
      }
      if (directorAgent.type === 'kimi') {
        return new KimiSessionAdapter(new KimiDirectorRuntime(), resolvedOptions, hooks);
      }
      return new CodexSessionAdapter(resolvedOptions, hooks);
    };

    const persistedAgentName = this.readPersistedDirectorAgentName();
    this.directorAgent = resolveAgentProvider(this.agents, 'director', options.directorAgentName ?? persistedAgentName);
    this.personaRole = this.readPersistedPersonaRole() ?? 'director';
    this.adapter = this.adapterFactory(this.directorAgent);
  }

  private get stateKey(): string {
    return `director:${this.label}`;
  }

  private get directorAgentStateKey(): string {
    return `director:agent:${this.label}`;
  }

  private get personaRoleStateKey(): string {
    return `persona:role:${this.label}`;
  }

  private get logDir(): string {
    return join(getLogDir(), this.label);
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
    if (typeof saved.contextTokens === 'number') this.contextTokens = saved.contextTokens;
    if (typeof saved.contextWindow === 'number') this.contextWindow = saved.contextWindow;
    return saved;
  }

  private persistState(): void {
    setState<BridgePersistedState>(this.stateKey, {
      lastFlushAt: this.lastFlushAt,
      lastInputTokens: this.lastInputTokens,
      contextTokens: this.contextTokens,
      contextWindow: this.contextWindow,
    });
  }

  async start(): Promise<boolean> {
    const freshStart = await this.adapter.start();
    this.persistDirectorAgentName(this.directorAgent.name);
    console.log(this.adapter.describeSessionReady(this.label, this.sessionId, this.sessionName));
    return freshStart;
  }

  /** Whether this bridge resumed an existing session (has a persisted session ID). */
  get hasRestoredSession(): boolean {
    return this.sessionId !== null;
  }

  /** Detach from the underlying process without killing it (for shell restart). */
  async detach(): Promise<void> {
    await this.adapter.stop();
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

      // Checkpoint: ask Director to save group context before termination
      const statePath = this.getSessionStateFilePath();
      console.log(`[bridge:${this.label}] FLUSH: starting checkpoint (non-main) → ${statePath}`);
      const checkpointDone = new Promise<void>((resolve) => {
        this.flushCheckpointResolve = resolve;
      });
      this.enqueuePendingTurn({ type: 'flush-checkpoint' });
      const poolCheckpointMsg = loadPrompt(this.config.persona_dir, 'flush-checkpoint-pool', {
        group_name: this.groupName ?? this.label,
        state_path: statePath,
      }) ?? `[FLUSH] 系统即将进行上下文刷新。请将群「${this.groupName ?? this.label}」的 workspace 更新到 ${statePath}，按 Context（背景目标约束）/ Knowledge（决策发现里程碑）/ State（当前任务待办）三层结构组织，只保留仍有效的信息，控制在 5KB 以内。保存完成后回复"已保存"。`;
      await this.writeRaw(poolCheckpointMsg);

      const checkpointOk = await Promise.race([
        checkpointDone.then(() => true),
        this.timeout(SessionBridge.FLUSH_STEP_TIMEOUT).then(() => false),
      ]);
      if (!checkpointOk) {
        console.warn(`[bridge:${this.label}] FLUSH: checkpoint timeout (non-main), forcing reset`);
        this.flushCheckpointResolve = null;
        this.discardNextResponse = true;
        // 清除过期的 checkpoint pending turn
        const idx = this.pendingTurns.findIndex(t => t.type === 'flush-checkpoint');
        if (idx >= 0) this.pendingTurns.splice(idx, 1);
      } else {
        console.log(`[bridge:${this.label}] FLUSH: checkpoint done (non-main)`);
      }

      this.expectedStaleCloses++;
      this.adapter.terminate('SIGTERM');
      this.clearSession();
      await this.restart();

      // Bootstrap with saved state
      const bootstrapDone = new Promise<void>((resolve) => {
        this.flushBootstrapResolve = resolve;
      });
      this.enqueuePendingTurn({ type: 'flush-bootstrap' });
      await this.writeRaw(this.buildBootstrapMessage(statePath));

      const bootstrapOk = await Promise.race([
        bootstrapDone.then(() => true),
        this.timeout(SessionBridge.FLUSH_STEP_TIMEOUT).then(() => false),
      ]);
      if (!bootstrapOk) {
        console.warn(`[bridge:${this.label}] FLUSH: bootstrap timeout (non-main) — forcing flush finish`);
        this.flushBootstrapResolve = null;
        this.discardNextResponse = true;
        // 清除过期的 bootstrap pending turn
        const idx = this.pendingTurns.findIndex(t => t.type === 'flush-bootstrap');
        if (idx >= 0) this.pendingTurns.splice(idx, 1);
      }

      this.finishFlush();
      console.log(`[bridge:${this.label}] FLUSH: complete (non-main)`);
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
    const mainCheckpointMsg = loadPrompt(this.config.persona_dir, 'flush-checkpoint-main')
      ?? '[FLUSH] 系统即将进行上下文刷新。请将当前工作状态保存到 daily/state.md，包括：进行中的任务、待处理的事项、需要保留的上下文。保存完成后回复"已保存"。';
    await this.writeRaw(mainCheckpointMsg);

    const checkpointOk = await Promise.race([
      checkpointDone.then(() => true),
      this.timeout(SessionBridge.FLUSH_STEP_TIMEOUT).then(() => false),
    ]);
    if (!checkpointOk) {
      console.warn(`[bridge:${this.label}] FLUSH: checkpoint timeout, skipping checkpoint and forcing reset`);
      this.flushCheckpointResolve = null;
      this.discardNextResponse = true;
      // 清除过期的 checkpoint pending turn
      const idx = this.pendingTurns.findIndex(t => t.type === 'flush-checkpoint');
      if (idx >= 0) this.pendingTurns.splice(idx, 1);
    } else {
      console.log(`[bridge:${this.label}] FLUSH: checkpoint done`);
    }

    this.expectedStaleCloses++;
    this.adapter.terminate('SIGTERM');
    this.clearSession();
    await this.restart();

    const bootstrapDone = new Promise<void>((resolve) => {
      this.flushBootstrapResolve = resolve;
    });
    this.enqueuePendingTurn({ type: 'flush-bootstrap' });
    const flushBootstrapMsg = loadPrompt(this.config.persona_dir, 'flush-bootstrap-main')
      ?? '[FLUSH] 你刚经历了上下文刷新。请读取 daily/state.md 恢复工作上下文。';
    await this.writeRaw(flushBootstrapMsg);

    const bootstrapOk = await Promise.race([
      bootstrapDone.then(() => true),
      this.timeout(SessionBridge.FLUSH_STEP_TIMEOUT).then(() => false),
    ]);
    if (!bootstrapOk) {
      console.warn(`[bridge:${this.label}] FLUSH: bootstrap timeout — forcing flush finish`);
      this.flushBootstrapResolve = null;
      this.discardNextResponse = true;
      // 清除过期的 bootstrap pending turn
      const idx = this.pendingTurns.findIndex(t => t.type === 'flush-bootstrap');
      if (idx >= 0) this.pendingTurns.splice(idx, 1);
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
    this.expectedStaleCloses++;
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
    this.contextTokens = 0;
    this.contextMetricsLive = false;
    this.flushing = false;
    this.discardNextResponse = false;
    this.persistState();
  }

  get isFlushing(): boolean {
    return this.flushing;
  }

  getDirectorAgentName(): string {
    return this.directorAgent.name;
  }

  getDirectorAgentType(): AgentRuntimeConfig['type'] {
    return this.directorAgent.type;
  }

  getPersonaRole(): string {
    return this.personaRole;
  }

  getStatus(): {
    alive: boolean;
    pid: number | null;
    sessionId: string | null;
    sessionName: string | null;
    flushing: boolean;
    interrupted: boolean;
    pendingCount: number;
    agentType: AgentRuntimeConfig['type'];
    lastInputTokens: number;
    contextTokens: number;
    lastFlushAt: number;
    flushContextLimit: number;
    contextWindow: number;
    contextMetricsLive: boolean;
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
      agentType: this.directorAgent.type,
      lastInputTokens: this.lastInputTokens,
      contextTokens: this.contextTokens,
      lastFlushAt: this.lastFlushAt,
      flushContextLimit: this.config.flush_context_limit,
      contextWindow: this.contextWindow,
      contextMetricsLive: this.contextMetricsLive,
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

  async switchAgent(agentName: string): Promise<boolean> {
    if (this.flushing) {
      console.log(`[bridge:${this.label}] Agent switch skipped: flush in progress`);
      return false;
    }

    const targetAgent = resolveAgentProvider(this.agents, 'director', agentName);
    if (targetAgent.name === this.directorAgent.name) {
      this.persistDirectorAgentName(targetAgent.name);
      return true;
    }

    if (this.interrupted) {
      console.log(`[bridge:${this.label}] Agent switch waiting for interrupt to complete...`);
      await new Promise<void>((resolve) => {
        this.once('restarted', resolve);
      });
    }

    this.flushing = true;
    let switched = false;

    try {
      if (this.pendingCount > 0) {
        console.log(`[bridge:${this.label}] Agent switch: draining ${this.pendingCount} in-flight messages...`);
        const drained = await this.waitForDrain(SessionBridge.FLUSH_STEP_TIMEOUT);
        if (!drained) {
          console.warn(`[bridge:${this.label}] Agent switch: drain timeout, aborting`);
          return false;
        }
      }

      this.emit('flush-drain-complete');

      const checkpointDone = new Promise<void>((resolve) => {
        this.flushCheckpointResolve = resolve;
      });
      this.enqueuePendingTurn({ type: 'flush-checkpoint' });
      await this.writeRaw(this.buildAgentSwitchCheckpointPrompt(targetAgent.name));

      const checkpointOk = await Promise.race([
        checkpointDone.then(() => true),
        this.timeout(SessionBridge.FLUSH_STEP_TIMEOUT).then(() => false),
      ]);
      if (!checkpointOk) {
        console.warn(`[bridge:${this.label}] Agent switch: checkpoint timeout, continuing`);
        this.flushCheckpointResolve = null;
        this.discardNextResponse = true;
        // 清除过期的 checkpoint pending turn
        const idx = this.pendingTurns.findIndex(t => t.type === 'flush-checkpoint');
        if (idx >= 0) this.pendingTurns.splice(idx, 1);
      }

      const currentAdapter = this.adapter;
      const closeWait = currentAdapter.hasActiveTurn()
        ? this.waitForRuntimeClose(10_000)
        : null;
      currentAdapter.terminate('SIGTERM');
      if (closeWait) {
        const closed = await closeWait;
        if (!closed) {
          console.warn(`[bridge:${this.label}] Agent switch: runtime close timeout, continuing with cold start`);
        }
      }
      this.clearSession();
      this.directorAgent = targetAgent;
      this.adapter = this.adapterFactory(this.directorAgent);

      const freshStart = await this.start();
      await this.bootstrapInternal(this.getAgentSwitchBootstrapSource(freshStart), true);
      switched = true;
      console.log(`[bridge:${this.label}] Agent switched to ${this.directorAgent.name}`);
      return true;
    } catch (err) {
      console.error(`[bridge:${this.label}] Agent switch failed:`, err);
      this.emit('alert', `⚠️ 会话切换到 ${targetAgent.name} 失败: ${String(err).slice(0, 200)}`);
      return false;
    } finally {
      if (switched) {
        this.finishFlush();
      } else {
        this.flushing = false;
        this.discardNextResponse = false;
      }
    }
  }

  async switchPersona(roleName: string): Promise<boolean> {
    if (this.flushing) {
      console.log(`[bridge:${this.label}] Persona switch skipped: flush in progress`);
      return false;
    }

    if (roleName === this.personaRole) {
      return true;
    }

    if (this.interrupted) {
      console.log(`[bridge:${this.label}] Persona switch waiting for interrupt to complete...`);
      await new Promise<void>((resolve) => {
        this.once('restarted', resolve);
      });
    }

    this.flushing = true;
    let switched = false;

    try {
      if (this.pendingCount > 0) {
        console.log(`[bridge:${this.label}] Persona switch: draining ${this.pendingCount} in-flight messages...`);
        const drained = await this.waitForDrain(SessionBridge.FLUSH_STEP_TIMEOUT);
        if (!drained) {
          console.warn(`[bridge:${this.label}] Persona switch: drain timeout, aborting`);
          return false;
        }
      }

      this.emit('flush-drain-complete');

      const checkpointDone = new Promise<void>((resolve) => {
        this.flushCheckpointResolve = resolve;
      });
      this.enqueuePendingTurn({ type: 'flush-checkpoint' });
      await this.writeRaw(this.buildPersonaSwitchCheckpointPrompt(roleName));

      const checkpointOk = await Promise.race([
        checkpointDone.then(() => true),
        this.timeout(SessionBridge.FLUSH_STEP_TIMEOUT).then(() => false),
      ]);
      if (!checkpointOk) {
        console.warn(`[bridge:${this.label}] Persona switch: checkpoint timeout, continuing`);
        this.flushCheckpointResolve = null;
        this.discardNextResponse = true;
        const idx = this.pendingTurns.findIndex(t => t.type === 'flush-checkpoint');
        if (idx >= 0) this.pendingTurns.splice(idx, 1);
      }

      const currentAdapter = this.adapter;
      const closeWait = currentAdapter.hasActiveTurn()
        ? this.waitForRuntimeClose(10_000)
        : null;
      currentAdapter.terminate('SIGTERM');
      if (closeWait) {
        const closed = await closeWait;
        if (!closed) {
          console.warn(`[bridge:${this.label}] Persona switch: runtime close timeout, continuing with cold start`);
        }
      }

      this.personaRole = roleName;
      this.persistPersonaRole();
      this.clearSession();
      this.adapter = this.adapterFactory(this.directorAgent);

      const freshStart = await this.start();
      await this.bootstrapInternal(this.getPersonaSwitchBootstrapSource(freshStart), true);
      switched = true;
      console.log(`[bridge:${this.label}] Persona switched to ${this.personaRole}`);
      return true;
    } catch (err) {
      console.error(`[bridge:${this.label}] Persona switch failed:`, err);
      this.emit('alert', `⚠️ 人格切换到 ${roleName} 失败: ${String(err).slice(0, 200)}`);
      return false;
    } finally {
      if (switched) {
        this.finishFlush();
      } else {
        this.flushing = false;
        this.discardNextResponse = false;
      }
    }
  }

  async bootstrap(sourcePath?: string): Promise<void> {
    await this.bootstrapInternal(sourcePath, false);
  }

  private async bootstrapInternal(sourcePath?: string, allowDuringFlush: boolean = false): Promise<void> {
    if (!this.adapter.isReady() || (this.flushing && !allowDuringFlush)) return;

    this.bootstrapping = true;
    const pendingTurn = this.enqueuePendingTurn({ type: 'bootstrap' });

    const msg = this.buildBootstrapMessage(sourcePath);

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

    const pendingTurn = this.enqueuePendingTurn({ type: 'user' });
    try {
      await this.writeRaw(content);
    } catch (err) {
      this.removePendingTurn(pendingTurn);
      this.resolveDrainIfNeeded();
      throw err;
    }
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

  private waitForRuntimeClose(timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const finish = (ok: boolean) => {
        if (this.runtimeCloseResolve === onClose) {
          this.runtimeCloseResolve = null;
        }
        clearTimeout(timer);
        resolve(ok);
      };
      const onClose = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      this.runtimeCloseResolve = onClose;
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

    const trackedContextTokens = this.directorAgent.type === 'codex'
      ? this.contextTokens
      : this.lastInputTokens;
    const contextOverLimit = trackedContextTokens > 0
      && trackedContextTokens > this.config.flush_context_limit;
    const timeOverLimit = Date.now() - this.lastFlushAt > this.config.flush_interval_ms;

    if (contextOverLimit || timeOverLimit) {
      const reason = contextOverLimit
        ? `context tokens ${trackedContextTokens} > ${this.config.flush_context_limit}`
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

  private readPersistedDirectorAgentName(): string | undefined {
    return getState<string>(this.directorAgentStateKey)
      ?? (this.isMain ? getState<string>('director:agent') : undefined)
      ?? undefined;
  }

  private persistDirectorAgentName(agentName: string): void {
    setState(this.directorAgentStateKey, agentName);
    if (this.isMain) {
      setState('director:agent', agentName);
    }
  }

  private readPersistedPersonaRole(): string | undefined {
    return getState<string>(this.personaRoleStateKey)
      ?? (this.isMain ? getState<string>('persona:role') : undefined)
      ?? undefined;
  }

  private persistPersonaRole(): void {
    setState(this.personaRoleStateKey, this.personaRole);
    if (this.isMain) {
      setState('persona:role', this.personaRole);
    }
  }

  /** Get the path to this session's state file (for checkpoint/bootstrap). */
  getSessionStatePath(): string {
    return this.getSessionStateFilePath();
  }

  private getSessionStateFilePath(): string {
    const dir = join(this.config.persona_dir, 'workspaces');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const suffix = this.groupName ? `-${this.groupName.replace(/[\/\\:*?"<>|]/g, '_')}` : '';
    const file = join(dir, `${this.label}${suffix}.md`);
    if (!existsSync(file)) {
      // migrate from old name without group suffix
      const legacy = join(dir, `${this.label}.md`);
      if (existsSync(legacy)) {
        renameSync(legacy, file);
      } else {
        writeFileSync(file, '');
      }
    }
    return file;
  }

  private getSessionStatePromptPath(): string {
    return this.isMain ? 'daily/state.md' : this.getSessionStateFilePath();
  }

  private getAgentSwitchBootstrapSource(freshStart: boolean): string | undefined {
    if (!freshStart) return undefined;
    return this.isMain ? 'daily/state.md' : this.getSessionStateFilePath();
  }

  private buildAgentSwitchCheckpointPrompt(targetAgentName: string): string {
    const sessionStatePath = this.getSessionStatePromptPath();
    const vars = {
      current_agent: this.directorAgent.name,
      target_agent: targetAgentName,
      state_path: sessionStatePath,
      group_name: this.groupName ?? this.label,
    };

    if (this.isMain) {
      return loadPrompt(this.config.persona_dir, 'agent-switch-checkpoint-main', vars)
        ?? `[FLUSH] 当前会话即将从 ${this.directorAgent.name} 切换到 ${targetAgentName}。请先将当前工作状态保存到 ${sessionStatePath}，包括：进行中的任务、待处理事项、关键上下文、切换后需要继续的动作。保存完成后回复"已保存"。`;
    }

    return loadPrompt(this.config.persona_dir, 'agent-switch-checkpoint-pool', vars)
      ?? `[FLUSH] 当前会话即将从 ${this.directorAgent.name} 切换到 ${targetAgentName}。请将群「${this.groupName ?? this.label}」的 workspace 更新到 ${sessionStatePath}，按 Context / Knowledge / State 三层结构组织。保存完成后回复"已保存"。`;
  }

  private buildPersonaSwitchCheckpointPrompt(targetRole: string): string {
    const sessionStatePath = this.getSessionStatePromptPath();
    const vars = {
      current_role: this.personaRole,
      target_role: targetRole,
      state_path: sessionStatePath,
      group_name: this.groupName ?? this.label,
    };

    return loadPrompt(this.config.persona_dir, 'persona-switch-checkpoint', vars)
      ?? `[FLUSH] 当前人格即将从「${this.personaRole}」切换到「${targetRole}」。请将当前 workspace 更新到 ${sessionStatePath}，按 Context / Knowledge / State 三层结构组织。保存完成后回复"已保存"。`;
  }

  private getPersonaSwitchBootstrapSource(freshStart: boolean): string | undefined {
    if (!freshStart) return undefined;
    return this.isMain ? 'daily/state.md' : this.getSessionStateFilePath();
  }

  private buildBootstrapMessage(sourcePath?: string): string {
    const hostname = getLocalHostName();
    const sharedNote = `当前机器: ${hostname}。state 文件请使用 daily/state-${hostname}.md（按机器隔离，不要用 daily/state.md）。注意：不要用 curl localhost:3000、launchctl 等宿主机探针判断后台任务能力；你所在运行环境可能与宿主机隔离。需要判断任务系统是否可用时，直接调用 MCP 工具 create_task / list_tasks，以工具调用结果为准。`;
    const groupName = this.groupName ?? this.label;

    let msg: string;

    if (this.isMain) {
      const statePath = sourcePath ?? 'daily/state.md';
      msg = loadPrompt(this.config.persona_dir, 'bootstrap-main', {
        state_path: statePath,
        shared_note: sharedNote,
      }) ?? `[系统] 新 session 已启动。请读取 ${statePath} 恢复工作上下文，了解当前待处理事项。${sharedNote}`;
    } else if (sourcePath) {
      msg = loadPrompt(this.config.persona_dir, 'bootstrap-pool-with-state', {
        group_name: groupName,
        state_path: sourcePath,
        shared_note: sharedNote,
      }) ?? `[系统] 新 session 已启动。你正在为群「${groupName}」服务。请先读取 ${sourcePath} 恢复这个会话的上下文；如需全局状态，再参考 daily/state.md（只读）。${sharedNote}`;
    } else {
      msg = loadPrompt(this.config.persona_dir, 'bootstrap-pool-fresh', {
        group_name: groupName,
        shared_note: sharedNote,
      }) ?? `[系统] 新 session 已启动。你正在为群「${groupName}」服务。请读取 daily/state.md 了解全局状态（只读）。${sharedNote}`;
    }

    if (this.personaRole !== 'director') {
      const effectiveStatePath = sourcePath ?? (this.isMain ? 'daily/state.md' : this.getSessionStateFilePath());
      const personaVars = {
        role: this.personaRole,
        state_path: effectiveStatePath,
      };
      const personaNotice = loadPrompt(this.config.persona_dir, 'persona-switch-bootstrap', personaVars)
        ?? `[系统] 人格已切换为「${this.personaRole}」。请先读取 ${effectiveStatePath} 恢复上下文。你现在以 ${this.personaRole} 的身份与用户对话。`;
      msg += '\n\n' + personaNotice;
    }

    return msg;
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
    if (typeof update.contextTokens === 'number' && update.contextTokens > 0) {
      this.contextTokens = update.contextTokens;
      shouldPersist = true;
    }
    if (typeof update.contextWindow === 'number' && update.contextWindow > 0) {
      this.contextWindow = update.contextWindow;
      shouldPersist = true;
    }
    if (shouldPersist) {
      this.contextMetricsLive = true;
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
    if (this.expectedStaleCloses > 0) {
      this.expectedStaleCloses--;
      this.runtimeCloseResolve?.();
      this.runtimeCloseResolve = null;
      console.log(`[bridge:${this.label}] Ignoring stale close event from previous runtime`);
      return;
    }
    this.runtimeCloseResolve?.();
    this.runtimeCloseResolve = null;
    // Don't clear pendingTurns during flush — the flush flow manages its own
    // turns (checkpoint → terminate → restart → bootstrap) and clearing here
    // would race with the restart that adds new pending turns.
    if (!this.flushing) {
      this.pendingTurns = [];
      this.systemReplyQueue = [];
      this.emit('queue-desync');  // 通知外层清理 MessageQueue
    }
    this.resolveDrainIfNeeded();

    if (this.bootstrapResolve && !this.flushing) {
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

  /** Drop the current session ID so the next turn creates a fresh session. */
  resetSession(): void {
    this.clearSession();
  }

  private clearSession(): void {
    this.sessionId = null;
    this.sessionName = null;
    this.lastInputTokens = 0;
    this.contextTokens = 0;
    this.contextMetricsLive = false;
    this.persistState();
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
    const prefix = this.directorAgent.type === 'codex' ? 'codex-director'
      : this.directorAgent.type === 'kimi' ? 'kimi-director'
      : 'director';
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
