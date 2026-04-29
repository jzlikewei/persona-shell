import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { loadConfig, getDefaultAgentName, resolveAgentProvider, type AgentsConfig } from '../config.js';

const TEST_DIR = '/tmp/persona-config-test';

function writeYaml(name: string, content: string) {
  writeFileSync(join(TEST_DIR, name), content, 'utf-8');
}

/** Minimal valid config: feishu credentials split across two files */
function writeMinimalConfig(overrides?: { config?: string; secret?: string }) {
  writeYaml(
    'config.yaml',
    overrides?.config ??
      `feishu:\n  app_id: test_id\n`,
  );
  writeYaml(
    'im_secret.yaml',
    overrides?.secret ??
      `feishu:\n  app_secret: test_secret\n`,
  );
}

describe('config', () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // ─── getDefaultAgentName ───────────────────────────────────
  describe('getDefaultAgentName', () => {
    test('returns role-specific default when present', () => {
      const agents: AgentsConfig = {
        defaults: { director: 'codex', default: 'claude' },
        providers: {},
      };
      expect(getDefaultAgentName(agents, 'director')).toBe('codex');
    });

    test('falls back to defaults.default when role not specified', () => {
      const agents: AgentsConfig = {
        defaults: { default: 'my-agent' },
        providers: {},
      };
      expect(getDefaultAgentName(agents, 'explorer')).toBe('my-agent');
    });

    test('falls back to "claude" when no defaults at all', () => {
      const agents: AgentsConfig = { defaults: {}, providers: {} };
      expect(getDefaultAgentName(agents, 'explorer')).toBe('claude');
    });
  });

  // ─── resolveAgentProvider ──────────────────────────────────
  describe('resolveAgentProvider', () => {
    const agents: AgentsConfig = {
      defaults: { director: 'codex', default: 'claude' },
      providers: {
        claude: { type: 'claude', command: 'claude', bare: true, effort: 'max' },
        codex: { type: 'codex', command: 'codex', sandbox: 'danger-full-access' },
      },
    };

    test('resolves explicitly named provider', () => {
      const result = resolveAgentProvider(agents, 'director', 'claude');
      expect(result.name).toBe('claude');
      expect(result.type).toBe('claude');
    });

    test('uses getDefaultAgentName when agentName is omitted', () => {
      const result = resolveAgentProvider(agents, 'director');
      expect(result.name).toBe('codex');
      expect(result.type).toBe('codex');
    });

    test('throws when provider does not exist', () => {
      expect(() => resolveAgentProvider(agents, 'director', 'nonexistent')).toThrow(
        'Unknown agent provider "nonexistent"',
      );
    });
  });

  // ─── loadConfig ────────────────────────────────────────────
  describe('loadConfig', () => {
    test('loads minimal valid config', () => {
      writeMinimalConfig();
      const cfg = loadConfig(join(TEST_DIR, 'config.yaml'));
      expect(cfg.feishu.app_id).toBe('test_id');
      expect(cfg.feishu.app_secret).toBe('test_secret');
    });

    test('throws when app_id is missing', () => {
      writeMinimalConfig({ config: 'feishu:\n  something: x\n', secret: 'feishu:\n  app_secret: s\n' });
      expect(() => loadConfig(join(TEST_DIR, 'config.yaml'))).toThrow('app_id');
    });

    test('throws when app_secret is missing', () => {
      writeMinimalConfig({ config: 'feishu:\n  app_id: id\n', secret: 'feishu:\n  other: x\n' });
      expect(() => loadConfig(join(TEST_DIR, 'config.yaml'))).toThrow('app_secret');
    });

    test('works without im_secret.yaml if config.yaml has both fields', () => {
      writeYaml('config.yaml', 'feishu:\n  app_id: id\n  app_secret: secret\n');
      // no im_secret.yaml
      const cfg = loadConfig(join(TEST_DIR, 'config.yaml'));
      expect(cfg.feishu.app_id).toBe('id');
      expect(cfg.feishu.app_secret).toBe('secret');
    });

    // ── default values ──
    describe('default values', () => {
      test('fills default providers (claude + codex)', () => {
        writeMinimalConfig();
        const cfg = loadConfig(join(TEST_DIR, 'config.yaml'));
        expect(cfg.agents.providers.claude).toBeDefined();
        expect(cfg.agents.providers.claude.type).toBe('claude');
        expect(cfg.agents.providers.claude.bare).toBe(true);
        expect(cfg.agents.providers.claude.effort).toBe('max');
        expect(cfg.agents.providers.codex).toBeDefined();
        expect(cfg.agents.providers.codex.type).toBe('codex');
        expect(cfg.agents.providers.codex.sandbox).toBe('danger-full-access');
      });

      test('fills default agent defaults (director=claude, default=claude)', () => {
        writeMinimalConfig();
        const cfg = loadConfig(join(TEST_DIR, 'config.yaml'));
        expect(cfg.agents.defaults.director).toBe('claude');
        expect(cfg.agents.defaults.default).toBe('claude');
      });

      test('director defaults', () => {
        writeMinimalConfig();
        const cfg = loadConfig(join(TEST_DIR, 'config.yaml'));
        expect(cfg.director.persona_dir).toBe(homedir() + '/.persona');
        expect(cfg.director.pipe_dir).toBe('/tmp/persona');
        expect(cfg.director.pid_file).toBe('/tmp/persona/director.pid');
        expect(cfg.director.time_sync_interval_ms).toBe(2 * 3600_000);
        expect(cfg.director.flush_context_limit).toBe(700_000);
        expect(cfg.director.flush_interval_ms).toBe(7 * 86_400_000);
        expect(cfg.director.quote_max_length).toBe(32);
      });

      test('console defaults', () => {
        writeMinimalConfig();
        const cfg = loadConfig(join(TEST_DIR, 'config.yaml'));
        expect(cfg.console.enabled).toBe(true);
        expect(cfg.console.port).toBe(3000);
        expect(cfg.console.token).toBeUndefined();
      });

      test('task defaults', () => {
        writeMinimalConfig();
        const cfg = loadConfig(join(TEST_DIR, 'config.yaml'));
        expect(cfg.task.default_timeout_ms).toBe(10 * 60_000);
      });

      test('scheduler defaults', () => {
        writeMinimalConfig();
        const cfg = loadConfig(join(TEST_DIR, 'config.yaml'));
        expect(cfg.scheduler.enabled).toBe(true);
        expect(cfg.scheduler.intervalMinutes).toBe(30);
      });

      test('pool defaults', () => {
        writeMinimalConfig();
        const cfg = loadConfig(join(TEST_DIR, 'config.yaml'));
        expect(cfg.pool.max_directors).toBe(8);
        expect(cfg.pool.idle_timeout_minutes).toBe(30);
        expect(cfg.pool.small_group_threshold).toBe(5);
        expect(cfg.pool.parallel_chat_ids).toEqual([]);
      });

      test('logging defaults', () => {
        writeMinimalConfig();
        const cfg = loadConfig(join(TEST_DIR, 'config.yaml'));
        expect(cfg.logging.level).toBe('info');
        expect(cfg.logging.queue_log).toBe('logs/queue.log');
      });
    });

    // ── custom values ──
    describe('custom values', () => {
      test('director time_sync_interval_hours converts to ms', () => {
        writeMinimalConfig({
          config: `feishu:\n  app_id: id\ndirector:\n  time_sync_interval_hours: 5\n`,
          secret: `feishu:\n  app_secret: s\n`,
        });
        const cfg = loadConfig(join(TEST_DIR, 'config.yaml'));
        expect(cfg.director.time_sync_interval_ms).toBe(5 * 3600_000);
      });

      test('director flush_interval_days converts to ms', () => {
        writeMinimalConfig({
          config: `feishu:\n  app_id: id\ndirector:\n  flush_interval_days: 3\n`,
          secret: `feishu:\n  app_secret: s\n`,
        });
        const cfg = loadConfig(join(TEST_DIR, 'config.yaml'));
        expect(cfg.director.flush_interval_ms).toBe(3 * 86_400_000);
      });

      test('expandHome works on persona_dir', () => {
        writeMinimalConfig({
          config: `feishu:\n  app_id: id\ndirector:\n  persona_dir: "~/my-persona"\n`,
          secret: `feishu:\n  app_secret: s\n`,
        });
        const cfg = loadConfig(join(TEST_DIR, 'config.yaml'));
        expect(cfg.director.persona_dir).toBe(homedir() + '/my-persona');
      });

      test('expandHome leaves absolute paths unchanged', () => {
        writeMinimalConfig({
          config: `feishu:\n  app_id: id\ndirector:\n  persona_dir: "/absolute/path"\n`,
          secret: `feishu:\n  app_secret: s\n`,
        });
        const cfg = loadConfig(join(TEST_DIR, 'config.yaml'));
        expect(cfg.director.persona_dir).toBe('/absolute/path');
      });

      test('pool.parallel_chat_ids parses array', () => {
        writeMinimalConfig({
          config: `feishu:\n  app_id: id\npool:\n  parallel_chat_ids:\n    - chat1\n    - chat2\n`,
          secret: `feishu:\n  app_secret: s\n`,
        });
        const cfg = loadConfig(join(TEST_DIR, 'config.yaml'));
        expect(cfg.pool.parallel_chat_ids).toEqual(['chat1', 'chat2']);
      });

      test('console.enabled can be set to false', () => {
        writeMinimalConfig({
          config: `feishu:\n  app_id: id\nconsole:\n  enabled: false\n  port: 8080\n  token: abc\n`,
          secret: `feishu:\n  app_secret: s\n`,
        });
        const cfg = loadConfig(join(TEST_DIR, 'config.yaml'));
        expect(cfg.console.enabled).toBe(false);
        expect(cfg.console.port).toBe(8080);
        expect(cfg.console.token).toBe('abc');
      });

      test('scheduler.enabled can be set to false', () => {
        writeMinimalConfig({
          config: `feishu:\n  app_id: id\nscheduler:\n  enabled: false\n  interval_minutes: 60\n`,
          secret: `feishu:\n  app_secret: s\n`,
        });
        const cfg = loadConfig(join(TEST_DIR, 'config.yaml'));
        expect(cfg.scheduler.enabled).toBe(false);
        expect(cfg.scheduler.intervalMinutes).toBe(60);
      });
    });

    // ── agents.providers parsing ──
    describe('agents.providers parsing', () => {
      test('parses custom provider with all fields', () => {
        writeMinimalConfig({
          config: [
            'feishu:',
            '  app_id: id',
            'agents:',
            '  providers:',
            '    my-claude:',
            '      type: claude',
            '      command: /usr/bin/claude',
            '      bare: true',
            '      dangerously_skip_permissions: true',
            '      effort: high',
            '      model: sonnet',
            '',
          ].join('\n'),
          secret: `feishu:\n  app_secret: s\n`,
        });
        const cfg = loadConfig(join(TEST_DIR, 'config.yaml'));
        const p = cfg.agents.providers['my-claude'];
        expect(p).toBeDefined();
        expect(p.type).toBe('claude');
        expect(p.command).toBe('/usr/bin/claude');
        expect(p.bare).toBe(true);
        expect(p.dangerously_skip_permissions).toBe(true);
        expect(p.effort).toBe('high');
        expect(p.model).toBe('sonnet');
      });

      test('parses codex provider with sandbox/approval/search/mcp_mode', () => {
        writeMinimalConfig({
          config: [
            'feishu:',
            '  app_id: id',
            'agents:',
            '  providers:',
            '    my-codex:',
            '      type: codex',
            '      command: /usr/bin/codex',
            '      sandbox: workspace-write',
            '      approval: on-request',
            '      search: true',
            '      mcp_mode: mcp',
            '',
          ].join('\n'),
          secret: `feishu:\n  app_secret: s\n`,
        });
        const cfg = loadConfig(join(TEST_DIR, 'config.yaml'));
        const p = cfg.agents.providers['my-codex'];
        expect(p).toBeDefined();
        expect(p.type).toBe('codex');
        expect(p.sandbox).toBe('workspace-write');
        expect(p.approval).toBe('on-request');
        expect(p.search).toBe(true);
        expect(p.mcp_mode).toBe('mcp');
      });

      test('skips provider with invalid type', () => {
        writeMinimalConfig({
          config: [
            'feishu:',
            '  app_id: id',
            'agents:',
            '  providers:',
            '    bad:',
            '      type: unknown',
            '      command: foo',
            '',
          ].join('\n'),
          secret: `feishu:\n  app_secret: s\n`,
        });
        const cfg = loadConfig(join(TEST_DIR, 'config.yaml'));
        expect(cfg.agents.providers['bad']).toBeUndefined();
      });

      test('skips provider with missing command', () => {
        writeMinimalConfig({
          config: [
            'feishu:',
            '  app_id: id',
            'agents:',
            '  providers:',
            '    no-cmd:',
            '      type: claude',
            '',
          ].join('\n'),
          secret: `feishu:\n  app_secret: s\n`,
        });
        const cfg = loadConfig(join(TEST_DIR, 'config.yaml'));
        expect(cfg.agents.providers['no-cmd']).toBeUndefined();
      });

      test('does not override custom claude provider with default', () => {
        writeMinimalConfig({
          config: [
            'feishu:',
            '  app_id: id',
            'agents:',
            '  providers:',
            '    claude:',
            '      type: claude',
            '      command: /custom/claude',
            '      effort: low',
            '',
          ].join('\n'),
          secret: `feishu:\n  app_secret: s\n`,
        });
        const cfg = loadConfig(join(TEST_DIR, 'config.yaml'));
        expect(cfg.agents.providers.claude.command).toBe('/custom/claude');
        expect(cfg.agents.providers.claude.effort).toBe('low');
      });

      test('invalid effort value is not included', () => {
        writeMinimalConfig({
          config: [
            'feishu:',
            '  app_id: id',
            'agents:',
            '  providers:',
            '    test:',
            '      type: claude',
            '      command: claude',
            '      effort: ultra',
            '',
          ].join('\n'),
          secret: `feishu:\n  app_secret: s\n`,
        });
        const cfg = loadConfig(join(TEST_DIR, 'config.yaml'));
        expect(cfg.agents.providers['test'].effort).toBeUndefined();
      });
    });

    // ── agents.defaults parsing ──
    describe('agents.defaults parsing', () => {
      test('parses custom defaults', () => {
        writeMinimalConfig({
          config: [
            'feishu:',
            '  app_id: id',
            'agents:',
            '  defaults:',
            '    director: codex',
            '    explorer: claude',
            '    default: codex',
            '',
          ].join('\n'),
          secret: `feishu:\n  app_secret: s\n`,
        });
        const cfg = loadConfig(join(TEST_DIR, 'config.yaml'));
        expect(cfg.agents.defaults.director).toBe('codex');
        expect(cfg.agents.defaults.explorer).toBe('claude');
        expect(cfg.agents.defaults.default).toBe('codex');
      });

      test('filters out non-string and empty defaults', () => {
        writeMinimalConfig({
          config: [
            'feishu:',
            '  app_id: id',
            'agents:',
            '  defaults:',
            '    bad_number: 123',
            '    empty_string: ""',
            '    valid: claude',
            '',
          ].join('\n'),
          secret: `feishu:\n  app_secret: s\n`,
        });
        const cfg = loadConfig(join(TEST_DIR, 'config.yaml'));
        expect(cfg.agents.defaults['bad_number']).toBeUndefined();
        // empty string filtered → fallback kicks in
        expect(cfg.agents.defaults.valid).toBe('claude');
      });
    });
  });
});
