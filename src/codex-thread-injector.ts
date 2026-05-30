import { spawn, type ChildProcess } from 'child_process';
import { createInterface } from 'readline';
import { existsSync, mkdirSync, openSync, closeSync } from 'fs';
import { dirname, join } from 'path';
import type { AgentProviderConfig, Config } from './config.js';

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

export interface CodexThreadInjectionInput {
  threadId: string;
  text: string;
  cwd?: string;
  timeoutMs?: number;
  waitForCompletion?: boolean;
}

export interface CodexThreadInjectionResult {
  ok: true;
  threadId: string;
  turnId: string | null;
  responseText: string;
}

export interface CodexThreadInjectorOptions {
  logDir: string;
  directorConfig: Config['director'];
  agent: Pick<AgentProviderConfig, 'command' | 'model' | 'approval' | 'sandbox'>;
}

export class CodexThreadInjector {
  private child: ChildProcess | null = null;
  private pending = new Map<number | string, PendingRequest>();
  private requestId = 0;
  private activeTurnId: string | null = null;
  private activeResponse = '';
  private turnCompleteResolve: ((value: CodexThreadInjectionResult) => void) | null = null;
  private turnCompleteReject: ((error: Error) => void) | null = null;
  private turnCompleteTimer: ReturnType<typeof setTimeout> | null = null;
  private currentThreadId: string | null = null;

  constructor(private readonly options: CodexThreadInjectorOptions) {}

  async injectUserMessage(input: CodexThreadInjectionInput): Promise<CodexThreadInjectionResult> {
    const threadId = input.threadId.trim();
    if (!threadId) throw new Error('threadId is required');
    if (!input.text.trim()) throw new Error('text is required');

    const timeoutMs = input.timeoutMs ?? 180_000;
    this.currentThreadId = threadId;
    this.activeTurnId = null;
    this.activeResponse = '';
    this.spawnChild(input.cwd);

    try {
      await this.request('initialize', {
        clientInfo: {
          name: 'persona-shell-codex-thread-injector',
          title: 'persona-shell Codex thread injector',
          version: '0.1.0',
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          optOutNotificationMethods: [],
        },
      }, timeoutMs);

      await this.request('thread/resume', {
        threadId,
        cwd: input.cwd ?? this.options.directorConfig.persona_dir,
        approvalPolicy: this.options.agent.approval ?? 'never',
        sandbox: this.options.agent.sandbox ?? 'danger-full-access',
        ...(this.options.agent.model ? { model: this.options.agent.model } : {}),
        sessionStartSource: 'external',
        threadSource: 'user',
      }, timeoutMs);

      if (input.waitForCompletion !== true) {
        await this.request('thread/inject_items', {
          threadId,
          items: [this.responsesUserMessage(input.text)],
        }, timeoutMs);
        return {
          ok: true,
          threadId,
          turnId: null,
          responseText: '',
        };
      }

      const turnPromise = this.waitForTurnCompletion(threadId, timeoutMs);
      const started = await this.request('turn/start', {
        threadId,
        input: [this.textInput(input.text)],
        approvalPolicy: this.options.agent.approval ?? 'never',
        sandboxPolicy: this.toSandboxPolicy(this.options.agent.sandbox, input.cwd),
        ...(this.options.agent.model ? { model: this.options.agent.model } : {}),
      }, timeoutMs);
      const turnId = this.getTurnId(started);
      if (turnId) this.activeTurnId = turnId;
      return await turnPromise;
    } finally {
      await this.stop();
    }
  }

  private spawnChild(cwd?: string): void {
    if (!existsSync(this.options.logDir)) mkdirSync(this.options.logDir, { recursive: true });
    const stderrPath = join(this.options.logDir, 'codex-thread-injector-stderr.log');
    const stderrDir = dirname(stderrPath);
    if (!existsSync(stderrDir)) mkdirSync(stderrDir, { recursive: true });
    const stderrFd = openSync(stderrPath, 'a');

    const child = spawn(this.options.agent.command, ['app-server', '--listen', 'stdio://'], {
      detached: true,
      stdio: ['pipe', 'pipe', stderrFd],
      cwd: cwd ?? this.options.directorConfig.persona_dir,
      env: { ...process.env, DIRECTOR_LABEL: 'codex-thread-injector', NO_COLOR: '1' },
    });
    closeSync(stderrFd);
    child.unref();
    this.child = child;

    if (!child.stdin || !child.stdout) {
      throw new Error('failed to spawn codex app-server stdio process');
    }

    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => this.handleLine(line));
    child.on('error', (err) => this.rejectAll(`codex thread injector error: ${err.message}`));
    child.on('close', () => {
      this.rejectAll('codex thread injector closed');
      this.rejectTurn(new Error('codex thread injector closed before turn completed'));
    });
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const child = this.child;
    if (!child?.stdin || child.stdin.destroyed) {
      return Promise.reject(new Error('codex app-server stdin is closed'));
    }

    const id = ++this.requestId;
    const payload = { jsonrpc: '2.0', id, method, params };
    child.stdin.write(JSON.stringify(payload) + '\n');

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
    });
  }

  private waitForTurnCompletion(threadId: string, timeoutMs: number): Promise<CodexThreadInjectionResult> {
    return new Promise((resolve, reject) => {
      this.turnCompleteResolve = resolve;
      this.turnCompleteReject = reject;
      this.turnCompleteTimer = setTimeout(() => {
        this.turnCompleteResolve = null;
        this.turnCompleteReject = null;
        reject(new Error('timeout waiting for injected Codex turn completion'));
      }, timeoutMs);
      this.currentThreadId = threadId;
    });
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let msg: JsonRpcResponse | JsonRpcNotification;
    try {
      msg = JSON.parse(line) as JsonRpcResponse | JsonRpcNotification;
    } catch {
      return;
    }

    if ('method' in msg) {
      if ('id' in msg) this.handleServerRequest(msg);
      else this.handleNotification(msg);
      return;
    }
    if ('id' in msg) this.handleResponse(msg);
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
    switch (msg.method) {
      case 'turn/started': {
        const turnId = this.getTurnId(params);
        if (turnId) this.activeTurnId = turnId;
        break;
      }
      case 'item/agentMessage/delta': {
        const delta = typeof params.delta === 'string' ? params.delta : '';
        if (delta) this.activeResponse += delta;
        break;
      }
      case 'item/completed': {
        const item = this.asRecord(params.item);
        if (item.type === 'agentMessage' && typeof item.text === 'string' && !this.activeResponse) {
          this.activeResponse = item.text;
        }
        break;
      }
      case 'turn/completed':
        this.resolveTurn(params);
        break;
      case 'error':
        this.rejectTurn(new Error(this.summarize(params.error ?? params)));
        break;
      default:
        break;
    }
  }

  private handleServerRequest(msg: JsonRpcNotification): void {
    const child = this.child;
    if (!child?.stdin || msg.id === undefined) return;
    const response = {
      jsonrpc: '2.0',
      id: msg.id,
      result: this.defaultServerRequestResult(msg.method),
    };
    child.stdin.write(JSON.stringify(response) + '\n');
  }

  private resolveTurn(params: Record<string, unknown>): void {
    const turn = this.asRecord(params.turn);
    const turnId = typeof turn.id === 'string' ? turn.id : this.activeTurnId;
    if (this.activeTurnId && turnId && turnId !== this.activeTurnId) return;

    const responseText = this.extractResponseText(turn) || this.activeResponse;
    const resolve = this.turnCompleteResolve;
    if (!resolve) return;
    if (this.turnCompleteTimer) clearTimeout(this.turnCompleteTimer);
    this.turnCompleteResolve = null;
    this.turnCompleteReject = null;
    this.turnCompleteTimer = null;
    resolve({
      ok: true,
      threadId: this.currentThreadId ?? '',
      turnId: turnId ?? null,
      responseText: responseText.trim(),
    });
  }

  private rejectTurn(error: Error): void {
    const reject = this.turnCompleteReject;
    if (!reject) return;
    if (this.turnCompleteTimer) clearTimeout(this.turnCompleteTimer);
    this.turnCompleteResolve = null;
    this.turnCompleteReject = null;
    this.turnCompleteTimer = null;
    reject(error);
  }

  private async stop(): Promise<void> {
    const child = this.child;
    if (!child?.pid) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2_000);
      child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        process.kill(-child.pid!, 'SIGTERM');
      } catch {
        try { child.kill('SIGTERM'); } catch {}
      }
    });
    this.child = null;
  }

  private rejectAll(message: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`${pending.method} failed: ${message}`));
    }
    this.pending.clear();
  }

  private defaultServerRequestResult(method: string): unknown {
    if (method === 'item/commandExecution/requestApproval') return { decision: 'accept' };
    if (method === 'item/fileChange/requestApproval') return { decision: 'accept' };
    if (method === 'item/permissions/requestApproval') return { permissions: {}, scope: 'turn' };
    if (method === 'applyPatchApproval') return { decision: 'accept' };
    if (method === 'execCommandApproval') return { decision: 'accept' };
    if (method === 'item/tool/requestUserInput') return { input: [] };
    if (method === 'mcpServer/elicitation/request') return { action: 'decline' };
    return null;
  }

  private toSandboxPolicy(mode: AgentProviderConfig['sandbox'], cwd?: string): Record<string, JsonValue> {
    if (mode === 'read-only') return { type: 'readOnly', networkAccess: true };
    if (mode === 'workspace-write') {
      return {
        type: 'workspaceWrite',
        writableRoots: [cwd ?? this.options.directorConfig.persona_dir],
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

  private responsesUserMessage(text: string): Record<string, JsonValue> {
    return {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text }],
    };
  }

  private getTurnId(value: unknown): string | null {
    const record = this.asRecord(value);
    const turn = this.asRecord(record.turn);
    return typeof turn.id === 'string' ? turn.id : null;
  }

  private extractResponseText(turn: Record<string, unknown>): string {
    const items = Array.isArray(turn.items) ? turn.items : [];
    return items
      .map((item) => this.asRecord(item))
      .filter((item) => item.type === 'agentMessage' && typeof item.text === 'string')
      .map((item) => item.text as string)
      .join('\n\n');
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' ? value as Record<string, unknown> : {};
  }

  private summarize(value: unknown): string {
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
}
