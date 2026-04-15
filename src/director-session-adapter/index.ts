import type { FileHandle } from 'fs/promises';
import type { Config } from '../config.js';
import type { AgentRuntimeConfig } from '../persona-process.js';
import type { DirectorRuntimeStatus } from '../director-runtime/index.js';

export interface DirectorSessionMetricsUpdate {
  lastInputTokens?: number;
  contextWindow?: number;
  costUsd?: number;
}

export interface DirectorTurnResult {
  responseText: string;
  durationMs: number | null;
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
  setSessionName(sessionName: string | null): void;
  buildSessionName(): string;
  logOutput(line: string): void;
  onChunk(text: string): void;
  onMetrics(update: DirectorSessionMetricsUpdate): void;
  onTurnComplete(result: DirectorTurnResult): void;
  onTurnFailure(message: string): void;
  onRuntimeClosed(): Promise<void> | void;
}

export interface DirectorSessionAdapter {
  start(): Promise<boolean>;
  isReady(): boolean;
  getStatus(): DirectorRuntimeStatus;
  hasActiveTurn(): boolean;
  send(content: string): Promise<void>;
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
