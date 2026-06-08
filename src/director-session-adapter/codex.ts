import { CodexDirectorRuntime } from '../director-runtime/codex.js';
import type { CodexTurnCloseEvent } from '../director-runtime/index.js';
import type { DirectorSessionAdapter, DirectorSessionAdapterHooks, DirectorSessionAdapterOptions } from './index.js';

function getNumericField(record: Record<string, unknown>, ...keys: string[]): number {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return 0;
}

function summarizeFailure(event: CodexTurnCloseEvent): string {
  const parts: string[] = [];

  if (event.lastErrorMessage) {
    parts.push(event.lastErrorMessage);
  }

  if (event.stderrTail && event.stderrTail.length > 0) {
    const stderrSummary = event.stderrTail.join(' | ');
    if (!parts.includes(stderrSummary)) {
      parts.push(`stderr: ${stderrSummary}`);
    }
  }

  if (event.recentLines && event.recentLines.length > 0) {
    const recentSummary = event.recentLines.join(' | ');
    parts.push(`recent events: ${recentSummary}`);
  }

  return parts.join(' | ');
}

function isUnrecoverableSessionFailure(event: CodexTurnCloseEvent): boolean {
  const texts = [event.lastErrorMessage, ...(event.recentLines ?? []), ...(event.stderrTail ?? [])]
    .filter((value): value is string => typeof value === 'string');
  return texts.some((value) =>
    value.includes('invalid_prompt') ||
    value.includes('Invalid Responses API request') ||
    value.includes('no rollout found'),
  );
}

function isToolLikeItem(item: unknown): boolean {
  if (!item || typeof item !== 'object') return false;
  const type = (item as { type?: unknown }).type;
  if (typeof type !== 'string') return false;
  const normalized = type.toLowerCase();
  return (
    normalized.includes('tool') ||
    normalized.includes('command') ||
    normalized.includes('mcp')
  );
}

function getStringField(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function getToolNameFromItem(item: unknown): string | undefined {
  if (!item || typeof item !== 'object') return undefined;
  const record = item as Record<string, unknown>;
  const direct = getStringField(record, 'name', 'tool_name', 'toolName', 'command', 'method');
  if (direct) return direct;
  const nestedCandidates = ['tool', 'function', 'call'];
  for (const key of nestedCandidates) {
    const nested = record[key];
    if (nested && typeof nested === 'object') {
      const nestedName = getStringField(nested as Record<string, unknown>, 'name', 'tool_name', 'toolName');
      if (nestedName) return nestedName;
    }
  }
  return undefined;
}

export class CodexSessionAdapter implements DirectorSessionAdapter {
  private runtime: CodexDirectorRuntime;
  private readonly label: string;
  private lastUsageInputTokens: number | null = null;
  private seedRestoredUsageBaseline = false;

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
        getRuntimeEnv: () => this.hooks.getRuntimeEnv(),
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
    this.lastUsageInputTokens = null;
    this.seedRestoredUsageBaseline = Boolean(restored.sessionId);
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
        if (this.hooks.getSessionId() !== event.thread_id) {
          this.lastUsageInputTokens = null;
          this.seedRestoredUsageBaseline = false;
        }
        this.hooks.persistSession(event.thread_id, sessionName);
      } else if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
        this.hooks.onPartialAgentMessage(event.item.text);
      } else if (event.type === 'item.completed' && isToolLikeItem(event.item)) {
        this.hooks.onToolCall(getToolNameFromItem(event.item));
      } else if (event.type === 'turn.completed') {
        const usage = event.usage;
        if (usage && typeof usage === 'object') {
          const usageRecord = usage as Record<string, unknown>;
          const inputTokens = getNumericField(usageRecord, 'input_tokens', 'inputTokens');
          let contextInput = 0;
          if (inputTokens > 0) {
            if (this.seedRestoredUsageBaseline && this.lastUsageInputTokens === null) {
              this.lastUsageInputTokens = inputTokens;
              this.seedRestoredUsageBaseline = false;
            } else {
              contextInput = this.lastUsageInputTokens !== null && inputTokens >= this.lastUsageInputTokens
                ? inputTokens - this.lastUsageInputTokens
                : inputTokens;
              this.lastUsageInputTokens = inputTokens;
              this.seedRestoredUsageBaseline = false;
            }
          }
          const contextWindow = getNumericField(
            usageRecord,
            'model_context_window',
            'context_window',
            'contextWindow',
          );

          if (contextInput > 0 || contextWindow > 0) {
            this.hooks.onMetrics({
              ...(contextInput > 0
                ? {
                    lastInputTokens: contextInput,
                    contextTokens: contextInput,
                  }
                : {}),
              ...(contextWindow > 0 ? { contextWindow } : {}),
            });
          }
        }
      }
    } catch {
      // ignore malformed line
    }
  }

  private handleClose(event: CodexTurnCloseEvent): void {
    if (event.code !== 0 || !event.sawTurnCompleted) {
      if (isUnrecoverableSessionFailure(event)) {
        this.hooks.clearSession();
      }
      const base = `codex exited with code ${event.code ?? 'null'}`;
      const summary = summarizeFailure(event);
      const message = summary ? `${base}: ${summary}` : base;
      this.hooks.onTurnFailure(message);
      return;
    }
    this.hooks.onTurnComplete({
      responseText: event.currentResponse.trim(),
      durationMs: Date.now() - event.startedAt,
    });
  }
}
