import { spawn, type ChildProcess } from 'child_process';
import { createInterface } from 'readline';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import type { DirectorRuntimeStatus, DirectorSendResult } from './index.js';
import type { Config } from '../config.js';
import type { AgentRuntimeConfig } from '../persona-process.js';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

interface JsonRpcResponse {
  jsonrpc?: '2.0';
  id: number | string;
  result?: unknown;
  error?: unknown;
}

interface JsonRpcNotification {
  jsonrpc?: '2.0';
  method: string;
  params?: unknown;
  id?: number | string;
}

interface PendingRequest {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface ThreadItem {
  type?: string;
  text?: string;
}

interface TurnRecord {
  id?: string;
  items?: ThreadItem[];
  durationMs?: number | null;
  status?: string;
  error?: unknown;
}

interface CodexAppServerRuntimeHooks {
  getSessionId(): string | null;
  getSessionName(): string | null;
  setSessionName(name: string): void;
  buildSessionName(): string;
  persistSession(sessionId: string, sessionName: string | null): void;
  clearSession(): void;
  logOutput(line: string): void;
  onChunk(text: string): void;
  onToolCall(): void;
  onPartialAgentMessage(text: string): void;
  onMetrics(update: { lastInputTokens?: number; contextTokens?: number; contextWindow?: number }): void;
  onTurnComplete(result: { responseText: string; durationMs: number | null }): void;
  onTurnFailure(message: string): void;
  onRuntimeClosed(): Promise<void> | void;
}

export interface CodexAppServerRuntimeOptions {
  label: string;
  logDir: string;
  config: Config['director'];
  agent: AgentRuntimeConfig;
  personaRole: string;
}

export class CodexAppServerRuntime {
  readonly kind = 'codex-app-server' as const;
  private child: ChildProcess | null = null;
  private pending = new Map<number | string, PendingRequest>();
  private requestId = 0;
  private initialized = false;
  private threadReady = false;
  private activeTurnId: string | null = null;
  private activeResponse = '';
  private activeDeltaCount = 0;
  private currentTurnStartedAt: number | null = null;
  private starting: Promise<boolean> | null = null;

  constructor(
    private readonly options: CodexAppServerRuntimeOptions,
    private readonly hooks: CodexAppServerRuntimeHooks,
  ) {}

  async start(): Promise<boolean> {
    if (this.starting) return this.starting;
    this.starting = this.startInternal().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  isReady(): boolean {
    return Boolean(this.child?.pid && !this.child.killed && this.initialized && this.threadReady);
  }

  hasActiveTurn(): boolean {
    return this.activeTurnId !== null;
  }

  getStatus(): DirectorRuntimeStatus {
    return {
      kind: this.kind,
      alive: Boolean(this.child?.pid && !this.child.killed),
      pid: this.child?.pid ?? null,
    };
  }

  async send(content: string): Promise<DirectorSendResult> {
    if (!this.isReady()) {
      throw new Error('codex app-server is not ready');
    }

    const threadId = this.hooks.getSessionId();
    if (!threadId) {
      throw new Error('codex app-server thread is not initialized');
    }

    if (this.activeTurnId) {
      await this.request('turn/steer', {
        threadId,
        expectedTurnId: this.activeTurnId,
        input: [this.textInput(content)],
      });
      return 'steered';
    }

    this.activeResponse = '';
    this.activeDeltaCount = 0;
    this.currentTurnStartedAt = Date.now();
    const result = await this.request('turn/start', {
      threadId,
      input: [this.textInput(content)],
      approvalPolicy: this.options.agent.approval ?? 'never',
      sandboxPolicy: this.toSandboxPolicy(this.options.agent.sandbox),
      ...(this.options.agent.model ? { model: this.options.agent.model } : {}),
    });

    const turnId = this.getTurnId(result);
    if (turnId) this.activeTurnId = turnId;
    return 'started';
  }

  async stop(): Promise<void> {
    await this.shutdownChild('SIGTERM');
  }

  terminate(signal: NodeJS.Signals): void {
    this.kill(signal);
  }

  interrupt(): void {
    const threadId = this.hooks.getSessionId();
    const turnId = this.activeTurnId;
    if (!threadId || !turnId || !this.isReady()) {
      this.kill('SIGINT');
      return;
    }
    void this.request('turn/interrupt', { threadId, turnId }).catch(() => {
      this.kill('SIGINT');
    });
  }

  async restart(): Promise<boolean> {
    const sessionId = this.hooks.getSessionId();
    const sessionName = this.hooks.getSessionName();
    await this.shutdownChild('SIGTERM');
    if (sessionId) this.hooks.persistSession(sessionId, sessionName);
    return this.start();
  }

  kill(signal: NodeJS.Signals): void {
    const pid = this.child?.pid;
    if (!pid) return;
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        this.child?.kill(signal);
      } catch {
        // already exited
      }
    }
  }

  private async startInternal(): Promise<boolean> {
    this.initialized = false;
    this.threadReady = false;
    this.activeTurnId = null;
    this.activeResponse = '';
    this.activeDeltaCount = 0;
    this.currentTurnStartedAt = null;

    const restoredSession = this.hooks.getSessionId();
    const restoredName = this.hooks.getSessionName();
    const sessionName = restoredName ?? this.hooks.buildSessionName();
    if (!restoredName) this.hooks.setSessionName(sessionName);

    this.spawnChild();

    await this.request('initialize', {
      clientInfo: {
        name: 'persona-shell',
        title: 'persona-shell',
        version: '0.1.0',
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        optOutNotificationMethods: [],
      },
    });
    this.initialized = true;

    if (restoredSession) {
      try {
        const resumed = await this.request('thread/resume', {
          threadId: restoredSession,
          ...this.threadOptions(),
        });
        const threadId = this.getThreadId(resumed) ?? restoredSession;
        this.hooks.persistSession(threadId, sessionName);
        this.threadReady = true;
        return false;
      } catch (err) {
        console.warn(`[bridge:${this.options.label}] Codex app-server resume failed, starting new thread: ${String(err)}`);
        this.hooks.clearSession();
      }
    }

    const started = await this.request('thread/start', {
      ...this.threadOptions(),
      ephemeral: this.options.agent.ephemeral ?? false,
    });
    const threadId = this.getThreadId(started);
    if (!threadId) throw new Error('codex app-server thread/start did not return a thread id');
    this.hooks.persistSession(threadId, sessionName);
    this.threadReady = true;
    return true;
  }

  private spawnChild(): void {
    if (!existsSync(this.options.logDir)) mkdirSync(this.options.logDir, { recursive: true });
    const stderrPath = join(this.options.logDir, 'codex-app-server-stderr.log');
    const stderrDir = dirname(stderrPath);
    if (!existsSync(stderrDir)) mkdirSync(stderrDir, { recursive: true });
    const stderrFd = openSync(stderrPath, 'a');

    const args = ['app-server', '--listen', 'stdio://'];
    const child = spawn(this.options.agent.command, args, {
      detached: true,
      stdio: ['pipe', 'pipe', stderrFd],
      cwd: this.options.config.persona_dir,
      env: { ...process.env, DIRECTOR_LABEL: this.options.label, NO_COLOR: '1' },
    });
    closeSync(stderrFd);

    this.child = child;
    child.unref();

    if (!child.stdin || !child.stdout) {
      throw new Error('failed to spawn codex app-server stdio process');
    }

    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => this.handleLine(line));
    child.on('error', (err) => this.rejectAll(`codex app-server error: ${err.message}`));
    child.on('close', () => {
      this.initialized = false;
      this.threadReady = false;
      this.activeTurnId = null;
      this.rejectAll('codex app-server closed');
      void this.hooks.onRuntimeClosed();
    });

    console.log(`[bridge:${this.options.label}] Spawned codex app-server (pid: ${child.pid ?? 'unknown'})`);
  }

  private request(method: string, params: unknown, timeoutMs = 180_000): Promise<unknown> {
    const child = this.child;
    if (!child?.stdin || child.stdin.destroyed) {
      return Promise.reject(new Error('codex app-server stdin is closed'));
    }

    const id = ++this.requestId;
    const payload = { jsonrpc: '2.0', id, method, params };
    const line = JSON.stringify(payload);
    this.hooks.logOutput(line);
    child.stdin.write(line + '\n');

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
    });
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    this.hooks.logOutput(line);

    let msg: JsonRpcResponse | JsonRpcNotification;
    try {
      msg = JSON.parse(line) as JsonRpcResponse | JsonRpcNotification;
    } catch {
      return;
    }

    if ('method' in msg) {
      if ('id' in msg) {
        this.handleServerRequest(msg);
      } else {
        this.handleNotification(msg);
      }
      return;
    }
    if ('id' in msg) {
      this.handleResponse(msg);
    }
  }

  private handleResponse(msg: JsonRpcResponse): void {
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(msg.id);
    if (msg.error) {
      pending.reject(new Error(`${pending.method} failed: ${this.summarize(msg.error)}`));
      return;
    }
    pending.resolve(msg.result);
  }

  private handleNotification(msg: JsonRpcNotification): void {
    const params = this.asRecord(msg.params);
    if (this.isToolLikeMethod(msg.method)) {
      this.hooks.onToolCall();
    }
    switch (msg.method) {
      case 'thread/started': {
        const threadId = this.getThreadId({ thread: params.thread });
        if (threadId) this.hooks.persistSession(threadId, this.hooks.getSessionName());
        break;
      }
      case 'turn/started': {
        const turnId = this.getTurnId(params);
        if (turnId) {
          this.activeTurnId = turnId;
          this.activeDeltaCount = 0;
          this.currentTurnStartedAt = Date.now();
          console.log(`[codex-live:${this.options.label}] turn started id=${turnId}`);
        }
        break;
      }
      case 'item/agentMessage/delta': {
        const delta = typeof params.delta === 'string' ? params.delta : '';
        if (delta) {
          const nextTotal = this.activeResponse.length + delta.length;
          this.activeDeltaCount += 1;
          console.log(
            `[codex-live:${this.options.label}] delta #${this.activeDeltaCount} chars=${delta.length} total=${nextTotal} preview="${this.preview(delta)}"`,
          );
          this.activeResponse += delta;
          this.hooks.onChunk(delta);
        }
        break;
      }
      case 'item/completed': {
        const item = this.asRecord(params.item);
        if (item.type === 'agentMessage' && typeof item.text === 'string') {
          this.hooks.onPartialAgentMessage(item.text);
        } else if (this.isToolLikeItem(item)) {
          this.hooks.onToolCall();
        }
        break;
      }
      case 'turn/completed': {
        this.handleTurnCompleted(params);
        break;
      }
      case 'thread/tokenUsage/updated': {
        this.handleTokenUsage(params);
        break;
      }
      case 'error': {
        this.hooks.onTurnFailure(this.summarize(params.error ?? params));
        this.activeTurnId = null;
        this.activeResponse = '';
        this.activeDeltaCount = 0;
        this.currentTurnStartedAt = null;
        break;
      }
      default:
        break;
    }
  }

  private handleServerRequest(msg: JsonRpcNotification): void {
    const child = this.child;
    if (!child?.stdin || msg.id === undefined) return;
    if (this.isToolLikeMethod(msg.method)) {
      this.hooks.onToolCall();
    }

    const response = {
      jsonrpc: '2.0',
      id: msg.id,
      result: this.defaultServerRequestResult(msg.method),
    };
    const line = JSON.stringify(response);
    this.hooks.logOutput(line);
    child.stdin.write(line + '\n');
  }

  private defaultServerRequestResult(method: string): unknown {
    if (method === 'item/commandExecution/requestApproval') return { decision: 'accept' };
    if (method === 'item/fileChange/requestApproval') return { decision: 'accept' };
    if (method === 'item/permissions/requestApproval') {
      return { permissions: {}, scope: 'turn' };
    }
    if (method === 'applyPatchApproval') return { decision: 'accept' };
    if (method === 'execCommandApproval') return { decision: 'accept' };
    if (method === 'item/tool/requestUserInput') return { input: [] };
    if (method === 'mcpServer/elicitation/request') return { action: 'decline' };
    return null;
  }

  private handleTurnCompleted(params: Record<string, unknown>): void {
    const turn = this.asRecord(params.turn) as TurnRecord;
    const turnId = typeof turn.id === 'string' ? turn.id : null;
    if (turnId && this.activeTurnId && turnId !== this.activeTurnId) return;

    const responseText = this.extractResponseText(turn) || this.activeResponse;
    const durationMs = typeof turn.durationMs === 'number'
      ? turn.durationMs
      : this.currentTurnStartedAt
        ? Date.now() - this.currentTurnStartedAt
        : null;

    this.activeTurnId = null;
    this.activeResponse = '';
    const deltaCount = this.activeDeltaCount;
    this.activeDeltaCount = 0;
    this.currentTurnStartedAt = null;

    if (turn.status === 'failed') {
      this.hooks.onTurnFailure(this.summarize(turn.error ?? 'turn failed'));
      return;
    }

    console.log(
      `[codex-live:${this.options.label}] turn completed chars=${responseText.length} deltas=${deltaCount} duration_ms=${durationMs ?? 'N/A'}`,
    );
    this.hooks.onTurnComplete({ responseText: responseText.trim(), durationMs });
  }

  private handleTokenUsage(params: Record<string, unknown>): void {
    const tokenUsage = this.asRecord(params.tokenUsage);
    const total = this.asRecord(tokenUsage.total);
    const last = this.asRecord(tokenUsage.last);
    const totalInput = this.numberField(total.inputTokens) + this.numberField(total.cachedInputTokens);
    const lastInput = this.numberField(last.inputTokens) + this.numberField(last.cachedInputTokens);
    const contextWindow = this.numberField(tokenUsage.modelContextWindow);
    this.hooks.onMetrics({
      ...(lastInput > 0 ? { lastInputTokens: lastInput } : {}),
      ...(totalInput > 0 ? { contextTokens: totalInput } : {}),
      ...(contextWindow > 0 ? { contextWindow } : {}),
    });
  }

  private async shutdownChild(signal: NodeJS.Signals): Promise<void> {
    const child = this.child;
    if (!child?.pid) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3_000);
      child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      this.kill(signal);
    });
  }

  private rejectAll(message: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`${pending.method} failed: ${message}`));
    }
    this.pending.clear();
  }

  private threadOptions(): Record<string, unknown> {
    const personaDir = this.options.config.persona_dir;
    return {
      cwd: personaDir,
      approvalPolicy: this.options.agent.approval ?? 'never',
      sandbox: this.options.agent.sandbox ?? 'danger-full-access',
      ...(this.options.agent.model ? { model: this.options.agent.model } : {}),
      baseInstructions: this.readPromptSections(['soul.md', 'meta.md']),
      developerInstructions: this.readDeveloperInstructions(),
    };
  }

  private readDeveloperInstructions(): string {
    const files = [`personas/${this.options.personaRole}.md`];
    if (this.options.agent.system_prompt_file) files.unshift(this.options.agent.system_prompt_file);
    return this.readPromptSections(files);
  }

  private readPromptSections(files: string[]): string {
    return files
      .map((file) => {
        const path = join(this.options.config.persona_dir, file);
        if (!existsSync(path)) return '';
        try {
          return readFileSync(path, 'utf-8').trim();
        } catch {
          return '';
        }
      })
      .filter(Boolean)
      .join('\n\n');
  }

  private toSandboxPolicy(mode: AgentRuntimeConfig['sandbox']): Record<string, JsonValue> {
    if (mode === 'read-only') return { type: 'readOnly', networkAccess: true };
    if (mode === 'workspace-write') {
      return {
        type: 'workspaceWrite',
        writableRoots: [this.options.config.persona_dir],
        networkAccess: true,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };
    }
    return { type: 'dangerFullAccess' };
  }

  private textInput(text: string): Record<string, JsonValue> {
    return { type: 'text', text, text_elements: [] };
  }

  private getThreadId(value: unknown): string | null {
    const record = this.asRecord(value);
    const thread = this.asRecord(record.thread);
    return typeof thread.id === 'string' ? thread.id : null;
  }

  private getTurnId(value: unknown): string | null {
    const record = this.asRecord(value);
    const turn = this.asRecord(record.turn);
    return typeof turn.id === 'string' ? turn.id : null;
  }

  private extractResponseText(turn: TurnRecord): string {
    if (!Array.isArray(turn.items)) return '';
    return turn.items
      .filter((item) => item?.type === 'agentMessage' && typeof item.text === 'string')
      .map((item) => item.text!)
      .join('\n\n');
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' ? value as Record<string, unknown> : {};
  }

  private numberField(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  }

  private isToolLikeMethod(method: string): boolean {
    const normalized = method.toLowerCase();
    return (
      normalized.includes('/tool') ||
      normalized.includes('/commandexecution') ||
      normalized.includes('/mcp')
    );
  }

  private isToolLikeItem(item: Record<string, unknown>): boolean {
    const type = item.type;
    if (typeof type !== 'string') return false;
    const normalized = type.toLowerCase();
    return (
      normalized.includes('tool') ||
      normalized.includes('command') ||
      normalized.includes('mcp')
    );
  }

  private summarize(value: unknown): string {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if (typeof record.message === 'string') return record.message;
      if (typeof record.description === 'string') return record.description;
    }
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  private preview(text: string): string {
    return text.replace(/\s+/g, ' ').trim().slice(0, 80).replace(/"/g, '\\"');
  }
}
