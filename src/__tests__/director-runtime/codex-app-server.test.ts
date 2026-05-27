import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { CodexAppServerRuntime } from '../../director-runtime/codex-app-server.js';

describe('CodexAppServerRuntime', () => {
  test('uses last input tokens for context metrics instead of cumulative totals', () => {
    const metrics: Array<{ lastInputTokens?: number; contextTokens?: number; contextWindow?: number }> = [];
    const runtime = new CodexAppServerRuntime(
      {
        label: 'test',
        logDir: '/tmp/persona-test/logs',
        config: {
          persona_dir: '/tmp/persona-test',
          pipe_dir: '/tmp/persona-test',
          pid_file: '/tmp/persona-test/test.pid',
          time_sync_interval_ms: 999999,
          flush_context_limit: 999999,
          flush_interval_ms: 999999,
          quote_max_length: 32,
        },
        agent: { type: 'codex-app-server', command: 'codex', name: 'codex-live' },
        personaRole: 'director',
      },
      {
        getSessionId: () => 'thread-1',
        getSessionName: () => 'session-1',
        setSessionName: () => {},
        buildSessionName: () => 'session-1',
        persistSession: () => {},
        clearSession: () => {},
        logOutput: () => {},
        onChunk: () => {},
        onToolCall: () => {},
        onPartialAgentMessage: () => {},
        onMetrics: (update) => metrics.push(update),
        onTurnComplete: () => {},
        onTurnFailure: () => {},
        onRuntimeClosed: () => {},
      },
    );
    const runtimePrivate = runtime as unknown as {
      handleTokenUsage(params: Record<string, unknown>): void;
    };

    runtimePrivate.handleTokenUsage({
      tokenUsage: {
        total: {
          totalTokens: 1_313_755,
          inputTokens: 1_305_272,
          cachedInputTokens: 1_086_592,
          outputTokens: 8_483,
          reasoningOutputTokens: 832,
        },
        last: {
          totalTokens: 76_475,
          inputTokens: 75_821,
          cachedInputTokens: 4_480,
          outputTokens: 654,
          reasoningOutputTokens: 0,
        },
        modelContextWindow: 258_400,
      },
    });

    expect(metrics).toEqual([{
      lastInputTokens: 75_821,
      contextTokens: 75_821,
      contextWindow: 258_400,
    }]);
  });

  test('passes persona task MCP config to codex app-server when mcp mode is enabled', () => {
    const personaDir = '/tmp/persona-codex-app-server-test';
    rmSync(personaDir, { recursive: true, force: true });
    mkdirSync(personaDir, { recursive: true });
    writeFileSync(join(personaDir, '.mcp.json'), JSON.stringify({
      mcpServers: {
        'persona-tasks': {
          command: 'bun',
          args: ['run', 'src/task-mcp-server.ts'],
          env: { SHELL_PORT: '3000' },
        },
      },
    }));

    const runtime = new CodexAppServerRuntime(
      {
        label: 'f95f0739',
        logDir: '/tmp/persona-test/logs',
        config: {
          persona_dir: personaDir,
          pipe_dir: '/tmp/persona-test',
          pid_file: '/tmp/persona-test/test.pid',
          time_sync_interval_ms: 999999,
          flush_context_limit: 999999,
          flush_interval_ms: 999999,
          quote_max_length: 32,
        },
        agent: { type: 'codex-app-server', command: 'codex', name: 'codex-live', mcp_mode: 'mcp' },
        personaRole: 'director',
      },
      {
        getSessionId: () => 'thread-1',
        getSessionName: () => 'session-1',
        setSessionName: () => {},
        buildSessionName: () => 'session-1',
        persistSession: () => {},
        clearSession: () => {},
        logOutput: () => {},
        onChunk: () => {},
        onToolCall: () => {},
        onPartialAgentMessage: () => {},
        onMetrics: () => {},
        onTurnComplete: () => {},
        onTurnFailure: () => {},
        onRuntimeClosed: () => {},
      },
    );
    const runtimePrivate = runtime as unknown as {
      buildSpawnArgs(): string[];
    };
    const args = runtimePrivate.buildSpawnArgs();
    const cFlags = args.filter((_, idx, arr) => arr[idx - 1] === '-c');

    expect(args.slice(0, 2)).toEqual(['app-server', '-c']);
    expect(cFlags).toContain('mcp_servers.persona-tasks.command="bun"');
    expect(cFlags.some((flag) => flag.includes('DIRECTOR_LABEL = "f95f0739"'))).toBe(true);
    expect(args.slice(-2)).toEqual(['--listen', 'stdio://']);

    rmSync(personaDir, { recursive: true, force: true });
  });
});
