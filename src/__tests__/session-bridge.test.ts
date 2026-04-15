import { beforeEach, describe, expect, test, spyOn } from 'bun:test';
import { readFileSync } from 'fs';
import { SessionBridge } from '../session-bridge.js';
import { initTaskStore } from '../task/task-store.js';
import type {
  DirectorSessionAdapter,
  DirectorSessionAdapterHooks,
  DirectorSessionAdapterOptions,
  DirectorTurnResult,
} from '../director-session-adapter/index.js';
import type { DirectorRuntimeStatus } from '../director-runtime/index.js';

class FakeAdapter implements DirectorSessionAdapter {
  static instances: FakeAdapter[] = [];

  readonly sent: string[] = [];
  readonly terminations: NodeJS.Signals[] = [];
  ready = true;
  activeTurn = false;
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

  async send(content: string): Promise<void> {
    this.sent.push(content);
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

    const success = await bridge.clearContext();

    expect(success).toBe(true);
    expect(adapter.terminations).toEqual(['SIGTERM']);
    expect(adapter.restartCalls).toBe(1);
    expect(adapter.sent).toHaveLength(0);
    expect(bridge.isFlushing).toBe(false);
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

  test('flush on non-main bridge terminates and restarts without checkpoint', async () => {
    const bridge = createBridgeWithOptions({ isMain: false });
    const adapter = FakeAdapter.instances.at(-1)!;
    await bridge.start();
    const result = await bridge.flush();
    expect(result).toBe(true);
    expect(adapter.terminations).toContain('SIGTERM');
    expect(adapter.restartCalls).toBe(1);
    expect(adapter.sent).toHaveLength(0);
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

  test('handleMetricsUpdate updates tokens, context window and cost', async () => {
    const bridge = createBridge();
    const adapter = FakeAdapter.instances.at(-1)!;
    await bridge.start();
    adapter.hooks.onMetrics({ lastInputTokens: 5000, contextWindow: 128000, costUsd: 0.05 });
    const s = bridge.getStatus();
    expect(s.lastInputTokens).toBe(5000);
    expect(s.contextWindow).toBe(128000);
    expect(s.totalCostUsd).toBe(0.05);
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
});

function createBridge(): SessionBridge {
  return new SessionBridge({
    agents: {
      defaults: { director: 'fake', default: 'fake' },
      providers: {
        fake: { type: 'codex', command: 'fake-codex' },
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
} = {}): SessionBridge {
  const hasGroupName = 'groupName' in overrides;
  return new SessionBridge({
    agents: {
      defaults: { director: 'fake', default: 'fake' },
      providers: {
        fake: { type: 'codex', command: 'fake-codex' },
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
    label: overrides.label ?? 'test-bridge',
    isMain: overrides.isMain ?? false,
    groupName: hasGroupName ? overrides.groupName : 'Test Group',
    directorFactory: (options, hooks) => new FakeAdapter(options, hooks),
  });
}
