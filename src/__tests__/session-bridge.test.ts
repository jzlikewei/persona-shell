import { beforeEach, describe, expect, test, spyOn } from 'bun:test';
import { existsSync, readFileSync } from 'fs';
import { SessionBridge } from '../session-bridge.js';
import { initTaskStore, setState } from '../task/task-store.js';
import { initLogDir } from '../logger.js';
import type { AgentProviderConfig } from '../config.js';
import type {
  DirectorSessionAdapter,
  DirectorSessionAdapterHooks,
  DirectorSessionAdapterOptions,
  AssistantTurnEvent,
  DirectorToolCall,
  DirectorTurnResult,
} from '../director-session-adapter/index.js';
import type { DirectorRuntimeStatus, DirectorSendResult } from '../director-runtime/index.js';

class FakeAdapter implements DirectorSessionAdapter {
  static instances: FakeAdapter[] = [];

  readonly sent: string[] = [];
  readonly terminations: NodeJS.Signals[] = [];
  ready = true;
  activeTurn = false;
  nextSendResult: DirectorSendResult | void = undefined;
  shouldWaitOnShutdown = false;
  skipInterruptWhileFlushing = false;
  trackRestartBackoff = false;
  status: DirectorRuntimeStatus = { kind: 'codex-turn-based', alive: true, pid: null };

  constructor(
    readonly options: DirectorSessionAdapterOptions,
    readonly hooks: DirectorSessionAdapterHooks,
  ) {
    FakeAdapter.instances.push(this);
  }

  async start(): Promise<boolean> {
    this.hooks.restorePersistedSession();
    return true;
  }

  isReady(): boolean {
    return this.ready;
  }

  getStatus(): DirectorRuntimeStatus {
    return this.status;
  }

  hasActiveTurn(): boolean {
    return this.activeTurn;
  }

  async send(content: string): Promise<DirectorSendResult | void> {
    this.sent.push(content);
    return this.nextSendResult;
  }

  interrupt(): void {
    this.terminations.push('SIGINT');
  }

  async stop(): Promise<void> {}

  terminate(signal: NodeJS.Signals): void {
    this.terminations.push(signal);
  }

  async prepareShutdown(): Promise<boolean> {
    return this.shouldWaitOnShutdown;
  }

  restartCalls = 0;

  async restartTransport(): Promise<void> {
    this.restartCalls += 1;
  }

  describeSessionReady(label: string, sessionId: string | null, sessionName: string | null): string {
    return `[bridge:${label}] fake ready ${sessionId ?? 'new'} ${sessionName ?? ''}`.trim();
  }

  describeInterruptTarget(): string | null {
    return this.status.pid ? `(pid: ${this.status.pid})` : null;
  }

  shouldSkipInterruptWhileFlushing(): boolean {
    return this.skipInterruptWhileFlushing;
  }

  shouldTrackRestartBackoff(): boolean {
    return this.trackRestartBackoff;
  }

  completeTurn(result: DirectorTurnResult): void {
    this.hooks.onTurnComplete(result);
  }

  failTurn(message: string): void {
    this.hooks.onTurnFailure(message);
  }

  closeRuntime(): Promise<void> | void {
    return this.hooks.onRuntimeClosed();
  }
}

describe('SessionBridge', () => {
  beforeEach(() => {
    FakeAdapter.instances = [];
    initTaskStore('/tmp/persona-test');
    initLogDir('/tmp/persona-test');
  });

  test('dispatches user responses through adapter turn completion', async () => {
    const bridge = createBridge();
    const adapter = FakeAdapter.instances[0]!;
    const onResponse = spyOn(bridge, 'emit');

    await bridge.start();
    await bridge.send('hello');
    adapter.completeTurn({ responseText: 'world', durationMs: 12 });

    expect(adapter.sent.at(-1)?.endsWith('hello')).toBe(true);
    expect(onResponse).toHaveBeenCalledWith('response', 'world', 12);
    expect(bridge.getStatus().pendingCount).toBe(0);
  });

  test('absorbs bootstrap turn without emitting response', async () => {
    const bridge = createBridge();
    const adapter = FakeAdapter.instances[0]!;
    const onEmit = spyOn(bridge, 'emit');

    await bridge.start();
    const bootstrapPromise = bridge.bootstrap();
    adapter.completeTurn({ responseText: 'boot ok', durationMs: 5 });
    await bootstrapPromise;

    expect(adapter.sent).toHaveLength(1);
    expect(onEmit.mock.calls.some((call) => call[0] === 'response')).toBe(false);
    expect(bridge.getStatus().pendingCount).toBe(0);
  });

  test('bootstrap guidance tells director to trust MCP tools over localhost probes', async () => {
    const bridge = createBridge();
    const adapter = FakeAdapter.instances[0]!;

    await bridge.start();
    const bootstrapPromise = bridge.bootstrap();

    expect(adapter.sent[0]).toContain('不要用 curl localhost:3000、launchctl');
    expect(adapter.sent[0]).toContain('直接调用 MCP 工具 create_task / list_tasks');

    adapter.completeTurn({ responseText: 'boot ok', durationMs: 5 });
    await bootstrapPromise;
  });

  test('uses adapter capability methods for shutdown path', async () => {
    const bridge = createBridge();
    const adapter = FakeAdapter.instances[0]!;
    adapter.shouldWaitOnShutdown = true;
    await bridge.start();

    const shutdownPromise = bridge.shutdown();
    await Promise.resolve();
    expect(adapter.terminations).toEqual(['SIGTERM']);

    await adapter.closeRuntime();
    await shutdownPromise;
  });

  test('clearContext restarts transport without bootstrap', async () => {
    const bridge = createBridge();
    const adapter = FakeAdapter.instances[0]!;
    await bridge.start();
    adapter.hooks.onMetrics({ lastInputTokens: 5000, contextTokens: 5000 });

    const success = await bridge.clearContext();

    expect(success).toBe(true);
    expect(adapter.terminations).toEqual(['SIGTERM']);
    expect(adapter.restartCalls).toBe(1);
    expect(adapter.sent).toHaveLength(0);
    expect(bridge.isFlushing).toBe(false);
    expect(bridge.getStatus().contextMetricsLive).toBe(false);
  });

  test('clearContext ignores stale close event from old runtime', async () => {
    const bridge = createBridge();
    const oldAdapter = FakeAdapter.instances[0]!;
    await bridge.start();

    const success = await bridge.clearContext();
    expect(success).toBe(true);

    const onEmit = spyOn(bridge, 'emit');
    // Simulate delayed close from the old runtime — should be ignored
    await oldAdapter.closeRuntime();

    expect(onEmit.mock.calls.some((call) => call[0] === 'alert')).toBe(false);
    expect(onEmit.mock.calls.some((call) => call[0] === 'stream-abort')).toBe(false);
    expect(bridge.isFlushing).toBe(false);
  });

  test('clearContext consumes stale close but real unexpected close still triggers recovery', async () => {
    const bridge = createBridge();
    const adapter = FakeAdapter.instances[0]!;
    await bridge.start();

    const success = await bridge.clearContext();
    expect(success).toBe(true);

    // Stale close from old runtime — should be ignored
    await adapter.closeRuntime();

    // Second close on same adapter simulates new runtime unexpected exit
    const onEmit = spyOn(bridge, 'emit');
    await adapter.closeRuntime();

    expect(onEmit.mock.calls.some((call) => call[0] === 'stream-abort')).toBe(true);
  });

  test('sendSystemMessage enqueues system-absorbed turn and absorbs response', async () => {
    const bridge = createBridge();
    const adapter = FakeAdapter.instances[0]!;
    const onEmit = spyOn(bridge, 'emit');

    await bridge.start();
    await bridge.sendSystemMessage('system info');
    adapter.completeTurn({ responseText: 'ack', durationMs: 5 });

    // system-absorbed should NOT emit 'response' to the user
    expect(onEmit.mock.calls.some((call) => call[0] === 'response')).toBe(false);
    expect(bridge.getStatus().pendingCount).toBe(0);
  });

  test('sendCronMessage emits cron-response on turn completion', async () => {
    const bridge = createBridge();
    const adapter = FakeAdapter.instances[0]!;
    const onEmit = spyOn(bridge, 'emit');

    await bridge.start();
    await bridge.sendCronMessage('cron trigger');
    adapter.completeTurn({ responseText: 'cron result', durationMs: 10 });

    expect(onEmit).toHaveBeenCalledWith('cron-response', 'cron result');
    // Should NOT emit regular 'response'
    expect(onEmit.mock.calls.some((call) => call[0] === 'response')).toBe(false);
  });

  test('notifyTaskDone with replyToMessageId emits system-response', async () => {
    const bridge = createBridge();
    const adapter = FakeAdapter.instances[0]!;
    const onEmit = spyOn(bridge, 'emit');

    await bridge.start();
    await bridge.notifyTaskDone('task-1', true, 'msg-123');
    adapter.completeTurn({ responseText: 'task report', durationMs: 20 });

    expect(onEmit).toHaveBeenCalledWith('system-response', 'task report', 'msg-123');
    expect(onEmit.mock.calls.some((call) => call[0] === 'response')).toBe(false);
  });

  test('notifyTaskDone sends immediately even when a turn is active (queued as pending)', async () => {
    const bridge = createBridge();
    const adapter = FakeAdapter.instances[0]!;
    const responses: Array<{ text: string; replyToMessageId: string }> = [];
    bridge.on('system-response', (text: string, replyToMessageId: string) => {
      responses.push({ text, replyToMessageId });
    });

    await bridge.start();
    await bridge.send('user message');
    adapter.activeTurn = true;

    await bridge.notifyTaskDone('task-1', true, 'msg-1');
    await bridge.notifyTaskDone('task-2', true, 'msg-2');

    // Notifications are sent immediately through the normal queue
    expect(adapter.sent).toHaveLength(3);
    expect(adapter.sent[0]?.endsWith('user message')).toBe(true);
    expect(adapter.sent[1]).toContain('task-1');
    expect(adapter.sent[2]).toContain('task-2');

    adapter.activeTurn = false;
    adapter.completeTurn({ responseText: 'user response', durationMs: 10 });
    adapter.completeTurn({ responseText: 'task one report', durationMs: 10 });
    adapter.completeTurn({ responseText: 'task two report', durationMs: 10 });

    expect(responses).toEqual([
      { text: 'task one report', replyToMessageId: 'msg-1' },
      { text: 'task two report', replyToMessageId: 'msg-2' },
    ]);
  });

  test('steered system-reply aborts its streaming card instead of leaving it pending', async () => {
    const bridge = createBridge();
    const adapter = FakeAdapter.instances[0]!;
    const aborts: Array<{ replyToMessageId: string; text?: string }> = [];
    bridge.on('system-stream-abort', (replyToMessageId: string, text?: string) => {
      aborts.push({ replyToMessageId, text });
    });

    await bridge.start();
    adapter.nextSendResult = 'steered';
    await bridge.notifyTaskDone('task-1', true, 'msg-1');
    await Promise.resolve();

    expect(aborts).toEqual([{ replyToMessageId: 'msg-1', text: '已并入当前处理中' }]);
    expect(bridge.getStatus().pendingCount).toBe(0);
  });

  test('notifyTaskDone emits system-tool-call with tool name', async () => {
    const bridge = createBridge();
    const adapter = FakeAdapter.instances[0]!;
    const toolCalls: Array<{ replyToMessageId: string; toolName?: string }> = [];
    bridge.on('system-tool-call', (replyToMessageId: string, toolName?: string) => {
      toolCalls.push({ replyToMessageId, toolName });
    });

    await bridge.start();
    await bridge.notifyTaskDone('task-1', true, 'msg-123');
    adapter.hooks.onToolCall('read_file');

    expect(toolCalls).toEqual([{ replyToMessageId: 'msg-123', toolName: 'read_file' }]);
    adapter.completeTurn({ responseText: 'task report', durationMs: 20 });
  });

  test('handleTurnFailure emits error response for user turn', async () => {
    const bridge = createBridge();
    const adapter = FakeAdapter.instances[0]!;
    const onEmit = spyOn(bridge, 'emit');

    await bridge.start();
    await bridge.send('hello');
    adapter.failTurn('API error');

    expect(onEmit).toHaveBeenCalledWith('response', '处理失败，请稍后重试');
    expect(onEmit).toHaveBeenCalledWith('alert', expect.stringContaining('API error'));
  });

  test('handleTurnFailure resolves bootstrap without emitting response', async () => {
    const bridge = createBridge();
    const adapter = FakeAdapter.instances[0]!;
    const onEmit = spyOn(bridge, 'emit');

    await bridge.start();
    const bootstrapPromise = bridge.bootstrap();
    adapter.failTurn('timeout');
    await bootstrapPromise;

    // Should NOT emit 'response' for bootstrap failure
    expect(onEmit.mock.calls.some((call) => call[0] === 'response')).toBe(false);
    expect(bridge.getStatus().pendingCount).toBe(0);
  });

  test('empty response text does not emit response event', async () => {
    const bridge = createBridge();
    const adapter = FakeAdapter.instances[0]!;
    const onEmit = spyOn(bridge, 'emit');

    await bridge.start();
    await bridge.send('hello');
    adapter.completeTurn({ responseText: '', durationMs: 5 });

    expect(onEmit.mock.calls.some((call) => call[0] === 'response')).toBe(false);
  });

  test('whitespace-only response text does not emit response event', async () => {
    const bridge = createBridge();
    const adapter = FakeAdapter.instances[0]!;
    const onEmit = spyOn(bridge, 'emit');

    await bridge.start();
    await bridge.send('hello');
    adapter.completeTurn({ responseText: '   \n  ', durationMs: 5 });

    expect(onEmit.mock.calls.some((call) => call[0] === 'response')).toBe(false);
  });

  test('getStatus returns correct activity states', async () => {
    const bridge = createBridge();
    await bridge.start();

    expect(bridge.getStatus().activityState).toBe('idle');
    expect(bridge.getStatus().pendingCount).toBe(0);
  });

  test('send throws when adapter is not ready', async () => {
    const bridge = createBridge();
    const adapter = FakeAdapter.instances[0]!;
    adapter.ready = false;
    await bridge.start();

    expect(bridge.send('hello')).rejects.toThrow();
  });

  test('multiple pending turns resolve in order', async () => {
    const bridge = createBridge();
    const adapter = FakeAdapter.instances[0]!;
    const responses: string[] = [];

    bridge.on('response', (reply: string) => responses.push(reply));

    await bridge.start();
    await bridge.send('first');
    await bridge.send('second');

    adapter.completeTurn({ responseText: 'reply-1', durationMs: 5 });
    adapter.completeTurn({ responseText: 'reply-2', durationMs: 5 });

    expect(responses).toEqual(['reply-1', 'reply-2']);
    expect(bridge.getStatus().pendingCount).toBe(0);
  });

  test('steered user message is removed from pending queue and does not get its own response', async () => {
    const bridge = createBridge();
    const adapter = FakeAdapter.instances[0]!;
    const responses: string[] = [];
    const steered: Array<string | undefined> = [];
    bridge.on('response', (reply: string) => responses.push(reply));
    bridge.on('message-steered', (correlationId?: string) => steered.push(correlationId));

    await bridge.start();
    await bridge.send('first');
    adapter.nextSendResult = 'steered';
    await bridge.send('second', { correlationId: 'cid-second' });
    adapter.nextSendResult = undefined;

    expect(bridge.getStatus().pendingCount).toBe(1);
    expect(steered).toEqual(['cid-second']);

    adapter.completeTurn({ responseText: 'combined reply', durationMs: 5 });

    expect(responses).toEqual(['combined reply']);
    expect(bridge.getStatus().pendingCount).toBe(0);
  });

  test('expectResponse false inserts into the active turn without adding a pending response', async () => {
    const bridge = createBridge();
    const adapter = FakeAdapter.instances[0]!;
    const responses: string[] = [];
    const steered: Array<string | undefined> = [];
    bridge.on('response', (reply: string) => responses.push(reply));
    bridge.on('message-steered', (correlationId?: string) => steered.push(correlationId));

    await bridge.start();
    await bridge.send('first', { correlationId: 'cid-first' });
    adapter.nextSendResult = 'steered';
    await bridge.send('inserted', { expectResponse: false });
    adapter.nextSendResult = undefined;

    expect(adapter.sent[0]).toContain('first');
    expect(adapter.sent[1]).toBe('inserted');
    expect(bridge.getStatus().pendingCount).toBe(1);
    expect(steered).toEqual([]);

    adapter.completeTurn({ responseText: 'combined reply', durationMs: 5 });

    expect(responses).toEqual(['combined reply']);
    expect(bridge.getStatus().pendingCount).toBe(0);
  });

  // ---- 1. Time Sync ----

  test('send prepends time prefix when time_sync_interval_ms is 0', async () => {
    const bridge = createBridgeWithOptions({ timeSyncIntervalMs: 0 });
    const adapter = FakeAdapter.instances.at(-1)!;
    await bridge.start();
    await bridge.send('test message');
    expect(adapter.sent.at(-1)!).toMatch(/^\[.+\] test message$/);
    adapter.completeTurn({ responseText: 'ok', durationMs: 1 });
  });

  // ---- 2. Flush ----

  test('flush returns false when already flushing', async () => {
    const bridge = createBridgeWithOptions({ isMain: true });
    const adapter = FakeAdapter.instances.at(-1)!;
    await bridge.start();
    const flushPromise = bridge.flush();
    expect(await bridge.flush()).toBe(false);
    // cleanup
    adapter.completeTurn({ responseText: '已保存', durationMs: 1 });
    await new Promise(r => setTimeout(r, 50));
    adapter.completeTurn({ responseText: 'ok', durationMs: 1 });
    await flushPromise;
  });

  test('flush on non-main bridge does checkpoint, terminate, restart, bootstrap', async () => {
    const bridge = createBridgeWithOptions({ isMain: false });
    const adapter = FakeAdapter.instances.at(-1)!;
    await bridge.start();
    const flushPromise = bridge.flush();
    await new Promise(r => setTimeout(r, 10));
    // Non-main now sends checkpoint message
    expect(adapter.sent.some(s => s.includes('[FLUSH]'))).toBe(true);
    // Complete checkpoint
    adapter.completeTurn({ responseText: '已保存', durationMs: 1 });
    await new Promise(r => setTimeout(r, 50));
    // Complete bootstrap
    adapter.completeTurn({ responseText: 'restored', durationMs: 1 });
    expect(await flushPromise).toBe(true);
    expect(adapter.terminations).toContain('SIGTERM');
    expect(adapter.restartCalls).toBe(1);
    expect(bridge.isFlushing).toBe(false);
  });

  test('flush on main bridge does checkpoint, terminate, restart, bootstrap', async () => {
    const bridge = createBridgeWithOptions({ isMain: true });
    const adapter = FakeAdapter.instances.at(-1)!;
    await bridge.start();
    const flushPromise = bridge.flush();
    await new Promise(r => setTimeout(r, 10));
    expect(adapter.sent.some(s => s.includes('[FLUSH]'))).toBe(true);
    adapter.completeTurn({ responseText: '已保存', durationMs: 1 });
    await new Promise(r => setTimeout(r, 50));
    expect(adapter.sent.length).toBeGreaterThanOrEqual(2);
    adapter.completeTurn({ responseText: 'restored', durationMs: 1 });
    expect(await flushPromise).toBe(true);
    expect(adapter.terminations).toContain('SIGTERM');
    expect(bridge.isFlushing).toBe(false);
  });

  test('flush drains pending messages before starting checkpoint', async () => {
    const bridge = createBridgeWithOptions({ isMain: true });
    const adapter = FakeAdapter.instances.at(-1)!;
    const events: string[] = [];
    bridge.on('flush-drain-complete', () => events.push('drain-done'));
    await bridge.start();
    await bridge.send('in-flight');
    const flushPromise = bridge.flush();
    adapter.completeTurn({ responseText: 'reply', durationMs: 1 });
    await new Promise(r => setTimeout(r, 50));
    expect(events).toContain('drain-done');
    adapter.completeTurn({ responseText: '已保存', durationMs: 1 });
    await new Promise(r => setTimeout(r, 50));
    adapter.completeTurn({ responseText: 'ok', durationMs: 1 });
    await flushPromise;
  });

  test('switchAgent checkpoints, rebuilds adapter, bootstraps, and persists agent state', async () => {
    const bridge = createBridgeWithOptions({ isMain: false, providerName: 'fake-claude', directorAgentName: 'fake-claude' });
    const initialAdapter = FakeAdapter.instances.at(-1)!;
    await bridge.start();

    // Simulate session establishment so switchAgent enters the checkpoint branch
    initialAdapter.hooks.persistSession('test-session-id', 'test-session');

    const switchPromise = bridge.switchAgent('fake-codex');
    await new Promise(r => setTimeout(r, 10));

    expect(initialAdapter.sent[0]).toContain('切换到 fake-codex');
    expect(initialAdapter.sent[0]).toContain('workspaces/Test Group/context.md');

    initialAdapter.completeTurn({ responseText: '已保存', durationMs: 1 });
    await new Promise(r => setTimeout(r, 10));

    const switchedAdapter = FakeAdapter.instances.at(-1)!;
    expect(switchedAdapter).not.toBe(initialAdapter);
    expect(switchedAdapter.options.directorAgent.name).toBe('fake-codex');
    expect(switchedAdapter.sent[0]).toContain('workspaces/Test Group/context.md');
    expect(switchedAdapter.sent[0]).toContain('恢复这个会话的上下文');
    expect(existsSync('/tmp/persona-test/workspaces/Test Group/context.md')).toBe(true);

    switchedAdapter.completeTurn({ responseText: 'restored', durationMs: 1 });
    await expect(switchPromise).resolves.toBe(true);
    expect(bridge.getDirectorAgentName()).toBe('fake-codex');
    expect(bridge.isFlushing).toBe(false);

    const restored = createBridgeWithOptions({ isMain: false, providerName: 'fake', directorAgentName: undefined });
    expect(restored.getDirectorAgentName()).toBe('fake-codex');
  });

  test('switchAgent on main session restores from daily state and updates legacy agent key', async () => {
    const bridge = createBridgeWithOptions({ isMain: true, providerName: 'fake-claude', directorAgentName: 'fake-claude', label: 'main' });
    const initialAdapter = FakeAdapter.instances.at(-1)!;
    await bridge.start();

    const switchPromise = bridge.switchAgent('fake-codex');
    await new Promise(r => setTimeout(r, 10));
    initialAdapter.completeTurn({ responseText: '已保存', durationMs: 1 });
    await new Promise(r => setTimeout(r, 10));

    const switchedAdapter = FakeAdapter.instances.at(-1)!;
    expect(switchedAdapter.sent[0]).toContain('daily/state.md');
    switchedAdapter.completeTurn({ responseText: 'restored', durationMs: 1 });

    await expect(switchPromise).resolves.toBe(true);
    const restored = createBridgeWithOptions({ isMain: true, providerName: 'fake', directorAgentName: undefined, label: 'main' });
    expect(restored.getDirectorAgentName()).toBe('fake-codex');
  });

  // ---- 3. handleStreamChunk ----

  test('handleStreamChunk emits chunk event for user turn', async () => {
    const bridge = createBridge();
    const adapter = FakeAdapter.instances.at(-1)!;
    const chunks: string[] = [];
    bridge.on('chunk', (t: string) => chunks.push(t));
    await bridge.start();
    await bridge.send('hello');
    adapter.hooks.onChunk('partial');
    expect(chunks).toEqual(['partial']);
    adapter.completeTurn({ responseText: 'done', durationMs: 1 });
  });

  test('handleToolCall emits tool-call event with tool name for user turn', async () => {
    const bridge = createBridge();
    const adapter = FakeAdapter.instances.at(-1)!;
    const toolCalls: Array<string | undefined> = [];
    bridge.on('tool-call', (toolName?: string) => toolCalls.push(toolName));
    await bridge.start();
    await bridge.send('hello');
    adapter.hooks.onToolCall('bash');
    expect(toolCalls).toEqual(['bash']);
    adapter.completeTurn({ responseText: 'done', durationMs: 1 });
  });

  test('user turn emits unified turn events with deltas, tools and completion on one turnId', async () => {
    const bridge = createBridge();
    const adapter = FakeAdapter.instances.at(-1)!;
    const events: AssistantTurnEvent[] = [];
    bridge.on('turn-event', (event: AssistantTurnEvent) => events.push(event));

    await bridge.start();
    await bridge.send('hello', { correlationId: 'msg-1' });

    adapter.hooks.onChunk('I will inspect it.');
    adapter.hooks.onToolCall('Bash');
    adapter.hooks.onToolCall('Bash', {
      id: 'tool-1',
      name: 'Bash',
      input: '{ "command": "pwd" }',
      result: '/tmp/workspace',
      isError: false,
    });
    adapter.completeTurn({ responseText: 'I will inspect it.\nDone.', durationMs: 12 });

    expect(events.map(event => event.type)).toEqual([
      'turn_started',
      'assistant_delta',
      'tool_started',
      'tool_completed',
      'turn_completed',
    ]);
    expect(new Set(events.map(event => event.turnId)).size).toBe(1);
    expect(events[0].messageId).toBe('msg-1');
    expect(events.find(event => event.type === 'assistant_delta')?.text).toBe('I will inspect it.');
    const startedTool = events.find(event => event.type === 'tool_started')?.tool;
    expect(startedTool).toMatchObject({ name: 'Bash', status: 'running' });
    const completedTool = events.find(event => event.type === 'tool_completed')?.tool;
    expect(completedTool).toMatchObject({
      id: 'tool-1',
      name: 'Bash',
      input: '{ "command": "pwd" }',
      result: '/tmp/workspace',
      isError: false,
      status: 'completed',
    } satisfies DirectorToolCall);
    expect(events.at(-1)).toMatchObject({
      type: 'turn_completed',
      content: 'I will inspect it.\nDone.',
      durationMs: 12,
    });
  });

  test('system reply turn emits unified turn events with tool structure', async () => {
    const bridge = createBridge();
    const adapter = FakeAdapter.instances.at(-1)!;
    const events: AssistantTurnEvent[] = [];
    bridge.on('turn-event', (event: AssistantTurnEvent) => events.push(event));

    await bridge.start();
    await bridge.notifyTaskDone('task-1', true, 'msg-1');
    adapter.hooks.onToolCall('Read', {
      id: 'tool-system-1',
      name: 'Read',
      input: '/tmp/a.txt',
      result: 'ok',
      isError: false,
    });
    adapter.completeTurn({ responseText: 'task acknowledged', durationMs: 3 });

    expect(events.map(event => event.type)).toEqual([
      'turn_started',
      'tool_completed',
      'turn_completed',
    ]);
    expect(new Set(events.map(event => event.turnId)).size).toBe(1);
    expect(events[0].messageId).toBe('msg-1');
    expect(events[1].tool).toMatchObject({
      id: 'tool-system-1',
      name: 'Read',
      input: '/tmp/a.txt',
      result: 'ok',
      status: 'completed',
    } satisfies DirectorToolCall);
  });

  test('handleStreamChunk suppresses chunk during bootstrap', async () => {
    const bridge = createBridge();
    const adapter = FakeAdapter.instances.at(-1)!;
    const chunks: string[] = [];
    bridge.on('chunk', (t: string) => chunks.push(t));
    await bridge.start();
    const bp = bridge.bootstrap();
    adapter.hooks.onChunk('nope');
    expect(chunks).toHaveLength(0);
    adapter.completeTurn({ responseText: 'boot', durationMs: 1 });
    await bp;
  });

  // ---- 4. handleMetricsUpdate ----

  test('handleMetricsUpdate updates tokens, context tokens, context window and cost', async () => {
    const bridge = createBridge();
    const adapter = FakeAdapter.instances.at(-1)!;
    await bridge.start();
    adapter.hooks.onMetrics({ lastInputTokens: 5000, contextTokens: 6000, contextWindow: 128000, costUsd: 0.05 });
    const s = bridge.getStatus();
    expect(s.lastInputTokens).toBe(5000);
    expect(s.contextTokens).toBe(6000);
    expect(s.contextWindow).toBe(128000);
    expect(s.contextMetricsLive).toBe(true);
    expect(s.totalCostUsd).toBe(0.05);
  });

  test('getStatus uses provider flush context limit override', () => {
    const bridge = createBridgeWithOptions({ directorAgentName: 'fake', providerFlushContextLimit: 210000 });
    expect(bridge.getStatus().flushContextLimit).toBe(210000);
  });

  test('getStatus uses model flush context limit override before provider override', () => {
    const bridge = createBridgeWithOptions({
      directorAgentName: 'fake',
      providerModel: 'gpt-5.5',
      providerFlushContextLimit: 210000,
      providerFlushContextLimits: { 'gpt-5.5': 200000 },
    });
    expect(bridge.getStatus().flushContextLimit).toBe(200000);
  });

  test('provider can disable automatic context flush', async () => {
    const bridge = createBridgeWithOptions({
      directorAgentName: 'fake',
      providerFlushContextLimit: 1000,
      providerDisableAutoFlush: true,
    });
    const adapter = FakeAdapter.instances.at(-1)!;
    const flushSpy = spyOn(bridge, 'flush');

    await bridge.start();
    await bridge.send('hello');
    adapter.hooks.onMetrics({ lastInputTokens: 2000, contextTokens: 2000 });
    adapter.completeTurn({ responseText: 'ok', durationMs: 1 });

    expect(bridge.getStatus().autoFlushDisabled).toBe(true);
    expect(flushSpy).not.toHaveBeenCalled();
  });

  test('restoreState keeps restored context metrics marked as stale until a live turn updates them', () => {
    setState('director:main', {
      lastFlushAt: Date.now() - 1_000,
      lastInputTokens: 138000,
      contextTokens: 138000,
      contextWindow: 950000,
    });

    const bridge = createBridgeWithOptions({ isMain: true, label: 'main' });
    bridge.restoreState();

    const status = bridge.getStatus();
    expect(status.lastInputTokens).toBe(138000);
    expect(status.contextTokens).toBe(138000);
    expect(status.contextMetricsLive).toBe(false);
  });

  test('stale restored context metrics do not trigger auto-flush', async () => {
    setState('director:main', {
      lastFlushAt: Date.now(),
      lastInputTokens: 2_000_000,
      contextTokens: 2_000_000,
      contextWindow: 258_400,
    });

    const bridge = createBridgeWithOptions({ isMain: true, label: 'main' });
    const adapter = FakeAdapter.instances.at(-1)!;
    const flushSpy = spyOn(bridge, 'flush');

    bridge.restoreState();
    await bridge.start();
    await bridge.send('hello');
    adapter.completeTurn({ responseText: 'ok', durationMs: 1 });

    expect(flushSpy).not.toHaveBeenCalled();
  });

  test('handleMetricsUpdate accumulates cost across calls', async () => {
    const bridge = createBridge();
    const adapter = FakeAdapter.instances.at(-1)!;
    await bridge.start();
    adapter.hooks.onMetrics({ costUsd: 0.03 });
    adapter.hooks.onMetrics({ costUsd: 0.07 });
    expect(bridge.getStatus().totalCostUsd).toBeCloseTo(0.10);
  });

  // ---- 5. handleRuntimeClosed ----

  test('handleRuntimeClosed during shutdown resolves shutdown promise', async () => {
    const bridge = createBridge();
    const adapter = FakeAdapter.instances.at(-1)!;
    adapter.shouldWaitOnShutdown = true;
    await bridge.start();
    const p = bridge.shutdown();
    await adapter.closeRuntime();
    await p;
  });

  test('handleRuntimeClosed on explicitRestart emits restarted', async () => {
    const bridge = createBridge();
    const adapter = FakeAdapter.instances.at(-1)!;
    adapter.activeTurn = true;
    await bridge.start();
    const rp = bridge.restartProcess();
    await adapter.closeRuntime();
    await rp;
    expect(adapter.restartCalls).toBe(1);
  });

  test('handleRuntimeClosed on interrupt emits restarted', async () => {
    const bridge = createBridge();
    const adapter = FakeAdapter.instances.at(-1)!;
    adapter.activeTurn = true;
    await bridge.start();
    const ip = bridge.interrupt();
    await adapter.closeRuntime();
    await ip;
    expect(adapter.restartCalls).toBe(1);
  });

  test('handleRuntimeClosed on non-main unexpected close emits stream-abort and close', async () => {
    const bridge = createBridgeWithOptions({ isMain: false });
    const adapter = FakeAdapter.instances.at(-1)!;
    const ev: string[] = [];
    bridge.on('stream-abort', () => ev.push('stream-abort'));
    bridge.on('close', () => ev.push('close'));
    await bridge.start();
    await adapter.closeRuntime();
    expect(ev).toEqual(['stream-abort', 'close']);
  });

  test('handleRuntimeClosed on main unexpected close alerts and bootstraps', async () => {
    const bridge = createBridgeWithOptions({ isMain: true });
    const adapter = FakeAdapter.instances.at(-1)!;
    const alerts: string[] = [];
    bridge.on('alert', (m: string) => alerts.push(m));
    await bridge.start();
    const cp = adapter.closeRuntime();
    await new Promise(r => setTimeout(r, 100));
    adapter.completeTurn({ responseText: 'rebooted', durationMs: 1 });
    await cp;
    expect(alerts.some(a => a.includes('意外退出'))).toBe(true);
    expect(adapter.restartCalls).toBe(1);
  });

  // ---- 6. getStatus activity states ----

  test('getStatus transitions through idle → processing → idle', async () => {
    const bridge = createBridge();
    const adapter = FakeAdapter.instances.at(-1)!;
    await bridge.start();
    expect(bridge.getStatus().activityState).toBe('idle');
    await bridge.send('msg');
    expect(bridge.getStatus().activityState).toBe('processing');
    adapter.completeTurn({ responseText: 'r', durationMs: 1 });
    expect(bridge.getStatus().activityState).toBe('idle');
  });

  test('getStatus shows flushing during flush', async () => {
    const bridge = createBridgeWithOptions({ isMain: true });
    const adapter = FakeAdapter.instances.at(-1)!;
    await bridge.start();
    const fp = bridge.flush();
    expect(bridge.getStatus().activityState).toBe('flushing');
    adapter.completeTurn({ responseText: 'cp', durationMs: 1 });
    await new Promise(r => setTimeout(r, 50));
    adapter.completeTurn({ responseText: 'bp', durationMs: 1 });
    await fp;
    expect(bridge.getStatus().activityState).toBe('idle');
  });

  // ---- 7. restartProcess ----

  test('restartProcess is no-op when no active turn', async () => {
    const bridge = createBridge();
    const adapter = FakeAdapter.instances.at(-1)!;
    adapter.activeTurn = false;
    await bridge.start();
    await bridge.restartProcess();
    expect(adapter.terminations).toHaveLength(0);
  });

  test('restartProcess terminates and waits for restarted event', async () => {
    const bridge = createBridge();
    const adapter = FakeAdapter.instances.at(-1)!;
    adapter.activeTurn = true;
    await bridge.start();
    const rp = bridge.restartProcess();
    expect(adapter.terminations).toContain('SIGTERM');
    await adapter.closeRuntime();
    await rp;
    expect(adapter.restartCalls).toBe(1);
  });

  // ---- 8. buildSessionName ----

  test('buildSessionName generates name with label, date, and groupName', () => {
    createBridgeWithOptions({ label: 'my-dir', groupName: 'grp' });
    const adapter = FakeAdapter.instances.at(-1)!;
    const name = adapter.hooks.buildSessionName();
    expect(name).toMatch(/^codex-director-my-dir-\d{8}T\d{4}-grp$/);
  });

  test('buildSessionName omits groupName when not set', () => {
    createBridgeWithOptions({ label: 'solo', groupName: undefined });
    const adapter = FakeAdapter.instances.at(-1)!;
    const name = adapter.hooks.buildSessionName();
    expect(name).toMatch(/^codex-director-solo-\d{8}T\d{4}$/);
  });

  test('non-main codex director uses session workspace cwd', () => {
    createBridgeWithOptions({
      label: 'group-1',
      groupName: 'My Group',
      providerCwd: '/tmp/global-provider-cwd',
    });
    const adapter = FakeAdapter.instances.at(-1)!;
    expect(adapter.options.directorAgent.cwd).toBe('/tmp/persona-test/workspaces/My Group');
  });

  test('main codex director keeps provider cwd', () => {
    createBridgeWithOptions({
      isMain: true,
      label: 'main',
      groupName: undefined,
      directorAgentName: 'fake',
      providerCwd: '/tmp/global-provider-cwd',
    });
    const adapter = FakeAdapter.instances.at(-1)!;
    expect(adapter.options.directorAgent.cwd).toBe('/tmp/global-provider-cwd');
  });

  // ---- 9. logOutputEvent ----

  test('logOutputEvent writes JSON with _ts and _director', () => {
    const bridge = createBridge();
    const adapter = FakeAdapter.instances.at(-1)!;
    adapter.hooks.logOutput(JSON.stringify({ type: 'result', content: 'hi' }));
    const lines = readFileSync(bridge.outputLogPath, 'utf-8').trim().split('\n');
    const last = JSON.parse(lines.at(-1)!);
    expect(last._ts).toBeDefined();
    expect(last._director).toBe('test-bridge');
  });

  test('logOutputEvent skips stream_event entries', () => {
    const bridge = createBridge();
    const adapter = FakeAdapter.instances.at(-1)!;
    adapter.hooks.logOutput(JSON.stringify({ type: 'result', x: 1 }));
    const before = readFileSync(bridge.outputLogPath, 'utf-8').trim().split('\n').length;
    adapter.hooks.logOutput(JSON.stringify({ type: 'stream_event', x: 2 }));
    const after = readFileSync(bridge.outputLogPath, 'utf-8').trim().split('\n').length;
    expect(after).toBe(before);
  });

  // ---- 10. sendSystemMessage error handling ----

  test('sendSystemMessage clears pending turn when adapter throws', async () => {
    const bridge = createBridge();
    const adapter = FakeAdapter.instances.at(-1)!;
    await bridge.start();
    const orig = adapter.send.bind(adapter);
    adapter.send = async () => { throw new Error('boom'); };
    await bridge.sendSystemMessage('fail');
    expect(bridge.getStatus().pendingCount).toBe(0);
    adapter.send = orig;
  });

  test('send emits turn_failed when visible user turn cannot be written', async () => {
    const bridge = createBridge();
    const adapter = FakeAdapter.instances.at(-1)!;
    const events: AssistantTurnEvent[] = [];
    bridge.on('turn-event', (event: AssistantTurnEvent) => events.push(event));

    await bridge.start();
    const orig = adapter.send.bind(adapter);
    adapter.send = async () => { throw new Error('boom'); };

    await expect(bridge.send('fail', { correlationId: 'msg-fail' })).rejects.toThrow('boom');

    expect(bridge.getStatus().pendingCount).toBe(0);
    expect(events.map(event => event.type)).toEqual(['turn_started', 'turn_failed']);
    expect(new Set(events.map(event => event.turnId)).size).toBe(1);
    expect(events[0].messageId).toBe('msg-fail');
    expect(events[1].error).toBe('boom');
    adapter.send = orig;
  });

  test('notifyTaskDone emits turn_failed when visible system reply cannot be written', async () => {
    const bridge = createBridge();
    const adapter = FakeAdapter.instances.at(-1)!;
    const events: AssistantTurnEvent[] = [];
    bridge.on('turn-event', (event: AssistantTurnEvent) => events.push(event));

    await bridge.start();
    const orig = adapter.send.bind(adapter);
    adapter.send = async () => { throw new Error('boom'); };

    await bridge.notifyTaskDone('task-fail', true, 'msg-task-fail');

    expect(bridge.getStatus().pendingCount).toBe(0);
    expect(events.map(event => event.type)).toEqual(['turn_started', 'turn_failed']);
    expect(new Set(events.map(event => event.turnId)).size).toBe(1);
    expect(events[0].messageId).toBe('msg-task-fail');
    expect(events[1].error).toBe('boom');
    adapter.send = orig;
  });

  // ---- 11. Codex partial system-reply streaming ----

  test('codex system-reply partial agent message streams system chunk before final response', async () => {
    const bridge = createBridge();
    const adapter = FakeAdapter.instances.at(-1)!;
    const chunks: Array<{ text: string; replyToMessageId: string }> = [];
    const responses: Array<{ text: string; replyToMessageId: string }> = [];
    bridge.on('system-chunk', (text: string, replyToMessageId: string) => chunks.push({ text, replyToMessageId }));
    bridge.on('system-response', (text: string, replyToMessageId: string) => responses.push({ text, replyToMessageId }));

    await bridge.start();
    await bridge.notifyTaskDone('task-1', true, 'msg-100');

    adapter.hooks.onPartialAgentMessage('任务已完成，报告如下…');
    expect(chunks).toEqual([{ text: '任务已完成，报告如下…', replyToMessageId: 'msg-100' }]);
    expect(responses).toHaveLength(0);

    adapter.completeTurn({ responseText: '任务已完成，报告如下…', durationMs: 10 });
    expect(responses).toEqual([{ text: '任务已完成，报告如下…', replyToMessageId: 'msg-100' }]);
  });

  test('partial system-reply streaming only fires once per turn', async () => {
    const bridge = createBridge();
    const adapter = FakeAdapter.instances.at(-1)!;
    const chunks: string[] = [];
    bridge.on('system-chunk', (text: string) => chunks.push(text));

    await bridge.start();
    await bridge.notifyTaskDone('task-2', true, 'msg-200');

    adapter.hooks.onPartialAgentMessage('first segment');
    adapter.hooks.onPartialAgentMessage('second segment');

    expect(chunks).toEqual(['first segment']);

    adapter.completeTurn({ responseText: 'first segment\nsecond segment', durationMs: 10 });
  });

  test('turn completion after partial stream emits full response once', async () => {
    const bridge = createBridge();
    const adapter = FakeAdapter.instances.at(-1)!;
    const emitted: Array<{ event: string; args: unknown[] }> = [];
    bridge.on('system-response', (...args: unknown[]) => emitted.push({ event: 'system-response', args }));

    await bridge.start();
    await bridge.notifyTaskDone('task-3', true, 'msg-300');

    adapter.hooks.onPartialAgentMessage('结论：已完成');
    adapter.completeTurn({ responseText: '结论：已完成\n后续已派发 task-4', durationMs: 10 });

    expect(emitted).toHaveLength(1);
    expect(emitted[0].args[0]).toBe('结论：已完成\n后续已派发 task-4');
    expect(emitted[0].args[1]).toBe('msg-300');
  });

  test('turn completion after partial stream emits final response', async () => {
    const bridge = createBridge();
    const adapter = FakeAdapter.instances.at(-1)!;
    const emitted: Array<{ event: string; args: unknown[] }> = [];
    bridge.on('system-response', (...args: unknown[]) => emitted.push({ event: 'system-response', args }));

    await bridge.start();
    await bridge.notifyTaskDone('task-4', true, 'msg-400');

    adapter.hooks.onPartialAgentMessage('done');
    adapter.completeTurn({ responseText: 'done', durationMs: 10 });

    expect(emitted).toHaveLength(1);
    expect(emitted[0].args[0]).toBe('done');
  });

  test('user turn does not trigger partial system-reply forwarding', async () => {
    const bridge = createBridge();
    const adapter = FakeAdapter.instances.at(-1)!;
    const emitted: Array<{ event: string; args: unknown[] }> = [];
    bridge.on('system-response', (...args: unknown[]) => emitted.push({ event: 'system-response', args }));

    await bridge.start();
    await bridge.send('hello');

    adapter.hooks.onPartialAgentMessage('user response chunk');
    expect(emitted).toHaveLength(0);

    adapter.completeTurn({ responseText: 'user response chunk', durationMs: 5 });
  });

  test('non-codex adapter does not trigger partial system-reply forwarding', async () => {
    const bridge = createBridgeWithOptions({ providerName: 'fake-claude', directorAgentName: 'fake-claude' });
    const adapter = FakeAdapter.instances.at(-1)!;
    const emitted: Array<{ event: string; args: unknown[] }> = [];
    bridge.on('system-response', (...args: unknown[]) => emitted.push({ event: 'system-response', args }));

    await bridge.start();
    await bridge.notifyTaskDone('task-5', true, 'msg-500');

    adapter.hooks.onPartialAgentMessage('should not forward');
    expect(emitted).toHaveLength(0);

    adapter.completeTurn({ responseText: 'should not forward', durationMs: 10 });
    expect(emitted).toHaveLength(1);
    expect(emitted[0].args[0]).toBe('should not forward');
  });

  test('notifyTaskDone prompt includes stop-loss protocol', async () => {
    const bridge = createBridge();
    const adapter = FakeAdapter.instances.at(-1)!;

    await bridge.start();
    await bridge.notifyTaskDone('task-6', true, 'msg-600');

    const sent = adapter.sent.at(-1)!;
    expect(sent).toContain('简短结论');
    expect(sent).toContain('不要在本轮等待后续任务完成');

    adapter.completeTurn({ responseText: 'ack', durationMs: 1 });
  });
});

function createBridge(): SessionBridge {
  return new SessionBridge({
    agents: {
      defaults: { director: 'fake', default: 'fake' },
      providers: {
        fake: { type: 'codex', command: 'fake-codex' },
        'fake-codex': { type: 'codex', command: 'fake-codex' },
        'fake-claude': { type: 'claude', command: 'fake-claude' },
      },
    },
    config: {
      persona_dir: '/tmp/persona-test',
      pipe_dir: '/tmp/persona-test',
      pid_file: '/tmp/persona-test/director.pid',
      time_sync_interval_ms: 999999,
      flush_context_limit: 999999,
      flush_interval_ms: 999999,
      quote_max_length: 32,
    },
    label: 'test-bridge',
    isMain: false,
    groupName: 'Test Group',
    directorFactory: (options, hooks) => new FakeAdapter(options, hooks),
  } satisfies ConstructorParameters<typeof SessionBridge>[0] & {
    directorFactory: (options: DirectorSessionAdapterOptions, hooks: DirectorSessionAdapterHooks) => DirectorSessionAdapter;
  });
}

function createBridgeWithOptions(overrides: {
  isMain?: boolean;
  groupName?: string;
  label?: string;
  timeSyncIntervalMs?: number;
  providerName?: string;
  directorAgentName?: string;
  providerModel?: string;
  providerFlushContextLimit?: number;
  providerFlushContextLimits?: Record<string, number>;
  providerDisableAutoFlush?: boolean;
  providerCwd?: string;
} = {}): SessionBridge {
  const hasGroupName = 'groupName' in overrides;
  const fakeProvider: AgentProviderConfig = {
    type: 'codex',
    command: 'fake-codex',
    ...(overrides.providerModel ? { model: overrides.providerModel } : {}),
    ...(overrides.providerFlushContextLimit ? { flush_context_limit: overrides.providerFlushContextLimit } : {}),
    ...(overrides.providerFlushContextLimits ? { flush_context_limits: overrides.providerFlushContextLimits } : {}),
    ...(typeof overrides.providerDisableAutoFlush === 'boolean' ? { disable_auto_flush: overrides.providerDisableAutoFlush } : {}),
    ...(overrides.providerCwd ? { cwd: overrides.providerCwd } : {}),
  };
  return new SessionBridge({
    agents: {
      defaults: { director: overrides.providerName ?? 'fake', default: overrides.providerName ?? 'fake' },
      providers: {
        fake: fakeProvider,
        'fake-codex': { type: 'codex', command: 'fake-codex' },
        'fake-claude': { type: 'claude', command: 'fake-claude' },
      },
    },
    config: {
      persona_dir: '/tmp/persona-test',
      pipe_dir: '/tmp/persona-test',
      pid_file: '/tmp/persona-test/director.pid',
      time_sync_interval_ms: overrides.timeSyncIntervalMs ?? 999999,
      flush_context_limit: 999999,
      flush_interval_ms: 999999,
      quote_max_length: 32,
    },
    directorAgentName: overrides.directorAgentName,
    label: overrides.label ?? 'test-bridge',
    isMain: overrides.isMain ?? false,
    groupName: hasGroupName ? overrides.groupName : 'Test Group',
    directorFactory: (options, hooks) => new FakeAdapter(options, hooks),
  });
}
