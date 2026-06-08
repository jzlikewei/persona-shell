import type { FileHandle } from 'fs/promises';
import type { Config } from '../config.js';
import type { AgentRuntimeConfig } from '../persona-process.js';
import type { DirectorRuntimeStatus, DirectorSendResult } from '../director-runtime/index.js';

export interface DirectorSessionMetricsUpdate {
  lastInputTokens?: number;
  contextTokens?: number;
  contextWindow?: number;
  costUsd?: number;
}

export interface DirectorTurnResult {
  responseText: string;
  durationMs: number | null;
}

export interface DirectorToolCall {
  id?: string;
  name: string;
  input?: string;
  result?: string;
  isError?: boolean;
  timestamp?: number;
  status?: 'running' | 'completed' | 'failed';
}

export interface AssistantTurnEvent {
  type: 'turn_started' | 'assistant_delta' | 'tool_started' | 'tool_completed' | 'turn_completed' | 'turn_failed' | 'turn_aborted';
  director: string;
  sessionId?: string | null;
  turnId: string;
  messageId?: string;
  timestamp: string;
  text?: string;
  content?: string;
  tool?: DirectorToolCall;
  durationMs?: number | null;
  error?: string;
}

export interface RestoredSessionState {
  sessionId: string | null;
  sessionName: string | null;
}

export interface DirectorSessionAdapterHooks {
  restorePersistedSession(): RestoredSessionState;
  persistSession(sessionId: string, sessionName: string | null): void;
  clearSession(): void;
  getSessionId(): string | null;
  getSessionName(): string | null;
  getRuntimeEnv(): Record<string, string>;
  setSessionName(sessionName: string | null): void;
  buildSessionName(): string;
  logOutput(line: string): void;
  onChunk(text: string): void;
  onToolCall(toolName?: string, tool?: DirectorToolCall): void;
  onMetrics(update: DirectorSessionMetricsUpdate): void;
  onPartialAgentMessage(text: string): void;
  onTurnComplete(result: DirectorTurnResult): void;
  onTurnFailure(message: string): void;
  onRuntimeClosed(): Promise<void> | void;
}

export interface DirectorSessionAdapter {
  start(): Promise<boolean>;
  isReady(): boolean;
  getStatus(): DirectorRuntimeStatus;
  hasActiveTurn(): boolean;
  send(content: string): Promise<DirectorSendResult | void>;
  interrupt(): void;
  stop(): Promise<void>;
  terminate(signal: NodeJS.Signals): void;
  prepareShutdown(): Promise<boolean>;
  restartTransport(): Promise<void>;
  describeSessionReady(label: string, sessionId: string | null, sessionName: string | null): string;
  describeInterruptTarget(): string | null;
  shouldSkipInterruptWhileFlushing(): boolean;
  shouldTrackRestartBackoff(): boolean;
}

export interface DirectorSessionAdapterOptions {
  label: string;
  isMain: boolean;
  groupName?: string;
  personaRole?: string;
  config: Config['director'];
  agents: Config['agents'];
  directorAgent: AgentRuntimeConfig;
  logDir: string;
}

export interface ClaudeSessionStreamHooks {
  onLine(line: string): void;
  onClose(): Promise<void> | void;
}

export function attachReadHandle(readHandle: FileHandle, hooks: ClaudeSessionStreamHooks): void {
  const stream = readHandle.createReadStream({ encoding: 'utf-8' });
  stream.on('error', () => {});
  stream.on('close', () => {
    void hooks.onClose();
  });

  let buffer = '';
  stream.on('data', (chunk: string | Buffer) => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    while (true) {
      const idx = buffer.indexOf('\n');
      if (idx === -1) break;
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      hooks.onLine(line);
    }
  });
}
