import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';

// Access private/module-level functions via import trick:
// buildCodexMcpOverrideArgs, shellQuote, tomlString, tomlInlineTable
// are module-private — we test them indirectly through spawnPersona's args output,
// or extract them for direct testing.

// Strategy: since these are non-exported, we re-implement minimal extraction
// and test through spawnPersona's generated args.
// For buildCodexMcpOverrideArgs specifically, we also create a standalone test
// by extracting the logic into a test-accessible wrapper.

// Direct import for testing the function behavior through spawn args
import { spawnPersona } from './persona-process.js';

const TEST_DIR = '/tmp/persona-process-test';
const MCP_CONFIG_PATH = join(TEST_DIR, '.mcp.json');

describe('persona-process', () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(join(TEST_DIR, 'personas'), { recursive: true });
    mkdirSync(join(TEST_DIR, 'logs'), { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('buildCodexMcpOverrideArgs (via spawnPersona)', () => {
    test('generates -c args from .mcp.json for codex agents', () => {
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

      const { child, args } = spawnPersona({
        role: 'director',
        personaDir: TEST_DIR,
        agent: { type: 'codex', command: 'echo', name: 'codex' },
        mode: 'background',
        mcpConfigPath: MCP_CONFIG_PATH,
        prompt: 'test',
        stderrPath: join(TEST_DIR, 'logs', 'test.log'),
      });
      child.kill();

      // Should contain -c flags for MCP server config
      const cFlags = args.filter((_, i, arr) => arr[i - 1] === '-c');

      expect(cFlags.some((f) => f.includes('mcp_servers.'))).toBe(true);
      expect(cFlags.some((f) => f.includes('"bun"'))).toBe(true);
      expect(cFlags.some((f) => f.includes('"run"'))).toBe(true);
      expect(cFlags.some((f) => f.includes('SHELL_PORT'))).toBe(true);
    });

    test('skips MCP args when .mcp.json does not exist', () => {
      const { child, args } = spawnPersona({
        role: 'director',
        personaDir: TEST_DIR,
        agent: { type: 'codex', command: 'echo', name: 'codex' },
        mode: 'background',
        mcpConfigPath: join(TEST_DIR, 'nonexistent.json'),
        prompt: 'test',
        stderrPath: join(TEST_DIR, 'logs', 'test.log'),
      });
      child.kill();

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

      const { child, args } = spawnPersona({
        role: 'director',
        personaDir: TEST_DIR,
        agent: { type: 'codex', command: 'echo', name: 'codex' },
        mode: 'background',
        mcpConfigPath: MCP_CONFIG_PATH,
        prompt: 'test',
        stderrPath: join(TEST_DIR, 'logs', 'test.log'),
      });
      child.kill();

      const cFlags = args.filter((_, i, arr) => arr[i - 1] === '-c');
      // Should only have entries for "valid", not "broken"
      expect(cFlags.some((f) => f.includes('"node"'))).toBe(true);
      expect(cFlags.filter((f) => f.includes('"broken"'))).toHaveLength(0);
    });

    test('handles empty mcpServers object', () => {
      writeFileSync(MCP_CONFIG_PATH, JSON.stringify({ mcpServers: {} }));

      const { child, args } = spawnPersona({
        role: 'director',
        personaDir: TEST_DIR,
        agent: { type: 'codex', command: 'echo', name: 'codex' },
        mode: 'background',
        mcpConfigPath: MCP_CONFIG_PATH,
        prompt: 'test',
        stderrPath: join(TEST_DIR, 'logs', 'test.log'),
      });
      child.kill();

      const cFlags = args.filter((_, i, arr) => arr[i - 1] === '-c');
      expect(cFlags.filter((f) => f.includes('mcp_servers.'))).toHaveLength(0);
    });

    test('handles malformed JSON gracefully', () => {
      writeFileSync(MCP_CONFIG_PATH, '{ broken json }}}');

      const { child, args } = spawnPersona({
        role: 'director',
        personaDir: TEST_DIR,
        agent: { type: 'codex', command: 'echo', name: 'codex' },
        mode: 'background',
        mcpConfigPath: MCP_CONFIG_PATH,
        prompt: 'test',
        stderrPath: join(TEST_DIR, 'logs', 'test.log'),
      });
      child.kill();

      const cFlags = args.filter((_, i, arr) => arr[i - 1] === '-c');
      expect(cFlags.filter((f) => f.includes('mcp_servers.'))).toHaveLength(0);
    });
  });

  describe('codex background mode args', () => {
    test('includes exec, --json, --skip-git-repo-check for codex background', () => {
      const { child, args } = spawnPersona({
        role: 'explorer',
        personaDir: TEST_DIR,
        agent: { type: 'codex', command: 'echo', name: 'codex' },
        mode: 'background',
        prompt: 'search something',
        stderrPath: join(TEST_DIR, 'logs', 'test.log'),
      });
      child.kill();

      expect(args).toContain('exec');
      expect(args).toContain('--json');
      expect(args).toContain('--skip-git-repo-check');
    });

    test('includes resume and session id when resuming', () => {
      const { child, args } = spawnPersona({
        role: 'director',
        personaDir: TEST_DIR,
        agent: { type: 'codex', command: 'echo', name: 'codex' },
        mode: 'background',
        resumeSessionId: 'thread-abc-123',
        prompt: 'continue',
        stderrPath: join(TEST_DIR, 'logs', 'test.log'),
      });
      child.kill();

      expect(args).toContain('resume');
      expect(args).toContain('thread-abc-123');
    });

    test('includes --cd for codex agents', () => {
      const { child, args } = spawnPersona({
        role: 'director',
        personaDir: TEST_DIR,
        agent: { type: 'codex', command: 'echo', name: 'codex' },
        mode: 'background',
        prompt: 'test',
        stderrPath: join(TEST_DIR, 'logs', 'test.log'),
      });
      child.kill();

      expect(args).toContain('--cd');
      expect(args).toContain(TEST_DIR);
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
    test('throws for non-claude agent in foreground mode', () => {
      expect(() => {
        spawnPersona({
          role: 'director',
          personaDir: TEST_DIR,
          agent: { type: 'codex', command: 'echo', name: 'codex' },
          mode: 'foreground',
          stderrPath: join(TEST_DIR, 'logs', 'test.log'),
        });
      }).toThrow('Foreground mode is not supported');
    });
  });
});
