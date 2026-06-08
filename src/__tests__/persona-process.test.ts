import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';

import { buildCodexMcpOverrideArgs, spawnPersona } from '../persona-process.js';
import { initLogDir } from '../logger.js';

const TEST_DIR = '/tmp/persona-process-test';
const MCP_CONFIG_PATH = join(TEST_DIR, '.mcp.json');

describe('persona-process', () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(join(TEST_DIR, 'personas'), { recursive: true });
    mkdirSync(join(TEST_DIR, 'logs'), { recursive: true });
    initLogDir(TEST_DIR);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('buildCodexMcpOverrideArgs', () => {
    test('generates -c args from .mcp.json for Codex App Server MCP overrides', () => {
      const mcpConfig = {
        mcpServers: {
          'persona-tasks': {
            command: 'bun',
            args: ['run', 'src/task-mcp-server.ts'],
            env: { SHELL_PORT: '3000', SHELL_TOKEN: 'secret' },
          },
        },
      };
      writeFileSync(MCP_CONFIG_PATH, JSON.stringify(mcpConfig));

      const args = buildCodexMcpOverrideArgs(MCP_CONFIG_PATH);

      // Should contain -c flags for MCP server config
      const cFlags = args.filter((_, i, arr) => arr[i - 1] === '-c');

      expect(cFlags).toContain('mcp_servers.persona-tasks.command="bun"');
      expect(cFlags.some((f) => f.includes('mcp_servers."persona-tasks"'))).toBe(false);
      expect(cFlags.some((f) => f.includes('"bun"'))).toBe(true);
      expect(cFlags.some((f) => f.includes('"run"'))).toBe(true);
      expect(cFlags.some((f) => f.includes('SHELL_PORT'))).toBe(true);
    });

    test('merges DIRECTOR_LABEL into Codex MCP server env when provided', () => {
      const mcpConfig = {
        mcpServers: {
          'persona-tasks': {
            command: 'bun',
            args: ['run', 'src/task-mcp-server.ts'],
            env: { SHELL_PORT: '3000' },
          },
        },
      };
      writeFileSync(MCP_CONFIG_PATH, JSON.stringify(mcpConfig));

      const args = buildCodexMcpOverrideArgs(MCP_CONFIG_PATH, { DIRECTOR_LABEL: 'cb1274a8' });

      const cFlags = args.filter((_, i, arr) => arr[i - 1] === '-c');
      expect(cFlags.some((f) => f.includes('DIRECTOR_LABEL = "cb1274a8"'))).toBe(true);
    });

    test('merges multiple env overrides into Codex MCP server env', () => {
      const mcpConfig = {
        mcpServers: {
          'persona-tasks': {
            command: 'bun',
            args: ['run', 'src/task-mcp-server.ts'],
            env: { SHELL_PORT: '3000' },
          },
        },
      };
      writeFileSync(MCP_CONFIG_PATH, JSON.stringify(mcpConfig));

      const args = buildCodexMcpOverrideArgs(MCP_CONFIG_PATH, { DIRECTOR_LABEL: 'abc123' });

      const cFlags = args.filter((_, i, arr) => arr[i - 1] === '-c');
      expect(cFlags.some((f) => f.includes('DIRECTOR_LABEL = "abc123"'))).toBe(true);
      expect(cFlags.some((f) => f.includes('SHELL_PORT = "3000"'))).toBe(true);
    });

    test('skips MCP args when .mcp.json does not exist', () => {
      const args = buildCodexMcpOverrideArgs(join(TEST_DIR, 'nonexistent.json'));

      const cFlags = args.filter((_, i, arr) => arr[i - 1] === '-c');
      expect(cFlags.filter((f) => f.includes('mcp_servers.'))).toHaveLength(0);
    });

    test('skips servers with missing command', () => {
      const mcpConfig = {
        mcpServers: {
          broken: { args: ['foo'] },  // no command
          valid: { command: 'node', args: ['bar'] },
        },
      };
      writeFileSync(MCP_CONFIG_PATH, JSON.stringify(mcpConfig));

      const args = buildCodexMcpOverrideArgs(MCP_CONFIG_PATH);

      const cFlags = args.filter((_, i, arr) => arr[i - 1] === '-c');
      // Should only have entries for "valid", not "broken"
      expect(cFlags.some((f) => f.includes('"node"'))).toBe(true);
      expect(cFlags.filter((f) => f.includes('"broken"'))).toHaveLength(0);
    });

    test('handles empty mcpServers object', () => {
      writeFileSync(MCP_CONFIG_PATH, JSON.stringify({ mcpServers: {} }));

      const args = buildCodexMcpOverrideArgs(MCP_CONFIG_PATH);

      const cFlags = args.filter((_, i, arr) => arr[i - 1] === '-c');
      expect(cFlags.filter((f) => f.includes('mcp_servers.'))).toHaveLength(0);
    });

    test('handles malformed JSON gracefully', () => {
      writeFileSync(MCP_CONFIG_PATH, '{ broken json }}}');

      const args = buildCodexMcpOverrideArgs(MCP_CONFIG_PATH);

      const cFlags = args.filter((_, i, arr) => arr[i - 1] === '-c');
      expect(cFlags.filter((f) => f.includes('mcp_servers.'))).toHaveLength(0);
    });

    test('skips server names that cannot be expressed as Codex dotted keys', () => {
      const mcpConfig = {
        mcpServers: {
          'bad key': { command: 'bun', args: ['run', 'foo.ts'] },
          valid_key: { command: 'node', args: ['bar.js'] },
        },
      };
      writeFileSync(MCP_CONFIG_PATH, JSON.stringify(mcpConfig));

      const args = buildCodexMcpOverrideArgs(MCP_CONFIG_PATH);

      const cFlags = args.filter((_, i, arr) => arr[i - 1] === '-c');
      expect(cFlags).toContain('mcp_servers.valid_key.command="node"');
      expect(cFlags.some((f) => f.includes('bad key'))).toBe(false);
    });
  });

  describe('claude background mode args', () => {
    test('includes --print, --output-format, -p for claude background', () => {
      const { child, args } = spawnPersona({
        role: 'explorer',
        personaDir: TEST_DIR,
        agent: { type: 'claude', command: 'echo', name: 'claude' },
        mode: 'background',
        prompt: 'find something',
        stderrPath: join(TEST_DIR, 'logs', 'test.log'),
      });
      child.kill();

      expect(args).toContain('--print');
      expect(args).toContain('--output-format');
      expect(args).toContain('stream-json');
      expect(args).toContain('-p');
      expect(args).toContain('find something');
    });
  });

  describe('foreground mode', () => {
    test('throws for codex-app-server in foreground mode', () => {
      expect(() => {
        spawnPersona({
          role: 'director',
          personaDir: TEST_DIR,
          agent: { type: 'codex-app-server', command: 'echo', name: 'codex' },
          mode: 'foreground',
          stderrPath: join(TEST_DIR, 'logs', 'test.log'),
        });
      }).toThrow('Foreground mode is not supported');
    });
  });

  describe('claude foreground mode args', () => {
    test('includes core foreground flags for claude agent', () => {
      const { child, args } = spawnPersona({
        role: 'director',
        personaDir: TEST_DIR,
        agent: { type: 'claude', command: 'echo', name: 'claude' },
        mode: 'foreground',
        pipeIn: '/tmp/test-in',
        pipeOut: '/tmp/test-out',
        stderrPath: join(TEST_DIR, 'logs', 'test.log'),
      });
      child.kill();

      expect(args).toContain('--print');
      expect(args).toContain('--output-format');
      expect(args).toContain('stream-json');
      expect(args).toContain('--verbose');
      expect(args).toContain('--input-format');
      expect(args).toContain('--include-partial-messages');
      expect(args).toContain('--dangerously-skip-permissions');
      expect(args).toContain('--bare');
    });

    test('includes session resume args when sessionId and sessionName are set', () => {
      const { child, args } = spawnPersona({
        role: 'director',
        personaDir: TEST_DIR,
        agent: { type: 'claude', command: 'echo', name: 'claude' },
        mode: 'foreground',
        pipeIn: '/tmp/test-in',
        pipeOut: '/tmp/test-out',
        sessionId: 'sess-abc-123',
        sessionName: 'director-main-20260415T1900',
        stderrPath: join(TEST_DIR, 'logs', 'test.log'),
      });
      child.kill();

      expect(args).toContain('--resume');
      expect(args).toContain('sess-abc-123');
      expect(args).toContain('--name');
      expect(args).toContain('director-main-20260415T1900');
    });

    test('includes --mcp-config when mcpConfigPath is provided', () => {
      writeFileSync(MCP_CONFIG_PATH, JSON.stringify({ mcpServers: {} }));
      const { child, args } = spawnPersona({
        role: 'director',
        personaDir: TEST_DIR,
        agent: { type: 'claude', command: 'echo', name: 'claude' },
        mode: 'foreground',
        pipeIn: '/tmp/test-in',
        pipeOut: '/tmp/test-out',
        mcpConfigPath: MCP_CONFIG_PATH,
        stderrPath: join(TEST_DIR, 'logs', 'test.log'),
      });
      child.kill();

      expect(args).toContain('--mcp-config');
      expect(args).toContain(MCP_CONFIG_PATH);
    });

    test('includes --effort when agent has effort set', () => {
      const { child, args } = spawnPersona({
        role: 'director',
        personaDir: TEST_DIR,
        agent: { type: 'claude', command: 'echo', name: 'claude', effort: 'high' },
        mode: 'foreground',
        pipeIn: '/tmp/test-in',
        pipeOut: '/tmp/test-out',
        stderrPath: join(TEST_DIR, 'logs', 'test.log'),
      });
      child.kill();

      expect(args).toContain('--effort');
      expect(args).toContain('high');
    });
  });

  describe('agent option flags', () => {
    test('omits --bare and --dangerously-skip-permissions when explicitly disabled', () => {
      const { child, args } = spawnPersona({
        role: 'explorer',
        personaDir: TEST_DIR,
        agent: { type: 'claude', command: 'echo', name: 'claude', bare: false, dangerously_skip_permissions: false },
        mode: 'background',
        prompt: 'test',
        stderrPath: join(TEST_DIR, 'logs', 'test.log'),
      });
      child.kill();

      expect(args).not.toContain('--bare');
      expect(args).not.toContain('--dangerously-skip-permissions');
    });
  });

  describe('extra env and extra args', () => {
    test('does not throw when extra env is provided', () => {
      const { child } = spawnPersona({
        role: 'director',
        personaDir: TEST_DIR,
        agent: { type: 'claude', command: 'echo', name: 'claude' },
        mode: 'background',
        prompt: 'test',
        env: { DIRECTOR_LABEL: 'test-label' },
        stderrPath: join(TEST_DIR, 'logs', 'test.log'),
      });
      child.kill();
      // If we got here without throwing, env merge worked
    });

    test('includes extra CLI args in final args array', () => {
      const { child, args } = spawnPersona({
        role: 'director',
        personaDir: TEST_DIR,
        agent: { type: 'claude', command: 'echo', name: 'claude' },
        mode: 'background',
        prompt: 'test',
        extraArgs: ['--custom-flag', 'value'],
        stderrPath: join(TEST_DIR, 'logs', 'test.log'),
      });
      child.kill();

      expect(args).toContain('--custom-flag');
      expect(args).toContain('value');
    });
  });

  describe('claude role file injection (buildClaudeRoleArgs)', () => {
    test('includes --append-system-prompt-file for role persona file', () => {
      writeFileSync(join(TEST_DIR, 'personas', 'explorer.md'), '# Explorer\nYou are an explorer.');

      const { child, args } = spawnPersona({
        role: 'explorer',
        personaDir: TEST_DIR,
        agent: { type: 'claude', command: 'echo', name: 'claude' },
        mode: 'background',
        prompt: 'find stuff',
        stderrPath: join(TEST_DIR, 'logs', 'test.log'),
      });
      child.kill();

      expect(args).toContain('--append-system-prompt-file');
      const roleFileIdx = args.indexOf(join(TEST_DIR, 'personas', 'explorer.md'));
      expect(roleFileIdx).toBeGreaterThan(-1);
      // The flag should immediately precede the file path
      expect(args[roleFileIdx - 1]).toBe('--append-system-prompt-file');
    });

    test('does not include role file when it does not exist', () => {
      const { child, args } = spawnPersona({
        role: 'nonexistent-role',
        personaDir: TEST_DIR,
        agent: { type: 'claude', command: 'echo', name: 'claude' },
        mode: 'background',
        prompt: 'test',
        stderrPath: join(TEST_DIR, 'logs', 'test.log'),
      });
      child.kill();

      const roleFilePath = join(TEST_DIR, 'personas', 'nonexistent-role.md');
      expect(args).not.toContain(roleFilePath);
    });
  });

  describe('claude injection args (buildClaudeInjectionArgs)', () => {
    test('includes soul.md and meta.md as system prompt files when they exist', () => {
      writeFileSync(join(TEST_DIR, 'soul.md'), 'soul');
      writeFileSync(join(TEST_DIR, 'meta.md'), 'meta');

      const { child, args } = spawnPersona({
        role: 'director',
        personaDir: TEST_DIR,
        agent: { type: 'claude', command: 'echo', name: 'claude' },
        mode: 'background',
        prompt: 'test',
        stderrPath: join(TEST_DIR, 'logs', 'test.log'),
      });
      child.kill();

      expect(args).toContain('--add-dir');
      expect(args).toContain(TEST_DIR);
      expect(args).toContain('--plugin-dir');
      expect(args).toContain(join(TEST_DIR, 'personas'));
      expect(args).toContain(join(TEST_DIR, 'soul.md'));
      expect(args).toContain(join(TEST_DIR, 'meta.md'));
    });

});
});
