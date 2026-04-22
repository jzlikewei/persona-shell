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
import { spawnPersona } from '../persona-process.js';
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

      const { child, args } = spawnPersona({
        role: 'director',
        personaDir: TEST_DIR,
        agent: { type: 'codex', command: 'echo', name: 'codex' },
        mode: 'background',
        mcpConfigPath: MCP_CONFIG_PATH,
        prompt: 'test',
        env: { DIRECTOR_LABEL: 'cb1274a8' },
        stderrPath: join(TEST_DIR, 'logs', 'test.log'),
      });
      child.kill();

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

      const { child, args } = spawnPersona({
        role: 'director',
        personaDir: TEST_DIR,
        agent: { type: 'codex', command: 'echo', name: 'codex' },
        mode: 'background',
        mcpConfigPath: MCP_CONFIG_PATH,
        prompt: 'test',
        env: { DIRECTOR_LABEL: 'abc123' },
        stderrPath: join(TEST_DIR, 'logs', 'test.log'),
      });
      child.kill();

      const cFlags = args.filter((_, i, arr) => arr[i - 1] === '-c');
      expect(cFlags.some((f) => f.includes('DIRECTOR_LABEL = "abc123"'))).toBe(true);
      expect(cFlags.some((f) => f.includes('SHELL_PORT = "3000"'))).toBe(true);
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

    test('skips server names that cannot be expressed as Codex dotted keys', () => {
      const mcpConfig = {
        mcpServers: {
          'bad key': { command: 'bun', args: ['run', 'foo.ts'] },
          valid_key: { command: 'node', args: ['bar.js'] },
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
      expect(cFlags).toContain('mcp_servers.valid_key.command="node"');
      expect(cFlags.some((f) => f.includes('bad key'))).toBe(false);
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

  describe('codex agent config options', () => {
    test('uses bypass flag for danger-full-access plus never approval', () => {
      const { child, args } = spawnPersona({
        role: 'explorer',
        personaDir: TEST_DIR,
        agent: { type: 'codex', command: 'echo', name: 'codex', model: 'o3', sandbox: 'danger-full-access', approval: 'never', search: true },
        mode: 'background',
        prompt: 'test',
        stderrPath: join(TEST_DIR, 'logs', 'test.log'),
      });
      child.kill();

      expect(args).toContain('--model');
      expect(args).toContain('o3');
      expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
      expect(args).not.toContain('--sandbox');
      expect(args).not.toContain('--ask-for-approval');
      expect(args).toContain('--search');
    });

    test('keeps explicit sandbox and approval flags for other codex modes', () => {
      const { child, args } = spawnPersona({
        role: 'explorer',
        personaDir: TEST_DIR,
        agent: { type: 'codex', command: 'echo', name: 'codex', model: 'o3', sandbox: 'read-only', approval: 'on-request', search: true },
        mode: 'background',
        prompt: 'test',
        stderrPath: join(TEST_DIR, 'logs', 'test.log'),
      });
      child.kill();

      expect(args).toContain('--model');
      expect(args).toContain('o3');
      expect(args).toContain('--sandbox');
      expect(args).toContain('read-only');
      expect(args).toContain('--ask-for-approval');
      expect(args).toContain('on-request');
      expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
      expect(args).toContain('--search');
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

  describe('codex background prompt building (buildCodexPrompt)', () => {
    test('codex background args end without prompt section when no prompt given', () => {
      const { child, args } = spawnPersona({
        role: 'explorer',
        personaDir: TEST_DIR,
        agent: { type: 'codex', command: 'echo', name: 'codex' },
        mode: 'background',
        prompt: '',
        stderrPath: join(TEST_DIR, 'logs', 'test.log'),
      });
      child.kill();

      // With empty prompt and no soul/meta/persona files, buildCodexPrompt returns ''
      // so args should not contain a trailing prompt string
      const afterSkipIdx = args.indexOf('--skip-git-repo-check');
      expect(afterSkipIdx).toBeGreaterThan(-1);
      // Nothing after --skip-git-repo-check (no prompt appended)
      expect(args.length).toBe(afterSkipIdx + 1);
    });

    test('codex background prompt includes soul.md and meta.md content', () => {
      writeFileSync(join(TEST_DIR, 'soul.md'), 'I am the soul');
      writeFileSync(join(TEST_DIR, 'meta.md'), 'Meta context here');

      const { child, args } = spawnPersona({
        role: 'explorer',
        personaDir: TEST_DIR,
        agent: { type: 'codex', command: 'echo', name: 'codex' },
        mode: 'background',
        prompt: 'do the thing',
        stderrPath: join(TEST_DIR, 'logs', 'test.log'),
      });
      child.kill();

      // The last arg should be the built prompt containing injected sections
      const builtPrompt = args[args.length - 1];
      expect(builtPrompt).toContain('I am the soul');
      expect(builtPrompt).toContain('Meta context here');
      expect(builtPrompt).toContain('do the thing');
      expect(builtPrompt).toContain('## Injected soul');
      expect(builtPrompt).toContain('## Injected meta');
      expect(builtPrompt).toContain('## Task');
    });

    test('codex background prompt includes persona role file', () => {
      writeFileSync(join(TEST_DIR, 'personas', 'explorer.md'), 'Explorer persona instructions');

      const { child, args } = spawnPersona({
        role: 'explorer',
        personaDir: TEST_DIR,
        agent: { type: 'codex', command: 'echo', name: 'codex' },
        mode: 'background',
        prompt: 'search',
        stderrPath: join(TEST_DIR, 'logs', 'test.log'),
      });
      child.kill();

      const builtPrompt = args[args.length - 1];
      expect(builtPrompt).toContain('Explorer persona instructions');
      expect(builtPrompt).toContain('## Injected persona:explorer');
    });

    test('codex background with resumeSessionId uses raw prompt, not buildCodexPrompt', () => {
      writeFileSync(join(TEST_DIR, 'soul.md'), 'soul content');

      const { child, args } = spawnPersona({
        role: 'explorer',
        personaDir: TEST_DIR,
        agent: { type: 'codex', command: 'echo', name: 'codex' },
        mode: 'background',
        resumeSessionId: 'thread-resume-456',
        prompt: 'continue please',
        stderrPath: join(TEST_DIR, 'logs', 'test.log'),
      });
      child.kill();

      // When resuming, prompt is passed as-is without buildCodexPrompt injection
      expect(args).toContain('resume');
      expect(args).toContain('thread-resume-456');
      const lastArg = args[args.length - 1];
      expect(lastArg).toBe('continue please');
      // Should NOT contain injected soul content
      expect(lastArg).not.toContain('soul content');
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
