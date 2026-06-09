import { beforeEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'events';
import { rmSync, mkdirSync } from 'fs';
import { SessionManager } from '../session-manager.js';
import { WorkspaceRegistry } from '../workspace-registry.js';
import { AgentRuntimePool, type RuntimeEntry } from '../agent-runtime-pool.js';
import { SessionBridge } from '../session-bridge.js';
import { MessageQueue } from '../queue.js';
import {
  initTaskStore,
  getWorkspace,
  getSessionRecord,
  listSessionRecords,
  createWorkspace,
  setDefaultSession,
  createSessionRecord,
  archiveSession as archiveSessionInDb,
} from '../task/task-store.js';
import { initLogDir } from '../logger.js';
import type {
  DirectorSessionAdapter,
  DirectorSessionAdapterHooks,
  DirectorSessionAdapterOptions,
  DirectorTurnResult,
} from '../director-session-adapter/index.js';
import type { DirectorRuntimeStatus, DirectorSendResult } from '../director-runtime/index.js';

const TEST_DIR = '/tmp/persona-session-manager-test';

class FakeAdapter implements DirectorSessionAdapter {
  static instances: FakeAdapter[] = [];
  readonly sent: string[] = [];
  readonly terminations: NodeJS.Signals[] = [];
  ready = true;
  activeTurn = false;
  sessionId = 'fake-session-001';
  status: DirectorRuntimeStatus = { kind: 'codex-app-server', alive: true, pid: null };

  constructor(
    readonly options: DirectorSessionAdapterOptions,
    readonly hooks: DirectorSessionAdapterHooks,
  ) {
    FakeAdapter.instances.push(this);
  }

  async start(): Promise<boolean> {
    const restored = this.hooks.restorePersistedSession();
    if (!restored.sessionId) {
      this.hooks.persistSession(this.sessionId, `fake-${this.sessionId}`);
    }
    return true;
  }
  isReady() { return this.ready; }
  getStatus() { return this.status; }
  hasActiveTurn() { return this.activeTurn; }
  async send(content: string): Promise<DirectorSendResult | void> { this.sent.push(content); }
  interrupt() {}
  async stop() {}
  terminate(signal: NodeJS.Signals) { this.terminations.push(signal); }
  async prepareShutdown() { return false; }
  async restartTransport() {}
  describeSessionReady(label: string, sessionId: string | null) {
    return `[bridge:${label}] ready ${sessionId ?? 'new'}`;
  }
  describeInterruptTarget() { return null; }
  shouldSkipInterruptWhileFlushing() { return false; }
  shouldTrackRestartBackoff() { return false; }
  completeTurn(result: DirectorTurnResult) { this.hooks.onTurnComplete(result); }
}

function createTestBridge(label: string, groupName: string): SessionBridge {
  return new SessionBridge({
    agents: {
      defaults: { director: 'fake', default: 'fake' },
      providers: {
        fake: { type: 'codex-app-server', command: 'fake-codex' },
        'fake-codex': { type: 'codex-app-server', command: 'fake-codex' },
      },
    },
    config: {
      persona_dir: TEST_DIR,
      pipe_dir: TEST_DIR,
      pid_file: `${TEST_DIR}/director.pid`,
      time_sync_interval_ms: 999999,
      flush_context_limit: 999999,
      flush_interval_ms: 999999,
      quote_max_length: 32,
    },
    label,
    isMain: false,
    groupName,
    directorFactory: (options, hooks) => new FakeAdapter(options, hooks),
  });
}

function createTestPool(): AgentRuntimePool {
  return new AgentRuntimePool(
    createTestBridge('main', 'main'),
    { max_directors: 10, idle_timeout_minutes: 0, small_group_threshold: 5 },
    {
      defaults: { director: 'fake', default: 'fake' },
      providers: {
        fake: { type: 'codex-app-server', command: 'fake-codex' },
        'fake-codex': { type: 'codex-app-server', command: 'fake-codex' },
      },
    },
    {
      persona_dir: TEST_DIR,
      pipe_dir: TEST_DIR,
      pid_file: `${TEST_DIR}/director.pid`,
      time_sync_interval_ms: 999999,
      flush_context_limit: 999999,
      flush_interval_ms: 999999,
      quote_max_length: 32,
    },
    {
      start() {},
      onMessage() {},
      async reply() {},
      async sendMessage() { return null; },
      async addReaction() {},
      async uploadAndReplyImage() {},
      async uploadAndReplyFile() {},
      async uploadAndSendImage() { return null; },
      async uploadAndSendFile() { return null; },
      getLastChatId() { return null; },
      getConnectionStatus() { return 'connected' as const; },
    },
  );
}

function createRestoredEntry(sessionId: string, workspace: string, routingKey: string): RuntimeEntry {
  const bridge = {
    getStatus: () => ({
      sessionId,
      sessionName: sessionId,
      personaRole: 'director',
    }),
    getPersonaRole: () => 'director',
    getWorkspaceCwd: () => TEST_DIR,
    getDirectorAgentName: () => 'fake-codex',
    getDirectorAgentType: () => 'codex-app-server',
    getDirectorAgentModel: () => null,
  } as unknown as SessionBridge;

  return {
    bridge,
    queue: new MessageQueue('/dev/null'),
    routingKey,
    feishuChatId: routingKey,
    groupName: workspace,
    lastActiveAt: Date.now(),
    messagesSinceFlush: 0,
  };
}

class RestoreOnlyPool extends EventEmitter {
  readonly sent: Array<{ routingKey: string; text: string; messageId: string }> = [];

  constructor(private readonly restoredEntries: RuntimeEntry[]) {
    super();
  }

  async restoreEntries(): Promise<void> {}
  listActiveEntries(): RuntimeEntry[] { return this.restoredEntries; }
  get(routingKey: string): RuntimeEntry | undefined {
    return this.restoredEntries.find((entry) => entry.routingKey === routingKey);
  }
  async send(routingKey: string, text: string, messageId: string): Promise<void> {
    this.sent.push({ routingKey, text, messageId });
  }
}

describe('SessionManager', () => {
  beforeEach(() => {
    FakeAdapter.instances = [];
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    initTaskStore(TEST_DIR);
    initLogDir(TEST_DIR);
  });

  test('registerSession creates session record in DB', () => {
    const pool = createTestPool();
    const registry = new WorkspaceRegistry();
    const manager = new SessionManager(pool, registry);

    registry.getOrCreate('test-ws');
    createSessionRecord({ sessionId: 'sess-1', workspace: 'test-ws', role: 'director' });
    manager.registerSession('sess-1', 'oc_test', 'test-ws', { bridge: createTestBridge('lbl', 'test-ws'), queue: new MessageQueue('/dev/null'), routingKey: 'oc_test', feishuChatId: 'oc_test', groupName: 'test-ws', lastActiveAt: Date.now(), messagesSinceFlush: 0 });

    expect(getSessionRecord('sess-1')).not.toBeNull();
  });

  test('registerSession sets default session when workspace has none', () => {
    const pool = createTestPool();
    const registry = new WorkspaceRegistry();
    const manager = new SessionManager(pool, registry);

    registry.getOrCreate('test-ws');
    createSessionRecord({ sessionId: 'sess-1', workspace: 'test-ws' });
    manager.registerSession('sess-1', 'oc_test', 'test-ws', { bridge: createTestBridge('lbl', 'test-ws'), queue: new MessageQueue('/dev/null'), routingKey: 'oc_test', feishuChatId: 'oc_test', groupName: 'test-ws', lastActiveAt: Date.now(), messagesSinceFlush: 0 });

    expect(getWorkspace('test-ws')!.default_session_id).toBe('sess-1');
  });

  test('registerSession does not overwrite existing default', () => {
    const pool = createTestPool();
    const registry = new WorkspaceRegistry();
    const manager = new SessionManager(pool, registry);

    registry.getOrCreate('test-ws');
    setDefaultSession('test-ws', 'existing-session');
    createSessionRecord({ sessionId: 'sess-2', workspace: 'test-ws' });
    manager.registerSession('sess-2', 'oc_test', 'test-ws', { bridge: createTestBridge('lbl', 'test-ws'), queue: new MessageQueue('/dev/null'), routingKey: 'oc_test', feishuChatId: 'oc_test', groupName: 'test-ws', lastActiveAt: Date.now(), messagesSinceFlush: 0 });

    expect(getWorkspace('test-ws')!.default_session_id).toBe('existing-session');
  });

  test('archiveSession marks session as archived', async () => {
    const pool = createTestPool();
    const registry = new WorkspaceRegistry();
    const manager = new SessionManager(pool, registry);

    createSessionRecord({ sessionId: 'sess-archive', workspace: 'test-ws' });
    const result = await manager.archiveSession('sess-archive');
    expect(result).toBe(true);
    expect(getSessionRecord('sess-archive')!.archived).toBe(1);
  });

  test('listSessions filters archived by default', () => {
    const pool = createTestPool();
    const registry = new WorkspaceRegistry();
    const manager = new SessionManager(pool, registry);

    createSessionRecord({ sessionId: 's1', workspace: 'ws1' });
    createSessionRecord({ sessionId: 's2', workspace: 'ws1' });
    archiveSessionInDb('s2');

    const active = manager.listSessions('ws1');
    expect(active).toHaveLength(1);
    expect(active[0].session_id).toBe('s1');

    const all = manager.listSessions('ws1', { includeArchived: true });
    expect(all).toHaveLength(2);
  });

  test('resolveDefaultSession returns workspace default', () => {
    const pool = createTestPool();
    const registry = new WorkspaceRegistry();
    const manager = new SessionManager(pool, registry);

    registry.getOrCreate('ws1');
    setDefaultSession('ws1', 'sess-default');
    expect(manager.resolveDefaultSession('ws1')).toBe('sess-default');
  });

  test('resolveDefaultSession returns null when no default', () => {
    const pool = createTestPool();
    const registry = new WorkspaceRegistry();
    const manager = new SessionManager(pool, registry);

    registry.getOrCreate('ws1');
    expect(manager.resolveDefaultSession('ws1')).toBeNull();
  });

  // --- markArchived (软归档) 测试 ---

  test('markArchived flips DB flag without throwing when no live session entry', async () => {
    const pool = createTestPool();
    const registry = new WorkspaceRegistry();
    const manager = new SessionManager(pool, registry);

    createSessionRecord({ sessionId: 'soft-1', workspace: 'soft-ws' });
    const result = await manager.markArchived('soft-1');
    expect(result).toBe(true);
    expect(getSessionRecord('soft-1')!.archived).toBe(1);
  });

  test('markArchived does NOT overwrite default when archived session is not the default', async () => {
    const pool = createTestPool();
    const registry = new WorkspaceRegistry();
    const manager = new SessionManager(pool, registry);

    registry.getOrCreate('b2-ws');
    setDefaultSession('b2-ws', 'keep-this-default');
    createSessionRecord({ sessionId: 'not-default', workspace: 'b2-ws' });
    createSessionRecord({ sessionId: 'keep-this-default', workspace: 'b2-ws' });

    await manager.markArchived('not-default');

    // 归档的是 non-default session,default 应保持不变(B2 复现 = 这种情况)
    expect(getWorkspace('b2-ws')!.default_session_id).toBe('keep-this-default');
    expect(getSessionRecord('not-default')!.archived).toBe(1);
    expect(getSessionRecord('keep-this-default')!.archived).toBe(0);
  });

  test('markArchived (default session) reassigns default to next non-archived session (B2 fix)', async () => {
    const pool = createTestPool();
    const registry = new WorkspaceRegistry();
    const manager = new SessionManager(pool, registry);

    registry.getOrCreate('b2-ws');
    // 准备 3 条 session,最早一条是 default
    createSessionRecord({ sessionId: 'old-default', workspace: 'b2-ws' });
    createSessionRecord({ sessionId: 'middle', workspace: 'b2-ws' });
    createSessionRecord({ sessionId: 'newest', workspace: 'b2-ws' });
    setDefaultSession('b2-ws', 'old-default');

    // 把 newest 先归档掉(模拟:中间还有别的人归档过 newest)
    archiveSessionInDb('newest');

    // 现在归档 default
    const result = await manager.markArchived('old-default');
    expect(result).toBe(true);
    expect(getSessionRecord('old-default')!.archived).toBe(1);

    // B2 fix:应该选下一条 non-archived session 做 default
    // listSessionRecords 默认 filter archived=0,所以 middle 是唯一剩下的
    const newDefault = getWorkspace('b2-ws')!.default_session_id;
    expect(newDefault).toBe('middle');
    expect(newDefault).not.toBe('old-default');
  });

  test('markArchived (default session, no remaining) sets default to null', async () => {
    const pool = createTestPool();
    const registry = new WorkspaceRegistry();
    const manager = new SessionManager(pool, registry);

    registry.getOrCreate('solo-ws');
    createSessionRecord({ sessionId: 'only-session', workspace: 'solo-ws' });
    setDefaultSession('solo-ws', 'only-session');

    await manager.markArchived('only-session');

    // 没有其他 session 可选,default 应该是 null
    expect(getWorkspace('solo-ws')!.default_session_id).toBeNull();
  });

  test('restoreEntries maps live sessions from DB without duplicating rows or reviving archived default', async () => {
    const registry = new WorkspaceRegistry();
    registry.getOrCreate('restore-ws');
    createSessionRecord({ sessionId: 'live-restore', workspace: 'restore-ws' });
    createSessionRecord({ sessionId: 'archived-restore', workspace: 'restore-ws' });
    archiveSessionInDb('archived-restore');
    setDefaultSession('restore-ws', null);

    const pool = new RestoreOnlyPool([
      createRestoredEntry('live-restore', 'restore-ws', 'rk-live'),
      createRestoredEntry('archived-restore', 'restore-ws', 'rk-archived'),
    ]) as unknown as AgentRuntimePool;
    const manager = new SessionManager(pool, registry);

    await manager.restoreEntries();

    expect(listSessionRecords('restore-ws', { includeArchived: true }).map((row) => row.session_id).sort()).toEqual([
      'archived-restore',
      'live-restore',
    ]);
    expect(getSessionRecord('archived-restore')!.archived).toBe(1);
    expect(getWorkspace('restore-ws')!.default_session_id).toBe('live-restore');
    await manager.send('live-restore', 'hello after restore', 'msg-restore');
    expect(manager.getSession('live-restore')?.sessionId).toBe('live-restore');
    expect((pool as unknown as RestoreOnlyPool).sent).toEqual([{ routingKey: 'rk-live', text: 'hello after restore', messageId: 'msg-restore' }]);
  });
});
