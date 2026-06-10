import { writeFileSync } from 'fs';
import { join } from 'path';
import type { Config } from './config.js';

export interface ShellMcpConfig {
  mcpServers: {
    'persona-tasks': {
      command: 'bun';
      args: string[];
      env: Record<string, string>;
    };
  };
}

export function buildShellMcpConfig(config: Config, taskMcpServerPath: string): ShellMcpConfig {
  return {
    mcpServers: {
      'persona-tasks': {
        command: 'bun',
        args: ['run', taskMcpServerPath],
        env: {
          SHELL_PORT: String(config.console.port),
          PERSONA_DIR: config.director.persona_dir,
          ...(config.console.token ? { SHELL_TOKEN: config.console.token } : {}),
          no_proxy: '127.0.0.1,localhost',
        },
      },
    },
  };
}

export function shouldWriteShellMcpConfig(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.PERSONA_SKIP_MCP_CONFIG_WRITE === '1') return false;

  // Test shells often run from temporary worktrees and override the console port.
  // They must not overwrite the production persona MCP config in ~/.persona.
  if (env.PERSONA_TEST === '1' && env.PERSONA_WRITE_MCP_CONFIG !== '1') return false;

  return true;
}

export function writeShellMcpConfig(config: Config, taskMcpServerPath: string): string | null {
  if (!shouldWriteShellMcpConfig()) return null;

  const mcpConfigPath = join(config.director.persona_dir, '.mcp.json');
  const mcpConfig = buildShellMcpConfig(config, taskMcpServerPath);
  writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));
  return mcpConfigPath;
}
