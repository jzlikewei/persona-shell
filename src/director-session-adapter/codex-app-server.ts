import { CodexAppServerRuntime } from '../director-runtime/codex-app-server.js';
import type { DirectorSessionAdapter, DirectorSessionAdapterHooks, DirectorSessionAdapterOptions } from './index.js';
import type { DirectorSendResult } from '../director-runtime/index.js';

export class CodexAppServerSessionAdapter implements DirectorSessionAdapter {
  private runtime: CodexAppServerRuntime;

  constructor(
    private readonly options: DirectorSessionAdapterOptions,
    private readonly hooks: DirectorSessionAdapterHooks,
  ) {
    this.runtime = new CodexAppServerRuntime(
      {
        label: options.label,
        logDir: options.logDir,
        config: options.config,
        agent: options.directorAgent,
        personaRole: options.personaRole ?? 'director',
        workspaceName: options.workspaceName,
        workspaceContextPath: options.workspaceContextPath,
      },
      {
        getSessionId: () => this.hooks.getSessionId(),
        getSessionName: () => this.hooks.getSessionName(),
        getRuntimeEnv: () => this.hooks.getRuntimeEnv(),
        setSessionName: (name) => this.hooks.setSessionName(name),
        buildSessionName: () => this.hooks.buildSessionName(),
        persistSession: (sessionId, sessionName) => this.hooks.persistSession(sessionId, sessionName),
        clearSession: () => this.hooks.clearSession(),
        logOutput: (line) => this.hooks.logOutput(line),
        onChunk: (text) => this.hooks.onChunk(text),
        onToolCall: (toolName, tool) => this.hooks.onToolCall(toolName, tool),
        onPartialAgentMessage: (text) => this.hooks.onPartialAgentMessage(text),
        onWorkflowEvent: (event) => this.hooks.onWorkflowEvent?.(event),
        onMetrics: (update) => this.hooks.onMetrics(update),
        onTurnComplete: (result) => this.hooks.onTurnComplete(result),
        onTurnFailure: (message) => this.hooks.onTurnFailure(message),
        onRuntimeClosed: () => this.hooks.onRuntimeClosed(),
        onDynamicToolCall: (call) => this.hooks.onDynamicToolCall?.(call) ?? { success: false, text: `Unsupported dynamic tool: ${call.tool}` },
      },
    );
  }

  async start(): Promise<boolean> {
    const restored = this.hooks.restorePersistedSession();
    if (restored.sessionName) this.hooks.setSessionName(restored.sessionName);
    return this.runtime.start();
  }

  isReady(): boolean {
    return this.runtime.isReady();
  }

  getStatus() {
    return this.runtime.getStatus();
  }

  hasActiveTurn(): boolean {
    return this.runtime.hasActiveTurn();
  }

  async send(content: string): Promise<DirectorSendResult> {
    return this.runtime.send(content);
  }

  async stop(): Promise<void> {
    await this.runtime.stop();
  }

  terminate(signal: NodeJS.Signals): void {
    this.runtime.terminate(signal);
  }

  interrupt(): void {
    this.runtime.interrupt();
  }

  async prepareShutdown(): Promise<boolean> {
    return this.runtime.hasActiveTurn();
  }

  async restartTransport(): Promise<void> {
    await this.runtime.restart();
  }

  describeSessionReady(label: string, sessionId: string | null, sessionName: string | null): string {
    if (sessionId) {
      return `[bridge:${label}] Codex app-server session ready${sessionName ? ` (${sessionName})` : ''}`;
    }
    return `[bridge:${label}] Codex app-server session ready (new)`;
  }

  describeInterruptTarget(): string | null {
    const pid = this.runtime.getStatus().pid;
    return pid ? `(pid: ${pid})` : null;
  }

  shouldSkipInterruptWhileFlushing(): boolean {
    return false;
  }

  shouldTrackRestartBackoff(): boolean {
    return true;
  }
}
