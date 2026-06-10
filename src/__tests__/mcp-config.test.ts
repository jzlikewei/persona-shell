import { describe, expect, test } from 'bun:test';
import { buildShellMcpConfig, shouldWriteShellMcpConfig } from '../mcp-config.js';
import type { Config } from '../config.js';

const config = {
  console: {
    port: 3000,
    token: 'secret',
  },
  director: {
    persona_dir: '/Users/example/.persona',
  },
} as Config;

describe('mcp config', () => {
  test('builds persona task MCP config from the running shell config', () => {
    const mcp = buildShellMcpConfig(config, '/repo/src/task/task-mcp-server.ts');

    expect(mcp.mcpServers['persona-tasks'].args).toEqual(['run', '/repo/src/task/task-mcp-server.ts']);
    expect(mcp.mcpServers['persona-tasks'].env).toEqual({
      SHELL_PORT: '3000',
      PERSONA_DIR: '/Users/example/.persona',
      SHELL_TOKEN: 'secret',
      no_proxy: '127.0.0.1,localhost',
    });
  });

  test('does not let test shells overwrite the global persona MCP config by default', () => {
    expect(shouldWriteShellMcpConfig({ PERSONA_TEST: '1' })).toBe(false);
    expect(shouldWriteShellMcpConfig({ PERSONA_TEST: '1', PERSONA_WRITE_MCP_CONFIG: '1' })).toBe(true);
    expect(shouldWriteShellMcpConfig({ PERSONA_TEST: '1', PERSONA_SKIP_MCP_CONFIG_WRITE: '1' })).toBe(false);
  });
});
