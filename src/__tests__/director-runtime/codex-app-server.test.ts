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
        getRuntimeEnv: () => ({ DIRECTOR_LABEL: 'test', PERSONA_SESSION_ID: 'thread-1', PERSONA_WORKSPACE: 'main' }),
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
        getRuntimeEnv: () => ({ DIRECTOR_LABEL: 'f95f0739', PERSONA_SESSION_ID: 'thread-1', PERSONA_WORKSPACE: 'main' }),
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
    expect(cFlags.some((flag) => flag.includes('PERSONA_SESSION_ID = "thread-1"'))).toBe(true);
    expect(cFlags.some((flag) => flag.includes('PERSONA_WORKSPACE = "main"'))).toBe(true);
    expect(args.slice(-2)).toEqual(['--listen', 'stdio://']);

    rmSync(personaDir, { recursive: true, force: true });
  });

  test('uses provider cwd and app-visible thread metadata for app-server threads', () => {
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
        agent: {
          type: 'codex-app-server',
          command: 'codex',
          name: 'codex-live',
          cwd: '/tmp/persona-codex-workspace',
        },
        personaRole: 'director',
      },
      {
        getSessionId: () => 'thread-1',
        getSessionName: () => 'session-1',
        getRuntimeEnv: () => ({ DIRECTOR_LABEL: 'test', PERSONA_SESSION_ID: 'thread-1', PERSONA_WORKSPACE: 'main' }),
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
      threadOptions(): Record<string, unknown>;
    };

    expect(runtimePrivate.threadOptions()).toMatchObject({
      cwd: '/tmp/persona-codex-workspace',
      sessionStartSource: 'startup',
      threadSource: 'user',
    });
  });

  test('registers persona dynamic task tools when mcp_mode is dynamic', () => {
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
        agent: { type: 'codex-app-server', command: 'codex', name: 'codex-live', mcp_mode: 'dynamic' },
        personaRole: 'director',
      },
      {
        getSessionId: () => 'thread-1',
        getSessionName: () => 'session-1',
        getRuntimeEnv: () => ({ DIRECTOR_LABEL: 'test', PERSONA_SESSION_ID: 'thread-1', PERSONA_WORKSPACE: 'main' }),
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
      threadOptions(): Record<string, unknown>;
    };

    const dynamicTools = runtimePrivate.threadOptions().dynamicTools as Array<{ name: string }> | undefined;
    expect(dynamicTools?.map((tool) => tool.name)).toEqual(['create_task', 'list_tasks', 'get_task']);
  });

  test('handles app-server item/tool/call through dynamic tool hook', async () => {
    const writes: string[] = [];
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
        agent: { type: 'codex-app-server', command: 'codex', name: 'codex-live', mcp_mode: 'dynamic' },
        personaRole: 'director',
      },
      {
        getSessionId: () => 'thread-1',
        getSessionName: () => 'session-1',
        getRuntimeEnv: () => ({ DIRECTOR_LABEL: 'test', PERSONA_SESSION_ID: 'thread-1', PERSONA_WORKSPACE: 'main' }),
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
        onDynamicToolCall: (call) => ({
          success: true,
          text: `${call.threadId}:${call.tool}:${(call.arguments as { text?: string }).text}`,
        }),
      },
    );
    const runtimePrivate = runtime as unknown as {
      child: { stdin: { destroyed: boolean; write(line: string): boolean } };
      handleServerRequest(msg: { id: number; method: string; params: Record<string, unknown> }): void;
    };
    runtimePrivate.child = {
      stdin: {
        destroyed: false,
        write(line: string) {
          writes.push(line);
          return true;
        },
      },
    };

    runtimePrivate.handleServerRequest({
      id: 7,
      method: 'item/tool/call',
      params: {
        threadId: 'thread-dyn',
        turnId: 'turn-1',
        callId: 'call-1',
        tool: 'persona_echo',
        arguments: { text: 'hello' },
      },
    });
    await Bun.sleep(0);

    expect(JSON.parse(writes[0])).toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: {
        success: true,
        contentItems: [{ type: 'inputText', text: 'thread-dyn:persona_echo:hello' }],
      },
    });
  });

  test('injects soul, role persona, and workspace context into app-server thread instructions', () => {
    const personaDir = '/tmp/persona-codex-context-test';
    const contextPath = join(personaDir, 'workspaces', 'demo', 'context.md');
    rmSync(personaDir, { recursive: true, force: true });
    mkdirSync(join(personaDir, 'personas'), { recursive: true });
    mkdirSync(join(personaDir, 'workspaces', 'demo'), { recursive: true });
    writeFileSync(join(personaDir, 'soul.md'), 'Soul instruction');
    writeFileSync(join(personaDir, 'meta.md'), 'Meta instruction');
    writeFileSync(join(personaDir, 'personas', 'director.md'), 'Director persona instruction');
    writeFileSync(contextPath, '# Context\nCurrent task state');

    const runtime = new CodexAppServerRuntime(
      {
        label: 'demo',
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
        agent: { type: 'codex-app-server', command: 'codex', name: 'codex-live' },
        personaRole: 'director',
        workspaceName: 'demo',
        workspaceContextPath: contextPath,
      },
      {
        getSessionId: () => 'thread-1',
        getSessionName: () => 'session-1',
        getRuntimeEnv: () => ({ DIRECTOR_LABEL: 'demo', PERSONA_SESSION_ID: 'thread-1', PERSONA_WORKSPACE: 'demo' }),
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
      threadOptions(): Record<string, unknown>;
    };

    const options = runtimePrivate.threadOptions();
    const baseInstructions = String(options.baseInstructions);
    const developerInstructions = String(options.developerInstructions);
    expect(baseInstructions).toContain('Soul instruction');
    expect(baseInstructions).toContain('Meta instruction');
    expect(developerInstructions).toContain('Director persona instruction');
    expect(developerInstructions).toContain('当前 workspace：demo');
    expect(developerInstructions).toContain(`上下文文件：${contextPath}`);
    expect(developerInstructions).toContain('Current task state');

    rmSync(personaDir, { recursive: true, force: true });
  });
});
