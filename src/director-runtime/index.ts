import type { Config } from '../config.js';
import type { AgentRuntimeConfig } from '../persona-process.js';

export interface DirectorRuntimeStatus {
  kind: 'claude-daemon' | 'codex-app-server' | 'kimi-daemon';
  alive: boolean;
  pid: number | null;
}

export type DirectorSendResult = 'started' | 'steered';

export interface DirectorRuntimeOptions {
  label: string;
  logDir: string;
  config: Config['director'];
  agent: AgentRuntimeConfig;
}
