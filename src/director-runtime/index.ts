import type { Config } from '../config.js';
import type { AgentRuntimeConfig } from '../persona-process.js';

export interface DirectorRuntimeStatus {
  kind: 'claude-daemon' | 'codex-turn-based' | 'kimi-daemon';
  alive: boolean;
  pid: number | null;
}

export interface CodexTurnCloseEvent {
  code: number | null;
  startedAt: number;
  currentResponse: string;
  sawTurnCompleted: boolean;
  lastErrorMessage?: string;
  recentLines?: string[];
  stderrTail?: string[];
}

export interface CodexTurnRuntimeHooks {
  getSessionId(): string | null;
  getSessionName(): string | null;
  setSessionName(name: string): void;
  buildSessionName(): string;
  onLine(line: string, sessionName: string): void;
  onClose(event: CodexTurnCloseEvent): void;
  onSpawnFailure(message: string): void;
}

export interface DirectorRuntimeOptions {
  label: string;
  logDir: string;
  config: Config['director'];
  agent: AgentRuntimeConfig;
}
