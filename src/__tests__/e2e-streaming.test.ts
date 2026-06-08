/**
 * End-to-end streaming message routing tests.
 *
 * Verifies the full chain: message → SessionManager → SessionBridge → Agent (mock)
 * → streaming chunks → turn completion → response routing.
 *
 * Uses FakeAdapter injected via SessionBridge's directorFactory to mock
 * Claude/Codex agent behavior including:
 * - Stream chunks (onChunk)
 * - Tool calls (onToolCall)
 * - Turn completion with response text
 * - Turn failure
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { rmSync, mkdirSync } from 'fs';
import { SessionManager } from '../session-manager.js';
import { WorkspaceRegistry } from '../workspace-registry.js';
import { SessionBridge } from '../session-bridge.js';
import { MessageQueue } from '../queue.js';
import {
  initTaskStore,
  createSessionRecord,
} from '../task/task-store.js';
import { initLogDir } from '../logger.js';
import type {
  DirectorSessionAdapter,
  DirectorSessionAdapterHooks,
  DirectorSessionAdapterOptions,
  DirectorTurnResult,
  DirectorToolCall,
  AssistantTurnEvent,
} from '../director-session-adapter/index.js';
import type { DirectorRuntimeStatus, DirectorSendResult } from '../director-runtime/index.js';

const TEST_DIR = '/tmp/persona-e2e-streaming-test';

// --- Mock Agent (FakeAdapter) ---

class FakeAdapter implements DirectorSessionAdapter {
  static instances: FakeAdapter[] = [];
  readonly sent: string[] = [];
  ready = true;
  activeTurn = false;
  sessionIdValue: string;
  status: DirectorRuntimeStatus = { kind: 'codex-app-server', alive: true, pid: null };

  constructor(
    readonly options: DirectorSessionAdapterOptions,
    readonly hooks: DirectorSessionAdapterHooks,
    sessionId?: string,
  ) {
    this.sessionIdValue = sessionId ?? `fake-session-${FakeAdapter.instances.length + 1}`;
    FakeAdapter.instances.push(this);
  }

  async start(): Promise<boolean> {
    const restored = this.hooks.restorePersistedSession();
    if (!restored.sessionId) {
      this.hooks.persistSession(this.sessionIdValue, `name-${this.sessionIdValue}`);
    }
    return true;
  }

  isReady() { return this.ready; }
  getStatus() { return this.status; }
  hasActiveTurn() { return this.activeTurn; }

  async send(content: string): Promise<DirectorSendResult | void> {
    this.sent.push(content);
    this.activeTurn = true;
  }

  interrupt() { this.activeTurn = false; }
  async stop() {}
  terminate() { this.activeTurn = false; }
  async prepareShutdown() { return false; }
  async restartTransport() {}
  describeSessionReady(label: string, sessionId: string | null) {
    return `[fake:${label}] ready ${sessionId ?? 'new'}`;
  }
  describeInterruptTarget() { return null; }
  shouldSkipInterruptWhileFlushing() { return false; }
  shouldTrackRestartBackoff() { return false; }

  // --- Simulation helpers ---
  simulateStreamChunks(chunks: string[]): void {
    for (const chunk of chunks) { this.hooks.onChunk(chunk); }
  }

  simulateToolCall(name: string, tool?: DirectorToolCall): void {
    this.hooks.onToolCall(name, tool);
  }

  completeTurn(result: DirectorTurnResult): void {
    this.activeTurn = false;
    this.hooks.onTurnComplete(result);
  }

  failTurn(message: string): void {
    this.activeTurn = false;
    this.hooks.onTurnFailure(message);
  }
}

// --- Test helpers ---

const bridgeConfig = {
  persona_dir: TEST_DIR,
  pipe_dir: TEST_DIR,
  pid_file: `${TEST_DIR}/director.pid`,
  time_sync_interval_ms: 999999,
  flush_context_limit: 999999,
  flush_interval_ms: 999999,
  quote_max_length: 32,
};

const agentsConfig = {
  defaults: { director: 'fake', default: 'fake' },
  providers: {
    fake: { type: 'codex-app-server' as const, command: 'fake-codex' },
    'fake-codex': { type: 'codex-app-server' as const, command: 'fake-codex' },
  },
};

function createBridgeWithAdapter(label: string, groupName: string, sessionId?: string): { bridge: SessionBridge; getAdapter: () => FakeAdapter } {
  let adapterRef: FakeAdapter | null = null;
  const bridge = new SessionBridge({
    agents: agentsConfig,
    config: bridgeConfig,
    label,
    isMain: label === 'main',
    groupName: label === 'main' ? undefined : groupName,
    directorFactory: (options, hooks) => {
      adapterRef = new FakeAdapter(options, hooks, sessionId);
      return adapterRef;
    },
  });
  return { bridge, getAdapter: () => adapterRef! };
}

// --- Tests ---

describe('E2E streaming message routing', () => {
  beforeEach(() => {
    FakeAdapter.instances = [];
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    initTaskStore(TEST_DIR);
    initLogDir(TEST_DIR);
  });

  test('full message lifecycle: send → stream chunks → tool call → response', async () => {
    const { bridge, getAdapter } = createBridgeWithAdapter('grp1', 'test-project', 'sess-full-1');
    await bridge.start();
    const adapter = getAdapter();

    const chunks: string[] = [];
    const responses: string[] = [];
    bridge.on('chunk', (t: string) => chunks.push(t));
    bridge.on('response', (t: string) => responses.push(t));

    // Send user message
    await bridge.send('analyze this code');

    expect(adapter.sent.at(-1)).toContain('analyze this code');

    // Simulate agent streaming
    adapter.simulateStreamChunks(['Let me ', 'look at ', 'the code...']);
    expect(chunks).toEqual(['Let me ', 'look at ', 'the code...']);

    // Simulate tool call start
    adapter.simulateToolCall('Bash', {
      id: 'tool-1', name: 'Bash',
      input: '{"command": "cat src/main.ts"}',
      status: 'running',
    });

    // Simulate tool call complete
    adapter.simulateToolCall('Bash', {
      id: 'tool-1', name: 'Bash',
      input: '{"command": "cat src/main.ts"}',
      result: 'console.log("hello")',
      isError: false, status: 'completed',
    });

    // Complete turn
    adapter.completeTurn({
      responseText: 'Let me look at the code...\nThe main file contains a simple hello world.',
      durationMs: 1500,
    });

    expect(responses).toHaveLength(1);
    expect(responses[0]).toContain('hello world');
  });

  test('turn failure produces error response', async () => {
    const { bridge, getAdapter } = createBridgeWithAdapter('grp2', 'fail-ws', 'sess-fail-1');
    await bridge.start();
    const adapter = getAdapter();

    const responses: string[] = [];
    bridge.on('response', (t: string) => responses.push(t));

    await bridge.send('do something');
    adapter.failTurn('rate limit exceeded');

    expect(responses).toHaveLength(1);
    expect(responses[0]).toContain('处理失败');
  });

  test('turn events carry sessionId for frontend matching', async () => {
    const sessionId = 'sess-events-1';
    const { bridge, getAdapter } = createBridgeWithAdapter('grp3', 'event-ws', sessionId);
    await bridge.start();
    const adapter = getAdapter();

    const turnEvents: AssistantTurnEvent[] = [];
    bridge.on('turn-event', (event: AssistantTurnEvent) => turnEvents.push(event));

    await bridge.send('check events', { correlationId: 'msg-ev' });

    adapter.simulateStreamChunks(['event text']);
    adapter.completeTurn({ responseText: 'event text done', durationMs: 50 });

    expect(turnEvents.length).toBeGreaterThan(0);
    for (const event of turnEvents) {
      expect(event.sessionId).toBe(sessionId);
    }
    expect(turnEvents.map(e => e.type)).toContain('turn_started');
    expect(turnEvents.map(e => e.type)).toContain('assistant_delta');
    expect(turnEvents.map(e => e.type)).toContain('turn_completed');
  });

  test('workspace default session is set on first registration', async () => {
    const registry = new WorkspaceRegistry();
    registry.getOrCreate('auto-default-ws');

    expect(registry.resolveDefaultSession('auto-default-ws')).toBeNull();

    const { bridge } = createBridgeWithAdapter('grp4', 'auto-default-ws', 'sess-auto-1');
    await bridge.start();

    const stubPool = { on() {}, emit() {} } as any;
    const manager = new SessionManager(stubPool, registry);
    manager.registerSession('sess-auto-1', 'oc_autodef', 'auto-default-ws', {
      bridge, queue: new MessageQueue('/dev/null'),
      routingKey: 'oc_autodef', feishuChatId: 'oc_autodef',
      groupName: 'auto-default-ws', lastActiveAt: Date.now(), messagesSinceFlush: 0,
    });

    expect(registry.resolveDefaultSession('auto-default-ws')).toBe('sess-auto-1');
  });

  test('multiple sessions in same workspace', async () => {
    const registry = new WorkspaceRegistry();
    registry.getOrCreate('multi-ws');

    const stubPool = { on() {}, emit() {} } as any;
    const manager = new SessionManager(stubPool, registry);

    const { bridge: bridge1 } = createBridgeWithAdapter('grp5a', 'multi-ws', 'sess-multi-1');
    await bridge1.start();
    manager.registerSession('sess-multi-1', 'key1', 'multi-ws', {
      bridge: bridge1, queue: new MessageQueue('/dev/null'),
      routingKey: 'key1', feishuChatId: 'oc_test', groupName: 'multi-ws',
      lastActiveAt: Date.now(), messagesSinceFlush: 0,
    });

    createSessionRecord({ sessionId: 'sess-multi-2', workspace: 'multi-ws', role: 'philosopher' });

    const sessions = manager.listSessions('multi-ws');
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    expect(registry.resolveDefaultSession('multi-ws')).toBe('sess-multi-1');
  });

  test('archived session is excluded from active list', async () => {
    const registry = new WorkspaceRegistry();
    const stubPool = { on() {}, emit() {} } as any;
    const manager = new SessionManager(stubPool, registry);

    createSessionRecord({ sessionId: 'active-1', workspace: 'archive-ws' });
    createSessionRecord({ sessionId: 'to-archive', workspace: 'archive-ws' });

    await manager.archiveSession('to-archive');

    const active = manager.listSessions('archive-ws');
    expect(active).toHaveLength(1);
    expect(active[0].session_id).toBe('active-1');

    const all = manager.listSessions('archive-ws', { includeArchived: true });
    expect(all).toHaveLength(2);
  });

  test('streaming chunks are suppressed during bootstrap', async () => {
    const { bridge, getAdapter } = createBridgeWithAdapter('grp6', 'boot-ws', 'sess-boot-1');
    await bridge.start();
    const adapter = getAdapter();

    const chunks: string[] = [];
    bridge.on('chunk', (t: string) => chunks.push(t));

    const bootstrapPromise = bridge.bootstrap();
    adapter.simulateStreamChunks(['bootstrap noise']);
    adapter.completeTurn({ responseText: 'boot ok', durationMs: 5 });
    await bootstrapPromise;

    expect(chunks).toHaveLength(0);

    // After bootstrap, chunks should flow
    await bridge.send('real message');
    adapter.simulateStreamChunks(['real chunk']);
    expect(chunks).toEqual(['real chunk']);

    adapter.completeTurn({ responseText: 'done', durationMs: 1 });
  });
});
