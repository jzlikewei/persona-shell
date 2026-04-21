import { CodexDirectorRuntime } from '../director-runtime/codex.js';
import type { CodexTurnCloseEvent } from '../director-runtime/index.js';
import type { DirectorSessionAdapter, DirectorSessionAdapterHooks, DirectorSessionAdapterOptions } from './index.js';

export class CodexSessionAdapter implements DirectorSessionAdapter {
  private runtime: CodexDirectorRuntime;
  private readonly label: string;

  constructor(
    options: DirectorSessionAdapterOptions,
    private readonly hooks: DirectorSessionAdapterHooks,
  ) {
    this.label = options.label;
    this.runtime = new CodexDirectorRuntime(
      {
        label: options.label,
        logDir: options.logDir,
        config: options.config,
        agent: options.directorAgent,
      },
      {
        getSessionId: () => this.hooks.getSessionId(),
        getSessionName: () => this.hooks.getSessionName(),
        setSessionName: (name) => this.hooks.setSessionName(name),
        buildSessionName: () => this.hooks.buildSessionName(),
        onLine: (line, sessionName) => this.handleLine(line, sessionName),
        onClose: (event) => this.handleClose(event),
        onSpawnFailure: (message) => this.hooks.onTurnFailure(message),
      },
    );
  }

  async start(): Promise<boolean> {
    const restored = this.hooks.restorePersistedSession();
    if (restored.sessionName) this.hooks.setSessionName(restored.sessionName);
    return !restored.sessionId;
  }

  isReady(): boolean {
    return true;
  }

  getStatus() {
    return this.runtime.getStatus();
  }

  hasActiveTurn(): boolean {
    return this.runtime.hasActiveTurn();
  }

  async send(content: string): Promise<void> {
    this.runtime.send(content);
  }

  async stop(): Promise<void> {
    this.runtime.kill('SIGTERM');
  }

  terminate(signal: NodeJS.Signals): void {
    this.runtime.kill(signal);
  }

  interrupt(): void {
    this.runtime.kill('SIGINT');
  }

  async prepareShutdown(): Promise<boolean> {
    return this.runtime.hasActiveTurn();
  }

  async restartTransport(): Promise<void> {}

  describeSessionReady(label: string, sessionId: string | null, sessionName: string | null): string {
    if (sessionId) {
      return `[bridge:${label}] Codex session ready${sessionName ? ` (${sessionName})` : ''}`;
    }
    return `[bridge:${label}] Codex session ready (new)`;
  }

  describeInterruptTarget(): string | null {
    return null;
  }

  shouldSkipInterruptWhileFlushing(): boolean {
    return false;
  }

  shouldTrackRestartBackoff(): boolean {
    return false;
  }

  private handleLine(line: string, sessionName: string): void {
    this.hooks.logOutput(line);

    try {
      const event = JSON.parse(line);
      if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
        this.hooks.persistSession(event.thread_id, sessionName);
      } else if (event.type === 'turn.completed') {
        const usage = event.usage;
        if (usage && typeof usage === 'object') {
          const contextInput = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
          if (contextInput > 0) {
            this.hooks.onMetrics({ lastInputTokens: contextInput });
          }
        }
      }
    } catch {
      // ignore malformed line
    }
  }

  private handleClose(event: CodexTurnCloseEvent): void {
    if (event.code !== 0 || !event.sawTurnCompleted) {
      const base = `codex exited with code ${event.code ?? 'null'}`;
      const message = event.lastErrorMessage ? `${base}: ${event.lastErrorMessage}` : base;
      this.hooks.onTurnFailure(message);
      return;
    }
    this.hooks.onTurnComplete({
      responseText: event.currentResponse.trim(),
      durationMs: Date.now() - event.startedAt,
    });
  }
}
