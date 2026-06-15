import { spawn, type ChildProcess } from 'child_process';
import { createInterface } from 'readline';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import type { DirectorRuntimeStatus, DirectorSendResult } from './index.js';
import type { Config } from '../config.js';
import { buildCodexMcpOverrideArgs, type AgentRuntimeConfig } from '../persona-process.js';
import { PERSONA_DYNAMIC_TOOLS } from '../persona-dynamic-tools.js';
import { normalizeDirectorInput, type DirectorInputAttachment, type DirectorSendInput } from '../director-input.js';

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
  _ts?: string;
}

interface JsonRpcServerRequest {
  jsonrpc?: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
  _ts?: string;
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

export interface CodexAppServerRuntimeHooks {
  getSessionId(): string | null;
  getSessionName(): string | null;
  getRuntimeEnv(): Record<string, string>;
  setSessionName(name: string): void;
  buildSessionName(): string;
  persistSession(sessionId: string, sessionName: string | null): void;
  clearSession(): void;
  logOutput(line: string): void;
  onChunk(text: string): void;
  onToolCall(toolName?: string, tool?: RuntimeToolCall): void;
  onPartialAgentMessage(text: string): void;
  onWorkflowEvent?(event: RuntimeWorkflowEvent): void;
  onMetrics(update: { lastInputTokens?: number; contextTokens?: number; contextWindow?: number }): void;
  onTurnComplete(result: { responseText: string; durationMs: number | null }): void;
  onTurnFailure(message: string): void;
  onRuntimeClosed(): Promise<void> | void;
  onDynamicToolCall?(call: {
    tool: string;
    namespace?: string | null;
    arguments: unknown;
    threadId: string;
    turnId: string;
    callId: string;
  }): Promise<{ success: boolean; text: string }> | { success: boolean; text: string };
}

export interface RuntimeToolCall {
  id?: string;
  name: string;
  input?: string;
  result?: string;
  isError?: boolean;
  timestamp?: number;
  status?: 'running' | 'completed' | 'failed';
}

export type RuntimeWorkflowEvent =
  | { type: 'goal_updated'; turnId: string; goal: { objective?: string; status?: string; tokensUsed?: number; timeUsedSeconds?: number }; timestamp?: string }
  | { type: 'plan_updated'; turnId: string; plan: Array<{ step?: string; status?: string }>; explanation?: string | null; timestamp?: string };

export interface CodexAppServerRuntimeOptions {
  label: string;
  logDir: string;
  config: Config['director'];
  agent: AgentRuntimeConfig;
  personaRole: string;
  workspaceName?: string;
  workspaceContextPath?: string;
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
  private liveToolOutputs = new Map<string, string>();
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

  private isTransportReady(): boolean {
    return Boolean(this.child?.pid && !this.child.killed && this.initialized);
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

  async send(input: DirectorSendInput): Promise<DirectorSendResult> {
    const directorInput = normalizeDirectorInput(input);
    const turnInput = this.buildTurnInput(directorInput.text, directorInput.attachments);

    if (!this.isTransportReady()) {
      throw new Error('codex app-server is not ready');
    }

    if (!this.threadReady || !this.hooks.getSessionId()) {
      await this.startFreshThread();
    }

    const threadId = this.hooks.getSessionId();
    if (!threadId) {
      throw new Error('codex app-server thread is not initialized');
    }

    if (this.activeTurnId) {
      await this.request('turn/steer', {
        threadId,
        expectedTurnId: this.activeTurnId,
        input: turnInput,
      });
      return 'steered';
    }

    this.activeResponse = '';
    this.activeDeltaCount = 0;
    this.currentTurnStartedAt = Date.now();
    const result = await this.request('turn/start', {
      threadId,
      input: turnInput,
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
    this.notify('initialized');
    this.initialized = true;

    if (restoredSession) {
      try {
        const resumed = await this.request('thread/resume', {
          threadId: restoredSession,
          ...this.threadOptions(),
        });
        const threadId = this.getThreadId(resumed) ?? restoredSession;
        this.hooks.persistSession(threadId, sessionName);
        await this.setThreadName(threadId, sessionName);
        this.threadReady = true;
        return false;
      } catch (err) {
        console.warn(`[bridge:${this.options.label}] Codex app-server resume failed, starting new thread: ${String(err)}`);
        this.hooks.clearSession();
      }
    }

    await this.startFreshThread();
    return true;
  }

  private async startFreshThread(): Promise<void> {
    const sessionName = this.hooks.getSessionName() ?? this.hooks.buildSessionName();
    if (!this.hooks.getSessionName()) this.hooks.setSessionName(sessionName);

    const started = await this.request('thread/start', {
      ...this.threadOptions(),
      ephemeral: this.options.agent.ephemeral ?? false,
    });
    const threadId = this.getThreadId(started);
    if (!threadId) throw new Error('codex app-server thread/start did not return a thread id');
    this.hooks.persistSession(threadId, sessionName);
    await this.setThreadName(threadId, sessionName);
    this.threadReady = true;
  }

  private spawnChild(): void {
    if (!existsSync(this.options.logDir)) mkdirSync(this.options.logDir, { recursive: true });
    const stderrPath = join(this.options.logDir, 'codex-app-server-stderr.log');
    const stderrDir = dirname(stderrPath);
    if (!existsSync(stderrDir)) mkdirSync(stderrDir, { recursive: true });
    const stderrFd = openSync(stderrPath, 'a');

    const args = this.buildSpawnArgs();
    const child = spawn(this.options.agent.command, args, {
      detached: true,
      stdio: ['pipe', 'pipe', stderrFd],
      cwd: this.runtimeCwd(),
      env: { ...process.env, ...this.hooks.getRuntimeEnv(), NO_COLOR: '1' },
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

  private buildSpawnArgs(): string[] {
    const mcpEnvOverrides = this.hooks.getRuntimeEnv();
    return [
      'app-server',
      ...(this.options.agent.mcp_mode === 'mcp'
        ? buildCodexMcpOverrideArgs(join(this.options.config.persona_dir, '.mcp.json'), mcpEnvOverrides)
        : []),
      '--listen',
      'stdio://',
    ];
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

  private notify(method: string, params?: unknown): void {
    const child = this.child;
    if (!child?.stdin || child.stdin.destroyed) return;
    const payload = params === undefined
      ? { jsonrpc: '2.0', method }
      : { jsonrpc: '2.0', method, params };
    const line = JSON.stringify(payload);
    this.hooks.logOutput(line);
    child.stdin.write(line + '\n');
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    this.hooks.logOutput(line);

    let msg: JsonRpcResponse | JsonRpcNotification | JsonRpcServerRequest;
    try {
      msg = JSON.parse(line) as JsonRpcResponse | JsonRpcNotification;
    } catch {
      return;
    }

    if ('method' in msg) {
      if ('id' in msg) {
        this.handleServerRequest(msg as JsonRpcServerRequest);
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
    if (this.isToolLikeMethod(msg.method) && msg.method !== 'item/commandExecution/outputDelta') {
      this.hooks.onToolCall(this.extractToolName(params) ?? this.extractToolNameFromMethod(msg.method));
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
          this.liveToolOutputs.clear();
          console.log(`[codex-live:${this.options.label}] turn started id=${turnId}`);
        }
        break;
      }
      case 'item/started': {
        const item = this.asRecord(params.item);
        if (this.isToolLikeItem(item)) {
          const tool = this.extractToolCall(item, msg._ts);
          if (tool?.id) this.liveToolOutputs.set(tool.id, '');
          this.hooks.onToolCall(tool?.name ?? this.extractToolName(item), tool ? { ...tool, status: 'running', result: undefined, isError: undefined } : undefined);
        }
        break;
      }
      case 'item/commandExecution/outputDelta': {
        const tool = this.extractCommandExecutionDelta(params, msg._ts);
        if (tool) this.hooks.onToolCall(tool.name, tool);
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
          const tool = this.extractToolCall(item, msg._ts);
          if (tool?.id) this.liveToolOutputs.delete(tool.id);
          this.hooks.onToolCall(tool?.name ?? this.extractToolName(item), tool);
        }
        break;
      }
      case 'turn/completed': {
        this.handleTurnCompleted(params);
        break;
      }
      case 'thread/goal/updated': {
        const event = this.extractGoalEvent(params, msg._ts);
        if (event) this.hooks.onWorkflowEvent?.(event);
        break;
      }
      case 'turn/plan/updated': {
        const event = this.extractPlanEvent(params, msg._ts);
        if (event) this.hooks.onWorkflowEvent?.(event);
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
        this.liveToolOutputs.clear();
        break;
      }
      default:
        break;
    }
  }

  private handleServerRequest(msg: JsonRpcServerRequest): void {
    const child = this.child;
    if (!child?.stdin || msg.id === undefined) return;
    if (this.isToolLikeMethod(msg.method)) {
      this.hooks.onToolCall(this.extractToolName(this.asRecord(msg.params)) ?? this.extractToolNameFromMethod(msg.method));
    }

    if (msg.method === 'item/tool/call') {
      void this.handleDynamicToolCall(msg);
      return;
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

  private async handleDynamicToolCall(msg: JsonRpcServerRequest): Promise<void> {
    const child = this.child;
    if (!child?.stdin || msg.id === undefined) return;
    const params = this.asRecord(msg.params);
    const tool = typeof params.tool === 'string' ? params.tool : '';
    const threadId = typeof params.threadId === 'string' ? params.threadId : '';
    const turnId = typeof params.turnId === 'string' ? params.turnId : '';
    const callId = typeof params.callId === 'string' ? params.callId : '';
    const namespace = typeof params.namespace === 'string' ? params.namespace : null;
    const args = params.arguments;

    let result: { success: boolean; text: string };
    try {
      if (!tool || !threadId || !turnId || !callId) {
        throw new Error('invalid dynamic tool call params');
      }
      const handler = this.hooks.onDynamicToolCall;
      if (!handler) throw new Error(`Unsupported dynamic tool: ${tool}`);
      result = await handler({ tool, namespace, arguments: args, threadId, turnId, callId });
    } catch (err) {
      result = { success: false, text: err instanceof Error ? err.message : String(err) };
    }

    const response = {
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        success: result.success,
        contentItems: [{ type: 'inputText', text: result.text }],
      },
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
    const last = this.asRecord(tokenUsage.last);
    // `total` is cumulative thread usage; `last.inputTokens` is the current request
    // size and already includes cached input tokens.
    const lastInput = this.numberField(last.inputTokens);
    const contextWindow = this.numberField(tokenUsage.modelContextWindow);
    this.hooks.onMetrics({
      ...(lastInput > 0 ? { lastInputTokens: lastInput } : {}),
      ...(lastInput > 0 ? { contextTokens: lastInput } : {}),
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
    return {
      cwd: this.runtimeCwd(),
      approvalPolicy: this.options.agent.approval ?? 'never',
      sandbox: this.options.agent.sandbox ?? 'danger-full-access',
      ...(this.options.agent.model ? { model: this.options.agent.model } : {}),
      baseInstructions: this.readPromptSections(['soul.md', 'meta.md']),
      developerInstructions: this.readDeveloperInstructions(),
      sessionStartSource: 'startup',
      threadSource: 'user',
      ...(this.options.agent.mcp_mode === 'dynamic' ? { dynamicTools: this.dynamicTools() } : {}),
    };
  }

  private dynamicTools(): Array<Record<string, unknown>> {
    return PERSONA_DYNAMIC_TOOLS;
  }

  private runtimeCwd(): string {
    return this.options.agent.cwd ?? this.options.config.persona_dir;
  }

  private async setThreadName(threadId: string, sessionName: string | null): Promise<void> {
    if (!sessionName) return;
    await this.request('thread/name/set', { threadId, name: sessionName }).catch(() => undefined);
  }

  private readDeveloperInstructions(): string {
    const files = [`personas/${this.options.personaRole}.md`];
    if (this.options.agent.system_prompt_file) files.unshift(this.options.agent.system_prompt_file);
    return [
      this.readPromptSections(files),
      this.readWorkspaceContextInstructions(),
    ].filter(Boolean).join('\n\n');
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

  private readWorkspaceContextInstructions(): string {
    const contextPath = this.options.workspaceContextPath;
    if (!contextPath) return '';
    const context = this.readAbsoluteFile(contextPath);
    return [
      '# Persona Workspace Context',
      '',
      `当前 workspace：${this.options.workspaceName ?? 'unknown'}`,
      `上下文文件：${contextPath}`,
      '',
      '这个文件是当前 workspace 的持久工作记忆。重要状态变更时必须主动更新它，不要只等 flush。',
      '',
      context
        ? `## context.md\n${context}`
        : '## context.md\n（当前上下文文件为空。）',
    ].join('\n');
  }

  private readAbsoluteFile(path: string): string {
    if (!path || !existsSync(path)) return '';
    try {
      return readFileSync(path, 'utf-8').trim();
    } catch {
      return '';
    }
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

  private buildTurnInput(text: string, attachments: DirectorInputAttachment[] | undefined): Record<string, JsonValue>[] {
    const input: Record<string, JsonValue>[] = [];
    if (text.trim()) input.push(this.textInput(text));

    for (const attachment of attachments ?? []) {
      if (attachment.type === 'image') {
        input.push({
          type: 'localImage',
          path: attachment.path,
          detail: attachment.detail ?? 'high',
        });
        continue;
      }
      input.push(this.textInput(`附件：${attachment.name ?? attachment.path}
路径：${attachment.path}`));
    }

    if (input.length === 0) input.push(this.textInput(''));
    return input;
  }

  private textInput(text: string): Record<string, JsonValue> {
    return { type: 'text', text, text_elements: [] };
  }

  private getThreadId(value: unknown): string | null {
    const record = this.asRecord(value);
    if (typeof record.threadId === 'string') return record.threadId;
    const thread = this.asRecord(record.thread);
    return typeof thread.id === 'string' ? thread.id : null;
  }

  private getTurnId(value: unknown): string | null {
    const record = this.asRecord(value);
    if (typeof record.turnId === 'string') return record.turnId;
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

  private extractToolName(value: unknown): string | undefined {
    const record = this.asRecord(value);
    const direct = this.stringField(record, 'name', 'tool_name', 'toolName', 'command', 'method');
    if (direct) return direct;
    const nestedKeys = ['tool', 'function', 'call', 'item'];
    for (const key of nestedKeys) {
      const nested = record[key];
      if (nested && typeof nested === 'object') {
        const nestedName = this.stringField(nested as Record<string, unknown>, 'name', 'tool_name', 'toolName');
        if (nestedName) return nestedName;
      }
    }
    return undefined;
  }

  private stringifyPreview(value: unknown, maxLength = 900): string | undefined {
    if (value == null) return undefined;
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    const trimmed = text.trim();
    if (!trimmed) return undefined;
    return trimmed.length > maxLength ? trimmed.slice(0, maxLength) + '…' : trimmed;
  }

  private timestampMs(timestamp?: unknown): number | undefined {
    if (typeof timestamp !== 'string') return undefined;
    const ms = new Date(timestamp).getTime();
    return Number.isFinite(ms) ? ms : undefined;
  }

  private workflowEventId(params: Record<string, unknown>, nested?: Record<string, unknown>): string | null {
    return this.getTurnId(params)
      ?? (nested ? this.stringField(nested, 'turnId', 'turn_id') : undefined)
      ?? this.activeTurnId
      ?? this.getThreadId(params)
      ?? (nested ? this.stringField(nested, 'threadId', 'thread_id') : undefined)
      ?? null;
  }

  private extractGoalEvent(params: Record<string, unknown>, timestamp?: unknown): RuntimeWorkflowEvent | undefined {
    const goalRecord = this.asRecord(params.goal);
    const turnId = this.workflowEventId(params, goalRecord);
    if (!turnId) return undefined;
    return {
      type: 'goal_updated',
      turnId,
      goal: {
        objective: this.stringField(goalRecord, 'objective'),
        status: this.stringField(goalRecord, 'status'),
        tokensUsed: typeof goalRecord.tokensUsed === 'number' ? goalRecord.tokensUsed : undefined,
        timeUsedSeconds: typeof goalRecord.timeUsedSeconds === 'number' ? goalRecord.timeUsedSeconds : undefined,
      },
      timestamp: typeof timestamp === 'string' ? timestamp : undefined,
    };
  }

  private extractPlanEvent(params: Record<string, unknown>, timestamp?: unknown): RuntimeWorkflowEvent | undefined {
    const turnId = this.workflowEventId(params);
    if (!turnId) return undefined;
    const rawPlan = Array.isArray(params.plan) ? params.plan : [];
    const plan = rawPlan.map((item) => {
      const record = this.asRecord(item);
      return {
        step: this.stringField(record, 'step'),
        status: this.stringField(record, 'status'),
      };
    });
    return {
      type: 'plan_updated',
      turnId,
      plan,
      explanation: typeof params.explanation === 'string' ? params.explanation : null,
      timestamp: typeof timestamp === 'string' ? timestamp : undefined,
    };
  }

  private extractCommandExecutionDelta(params: Record<string, unknown>, timestamp?: unknown): RuntimeToolCall | undefined {
    const itemId = this.stringField(params, 'itemId', 'item_id', 'id');
    const delta = typeof params.delta === 'string' ? params.delta : '';
    if (!itemId || !delta) return undefined;
    const next = (this.liveToolOutputs.get(itemId) ?? '') + delta;
    this.liveToolOutputs.set(itemId, next);
    return {
      id: itemId,
      name: 'Bash',
      result: this.stringifyPreview(next, 4000),
      status: 'running',
      timestamp: this.timestampMs(timestamp),
    };
  }

  private extractToolCall(item: Record<string, unknown>, timestamp?: unknown): RuntimeToolCall | undefined {
    const type = this.stringField(item, 'type');
    if (type === 'commandExecution' || type === 'command_execution') {
      const command = this.stringField(item, 'command') ?? '';
      const cwd = this.stringField(item, 'cwd');
      const status = this.stringField(item, 'status');
      const exitCode = item.exitCode ?? item.exit_code;
      const output = this.stringField(item, 'aggregatedOutput', 'aggregated_output');
      return {
        id: this.stringField(item, 'id'),
        name: 'Bash',
        input: this.stringifyPreview({ command, ...(cwd ? { cwd } : {}) }),
        result: this.stringifyPreview({
          ...(status ? { status } : {}),
          ...(exitCode != null ? { exitCode } : {}),
          ...(output ? { output } : {}),
        }, 1200),
        isError: typeof exitCode === 'number' ? exitCode !== 0 : status === 'failed',
        status: typeof exitCode === 'number' ? (exitCode === 0 ? 'completed' : 'failed') : (status === 'failed' ? 'failed' : status === 'completed' ? 'completed' : undefined),
        timestamp: this.timestampMs(timestamp),
      };
    }

    if (type === 'fileChange' || type === 'file_change') {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const status = this.stringField(item, 'status');
      return {
        id: this.stringField(item, 'id'),
        name: 'File change',
        input: this.stringifyPreview(changes),
        result: this.stringifyPreview({ status }),
        isError: status === 'failed',
        status: status === 'failed' ? 'failed' : status === 'completed' ? 'completed' : undefined,
        timestamp: this.timestampMs(timestamp),
      };
    }

    const name = this.extractToolName(item);
    return name ? {
      id: this.stringField(item, 'id'),
      name,
      input: this.stringifyPreview(item.input),
      result: this.stringifyPreview(item.result),
      timestamp: this.timestampMs(timestamp),
    } : undefined;
  }

  private extractToolNameFromMethod(method: string): string | undefined {
    const normalized = method.toLowerCase();
    if (normalized.includes('commandexecution')) return 'Bash';
    if (normalized.includes('filechange')) return 'File change';
    const parts = method.split('/').filter(Boolean);
    for (let idx = parts.length - 1; idx >= 0; idx -= 1) {
      if (/tool|command|mcp/i.test(parts[idx])) return parts[idx];
    }
    return undefined;
  }

  private stringField(record: Record<string, unknown>, ...keys: string[]): string | undefined {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return undefined;
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
