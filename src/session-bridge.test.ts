import { beforeEach, describe, expect, test, spyOn } from 'bun:test';
import { SessionBridge } from './session-bridge.js';
import type {
  DirectorSessionAdapter,
  DirectorSessionAdapterHooks,
  DirectorSessionAdapterOptions,
  DirectorTurnResult,
} from './director-session-adapter/index.js';
import type { DirectorRuntimeStatus } from './director-runtime/index.js';

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

  async restartTransport(): Promise<void> {}

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
