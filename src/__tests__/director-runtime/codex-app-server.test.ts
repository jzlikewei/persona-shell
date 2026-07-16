import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  CodexAppServerRuntime,
  type RuntimeToolCall,
  type RuntimeWorkflowEvent,
} from '../../director-runtime/codex-app-server.js';

interface RuntimePrivateState {
  activeTurnId: string | null;
  activeResponse: string;
  liveToolOutputs: Map<string, string>;
  handleNotification(msg: { method: string; params?: Record<string, unknown>; _ts?: string }): void;
}

function createLifecycleHarness() {
  let sessionId: string | null = 'root-thread';
  const persistedThreads: string[] = [];
  const chunks: string[] = [];
  const toolCalls: Array<{ name?: string; tool?: RuntimeToolCall }> = [];
  const partialMessages: string[] = [];
  const workflowEvents: RuntimeWorkflowEvent[] = [];
  const metrics: Array<{ lastInputTokens?: number; contextTokens?: number; contextWindow?: number }> = [];
  const completions: Array<{ responseText: string; durationMs: number | null }> = [];
  const failures: string[] = [];

  const runtime = new CodexAppServerRuntime(
    {
      label: 'lifecycle-test',
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
      getSessionId: () => sessionId,
      getSessionName: () => 'session-1',
      getRuntimeEnv: () => ({ DIRECTOR_LABEL: 'test', PERSONA_SESSION_ID: sessionId ?? '', PERSONA_WORKSPACE: 'main' }),
      setSessionName: () => {},
      buildSessionName: () => 'session-1',
      persistSession: (id) => {
        sessionId = id;
        persistedThreads.push(id);
      },
      clearSession: () => { sessionId = null; },
      logOutput: () => {},
      onChunk: (text) => chunks.push(text),
      onToolCall: (name, tool) => toolCalls.push({ name, tool }),
      onPartialAgentMessage: (text) => partialMessages.push(text),
      onWorkflowEvent: (event) => workflowEvents.push(event),
      onMetrics: (update) => metrics.push(update),
      onTurnComplete: (result) => completions.push(result),
      onTurnFailure: (message) => failures.push(message),
      onRuntimeClosed: () => {},
    },
  );
  const runtimePrivate = runtime as unknown as RuntimePrivateState;
  const notify = (method: string, params: Record<string, unknown> = {}, timestamp?: string) => {
    runtimePrivate.handleNotification({ method, params, ...(timestamp ? { _ts: timestamp } : {}) });
  };

  return {
    runtime,
    runtimePrivate,
    notify,
    getSessionId: () => sessionId,
    persistedThreads,
    chunks,
    toolCalls,
    partialMessages,
    workflowEvents,
    metrics,
    completions,
    failures,
  };
}

describe('CodexAppServerRuntime', () => {
  test('maps image attachments to app-server localImage user input', () => {
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
        onWorkflowEvent: () => {},
        onMetrics: () => {},
        onTurnComplete: () => {},
        onTurnFailure: () => {},
        onRuntimeClosed: () => {},
      },
    );
    const runtimePrivate = runtime as unknown as {
      buildTurnInput(text: string, attachments: Array<{ type: 'image' | 'file'; path: string; name?: string }> | undefined): Array<Record<string, unknown>>;
    };

    expect(runtimePrivate.buildTurnInput('看图', [{ type: 'image', path: '/tmp/a.png', name: 'a.png' }])).toEqual([
      { type: 'text', text: '看图', text_elements: [] },
      { type: 'localImage', path: '/tmp/a.png', detail: 'high' },
    ]);
  });

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
        onWorkflowEvent: () => {},
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
        onWorkflowEvent: () => {},
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
          model: 'gpt-5.4',
          reasoning_effort: 'high',
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
        onWorkflowEvent: () => {},
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
      model: 'gpt-5.4',
      config: { model_reasoning_effort: 'high' },
      sessionStartSource: 'startup',
      threadSource: 'user',
    });
  });

  test('registers persona dynamic task and cron tools when mcp_mode is dynamic', () => {
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
        onWorkflowEvent: () => {},
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
    expect(dynamicTools?.map((tool) => tool.name)).toEqual([
      'create_task',
      'list_tasks',
      'get_task',
      'create_cron_job',
      'list_cron_jobs',
      'delete_cron_job',
      'update_cron_job',
      'toggle_cron_job',
    ]);
  });

  test('handles app-server item/tool/call through dynamic tool hook', async () => {
    const writes: string[] = [];
    const observedTools: Array<string | undefined> = [];
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
        onToolCall: (name) => observedTools.push(name),
        onPartialAgentMessage: () => {},
        onWorkflowEvent: () => {},
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
    expect(observedTools).toEqual([]);
  });

  test('keeps the restored primary thread when resume emits child thread notifications', async () => {
    const testDir = '/tmp/persona-codex-resume-thread-filter-test';
    const appServer = join(testDir, 'fake-codex-resume.js');
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });
    writeFileSync(
      appServer,
      String.raw`#!/usr/bin/env bun
const out = (value) => process.stdout.write(JSON.stringify(value) + '\n');
for await (const chunk of Bun.stdin.stream()) {
  const lines = new TextDecoder().decode(chunk).split('\n').filter(Boolean);
  for (const line of lines) {
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      out({ jsonrpc: '2.0', id: msg.id, result: {} });
    } else if (msg.method === 'thread/resume') {
      out({ jsonrpc: '2.0', method: 'thread/started', params: { thread: { id: 'child-during-resume', parentThreadId: 'root-resumed' } } });
      out({ jsonrpc: '2.0', method: 'thread/started', params: { thread: { id: 'root-resumed' } } });
      out({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: 'root-resumed' } } });
    } else if (msg.method === 'thread/name/set') {
      out({ jsonrpc: '2.0', id: msg.id, result: {} });
    }
  }
}
`,
      { mode: 0o755 },
    );

    let sessionId: string | null = 'root-resumed';
    const persistedThreads: string[] = [];
    const runtime = new CodexAppServerRuntime(
      {
        label: 'resume-filter-test',
        logDir: join(testDir, 'logs'),
        config: {
          persona_dir: testDir,
          pipe_dir: testDir,
          pid_file: join(testDir, 'test.pid'),
          time_sync_interval_ms: 999999,
          flush_context_limit: 999999,
          flush_interval_ms: 999999,
          quote_max_length: 32,
        },
        agent: { type: 'codex-app-server', command: appServer, name: 'codex-live' },
        personaRole: 'director',
      },
      {
        getSessionId: () => sessionId,
        getSessionName: () => 'restored session',
        getRuntimeEnv: () => ({ DIRECTOR_LABEL: 'resume-filter-test' }),
        setSessionName: () => {},
        buildSessionName: () => 'restored session',
        persistSession: (id) => {
          sessionId = id;
          persistedThreads.push(id);
        },
        clearSession: () => { sessionId = null; },
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

    try {
      expect(await runtime.start()).toBe(false);
      expect(runtime.isReady()).toBe(true);
      expect(sessionId).toBe('root-resumed');
      expect(persistedThreads.length).toBeGreaterThan(0);
      expect(persistedThreads.every((threadId) => threadId === 'root-resumed')).toBe(true);
    } finally {
      await runtime.stop();
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test('injects CLAUDE rules, soul, role persona, and workspace context into app-server thread instructions', () => {
    const personaDir = '/tmp/persona-codex-context-test';
    const contextPath = join(personaDir, 'workspaces', 'demo', 'context.md');
    rmSync(personaDir, { recursive: true, force: true });
    mkdirSync(join(personaDir, 'personas'), { recursive: true });
    mkdirSync(join(personaDir, 'workspaces', 'demo'), { recursive: true });
    writeFileSync(join(personaDir, 'CLAUDE.md'), 'Claude project rules');
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
        onWorkflowEvent: () => {},
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
    expect(baseInstructions).toContain('Claude project rules');
    expect(baseInstructions).toContain('Soul instruction');
    expect(baseInstructions).toContain('Meta instruction');
    expect(developerInstructions).toContain('Director persona instruction');
    expect(developerInstructions).toContain('当前 workspace：demo');
    expect(developerInstructions).toContain(`上下文文件：${contextPath}`);
    expect(developerInstructions).toContain('Current task state');

    rmSync(personaDir, { recursive: true, force: true });
  });

  test('streams commandExecution outputDelta as a running Bash tool', () => {
    const tools: Array<{ name?: string; tool?: unknown }> = [];
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
        onToolCall: (name, tool) => tools.push({ name, tool }),
        onPartialAgentMessage: () => {},
        onWorkflowEvent: () => {},
        onMetrics: () => {},
        onTurnComplete: () => {},
        onTurnFailure: () => {},
        onRuntimeClosed: () => {},
      },
    );
    const runtimePrivate = runtime as unknown as {
      handleNotification(msg: { method: string; params: Record<string, unknown>; _ts?: string }): void;
    };

    runtimePrivate.handleNotification({
      method: 'item/started',
      _ts: '2026-06-10T15:44:00.000Z',
      params: { item: { type: 'commandExecution', id: 'call-1', command: 'echo hi', cwd: '/tmp', status: 'inProgress' } },
    });
    runtimePrivate.handleNotification({
      method: 'item/commandExecution/outputDelta',
      _ts: '2026-06-10T15:44:01.000Z',
      params: { itemId: 'call-1', delta: 'hello' },
    });
    runtimePrivate.handleNotification({
      method: 'item/commandExecution/outputDelta',
      _ts: '2026-06-10T15:44:02.000Z',
      params: { itemId: 'call-1', delta: '\nworld' },
    });
    runtimePrivate.handleNotification({
      method: 'item/completed',
      _ts: '2026-06-10T15:44:03.000Z',
      params: { item: { type: 'commandExecution', id: 'call-1', command: 'echo hi', cwd: '/tmp', status: 'completed', exitCode: 0, aggregatedOutput: 'hello\nworld' } },
    });

    expect(tools).toHaveLength(4);
    expect(tools[0].tool).toMatchObject({ id: 'call-1', name: 'Bash', status: 'running', input: '{\n  "command": "echo hi",\n  "cwd": "/tmp"\n}' });
    expect(tools[1].tool).toMatchObject({ id: 'call-1', name: 'Bash', status: 'running', result: 'hello' });
    expect(tools[2].tool).toMatchObject({ id: 'call-1', name: 'Bash', status: 'running', result: 'hello\nworld' });
    expect(tools[3].tool).toMatchObject({ id: 'call-1', name: 'Bash', status: 'completed', isError: false });
  });


  test('emits goal and plan workflow updates from app-server notifications', () => {
    const workflowEvents: unknown[] = [];
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
        onWorkflowEvent: (event) => workflowEvents.push(event),
        onMetrics: () => {},
        onTurnComplete: () => {},
        onTurnFailure: () => {},
        onRuntimeClosed: () => {},
      },
    );
    const runtimePrivate = runtime as unknown as {
      handleNotification(msg: { method: string; params: Record<string, unknown>; _ts?: string }): void;
    };

    runtimePrivate.handleNotification({
      method: 'thread/goal/updated',
      _ts: '2026-06-11T00:00:00.000Z',
      params: { turnId: 'turn-1', goal: { objective: 'ship workflow UI', status: 'active', tokensUsed: 12, timeUsedSeconds: 3 } },
    });
    runtimePrivate.handleNotification({
      method: 'turn/plan/updated',
      _ts: '2026-06-11T00:00:01.000Z',
      params: { turnId: 'turn-1', explanation: 'working', plan: [{ step: 'wire backend', status: 'completed' }, { step: 'render frontend', status: 'in_progress' }] },
    });
    runtimePrivate.handleNotification({
      method: 'turn/started',
      _ts: '2026-06-11T00:00:01.500Z',
      params: { turnId: 'turn-2' },
    });
    runtimePrivate.handleNotification({
      method: 'thread/goal/updated',
      _ts: '2026-06-11T00:00:02.000Z',
      params: { threadId: 'thread-1', turnId: null, goal: { threadId: 'thread-1', objective: 'ship workflow UI', status: 'complete', tokensUsed: 99, timeUsedSeconds: 10 } },
    });

    expect(workflowEvents).toEqual([
      {
        type: 'goal_updated',
        turnId: 'turn-1',
        goal: { objective: 'ship workflow UI', status: 'active', tokensUsed: 12, timeUsedSeconds: 3 },
        timestamp: '2026-06-11T00:00:00.000Z',
      },
      {
        type: 'plan_updated',
        turnId: 'turn-1',
        plan: [{ step: 'wire backend', status: 'completed' }, { step: 'render frontend', status: 'in_progress' }],
        explanation: 'working',
        timestamp: '2026-06-11T00:00:01.000Z',
      },
      {
        type: 'goal_updated',
        turnId: 'turn-2',
        goal: { objective: 'ship workflow UI', status: 'complete', tokensUsed: 99, timeUsedSeconds: 10 },
        timestamp: '2026-06-11T00:00:02.000Z',
      },
    ]);
  });

  test('keeps primary turn state isolated from multiple child threads completing out of stack order', () => {
    const harness = createLifecycleHarness();
    const { notify, runtime, runtimePrivate } = harness;

    notify('turn/started', {
      threadId: 'root-thread',
      turn: { id: 'root-turn', status: 'inProgress' },
    });
    notify('thread/started', { thread: { id: 'child-thread-a', parentThreadId: 'root-thread' } });
    notify('turn/started', {
      threadId: 'child-thread-a',
      turn: { id: 'child-turn-a', status: 'inProgress' },
    });
    notify('turn/started', {
      threadId: 'child-thread-b',
      turn: { id: 'child-turn-b', status: 'inProgress' },
    });
    notify('item/agentMessage/delta', {
      threadId: 'child-thread-a',
      turnId: 'child-turn-a',
      itemId: 'child-message-a',
      delta: 'child response',
    });
    notify('item/started', {
      threadId: 'child-thread-b',
      turnId: 'child-turn-b',
      item: { type: 'commandExecution', id: 'child-call', command: 'echo child', status: 'inProgress' },
    });
    notify('item/commandExecution/outputDelta', {
      threadId: 'child-thread-b',
      turnId: 'child-turn-b',
      itemId: 'child-call',
      delta: 'child output',
    });
    notify('item/completed', {
      threadId: 'child-thread-a',
      turnId: 'child-turn-a',
      item: { type: 'agentMessage', id: 'child-message-a', text: 'child response' },
    });
    notify('turn/plan/updated', {
      threadId: 'child-thread-b',
      turnId: 'child-turn-b',
      plan: [{ step: 'child step', status: 'completed' }],
    });
    notify('thread/goal/updated', {
      threadId: 'child-thread-a',
      turnId: 'child-turn-a',
      goal: { objective: 'child goal', status: 'complete' },
    });
    notify('thread/tokenUsage/updated', {
      threadId: 'child-thread-b',
      turnId: 'child-turn-b',
      tokenUsage: { last: { inputTokens: 999 }, modelContextWindow: 1000 },
    });

    // A started before B and also completes before B: completion is intentionally not LIFO.
    notify('turn/completed', {
      threadId: 'child-thread-a',
      turn: { id: 'child-turn-a', status: 'completed', items: [{ type: 'agentMessage', text: 'child A done' }] },
    });
    notify('turn/completed', {
      threadId: 'child-thread-b',
      turn: { id: 'child-turn-b', status: 'completed', items: [{ type: 'agentMessage', text: 'child B done' }] },
    });

    expect(runtime.hasActiveTurn()).toBe(true);
    expect(runtimePrivate.activeTurnId).toBe('root-turn');
    expect(runtimePrivate.activeResponse).toBe('');
    expect(runtimePrivate.liveToolOutputs.size).toBe(0);
    expect(harness.getSessionId()).toBe('root-thread');
    expect(harness.persistedThreads).toEqual([]);
    expect(harness.chunks).toEqual([]);
    expect(harness.toolCalls).toEqual([]);
    expect(harness.partialMessages).toEqual([]);
    expect(harness.workflowEvents).toEqual([]);
    expect(harness.metrics).toEqual([]);
    expect(harness.completions).toEqual([]);
    expect(harness.failures).toEqual([]);

    notify('item/started', {
      threadId: 'root-thread',
      turnId: 'root-turn',
      item: { type: 'commandExecution', id: 'root-call', command: 'echo root', status: 'inProgress' },
    });
    notify('item/commandExecution/outputDelta', {
      threadId: 'root-thread',
      turnId: 'root-turn',
      itemId: 'root-call',
      delta: 'root output',
    });
    notify('item/completed', {
      threadId: 'root-thread',
      turnId: 'root-turn',
      item: { type: 'commandExecution', id: 'root-call', command: 'echo root', status: 'completed', exitCode: 0 },
    });
    notify('item/agentMessage/delta', {
      threadId: 'root-thread',
      turnId: 'root-turn',
      itemId: 'root-message',
      delta: 'root ',
    });
    notify('item/agentMessage/delta', {
      threadId: 'root-thread',
      turnId: 'root-turn',
      itemId: 'root-message',
      delta: 'answer',
    });
    notify('item/completed', {
      threadId: 'root-thread',
      turnId: 'root-turn',
      item: { type: 'agentMessage', id: 'root-message', text: 'root answer' },
    });
    notify('turn/plan/updated', {
      threadId: 'root-thread',
      turnId: 'root-turn',
      explanation: 'root work',
      plan: [{ step: 'root step', status: 'completed' }],
    });
    notify('thread/goal/updated', {
      threadId: 'root-thread',
      turnId: 'root-turn',
      goal: { objective: 'root goal', status: 'complete' },
    });
    notify('thread/tokenUsage/updated', {
      threadId: 'root-thread',
      turnId: 'root-turn',
      tokenUsage: { last: { inputTokens: 123 }, modelContextWindow: 1000 },
    });
    notify('turn/completed', {
      threadId: 'root-thread',
      turn: { id: 'root-turn', status: 'completed', durationMs: 42, items: [] },
    });

    expect(runtime.hasActiveTurn()).toBe(false);
    expect(runtimePrivate.activeTurnId).toBeNull();
    expect(runtimePrivate.activeResponse).toBe('');
    expect(harness.chunks).toEqual(['root ', 'answer']);
    expect(harness.toolCalls).toHaveLength(3);
    expect(harness.toolCalls.every((call) => call.tool?.id === 'root-call')).toBe(true);
    expect(harness.partialMessages).toEqual(['root answer']);
    expect(harness.workflowEvents.map((event) => event.type)).toEqual(['plan_updated', 'goal_updated']);
    expect(harness.metrics).toEqual([{ lastInputTokens: 123, contextTokens: 123, contextWindow: 1000 }]);
    expect(harness.completions).toEqual([{ responseText: 'root answer', durationMs: 42 }]);
    expect(harness.failures).toEqual([]);
  });

  test('ignores child failures while preserving primary and global error semantics', () => {
    const harness = createLifecycleHarness();
    const { notify, runtimePrivate } = harness;

    notify('turn/started', { threadId: 'root-thread', turn: { id: 'root-failed-turn' } });
    notify('turn/completed', {
      threadId: 'child-thread',
      turn: { id: 'child-failed-turn', status: 'failed', error: { message: 'child turn failed' } },
    });
    notify('error', {
      threadId: 'child-thread',
      turnId: 'child-failed-turn',
      error: { message: 'child runtime error' },
    });

    expect(runtimePrivate.activeTurnId).toBe('root-failed-turn');
    expect(harness.failures).toEqual([]);

    notify('turn/completed', {
      threadId: 'root-thread',
      turn: { id: 'root-failed-turn', status: 'failed', error: { message: 'root turn failed' } },
    });
    expect(harness.failures).toEqual(['root turn failed']);
    expect(runtimePrivate.activeTurnId).toBeNull();

    notify('turn/started', { threadId: 'root-thread', turn: { id: 'root-error-turn' } });
    notify('error', {
      threadId: 'root-thread',
      turnId: 'root-error-turn',
      error: { message: 'root runtime error' },
    });
    expect(harness.failures).toEqual(['root turn failed', 'root runtime error']);
    expect(runtimePrivate.activeTurnId).toBeNull();

    notify('turn/started', { threadId: 'root-thread', turn: { id: 'root-global-error-turn' } });
    notify('error', { error: { message: 'global transport error' } });
    expect(harness.failures).toEqual(['root turn failed', 'root runtime error', 'global transport error']);
    expect(runtimePrivate.activeTurnId).toBeNull();
    expect(harness.completions).toEqual([]);
  });

});
