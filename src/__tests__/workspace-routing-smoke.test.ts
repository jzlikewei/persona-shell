import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { DirectorPool } from '../director-pool.js';
import type { PoolEntry } from '../director-pool.js';
import type {
  DirectorSessionAdapter,
  DirectorSessionAdapterHooks,
  DirectorSessionAdapterOptions,
  DirectorTurnResult,
} from '../director-session-adapter/index.js';
import type { DirectorRuntimeStatus, DirectorSendResult } from '../director-runtime/index.js';
import { initLogDir } from '../logger.js';
import type { MessagingClient } from '../messaging/messaging.js';
import { MessageQueue } from '../queue.js';
import { SessionBridge } from '../session-bridge.js';
import { SessionManager } from '../session-manager.js';
import {
  archiveSession,
  createCronJob,
  createTask,
  getSessionRecord,
  getWorkspace,
  initTaskStore,
} from '../task/task-store.js';
import { WorkspaceRegistry } from '../workspace-registry.js';

const TEST_DIR = '/tmp/persona-workspace-routing-smoke';

class SmokeAdapter implements DirectorSessionAdapter {
  static instances: SmokeAdapter[] = [];
  static nextId = 1;
  readonly sent: string[] = [];
  readonly terminations: NodeJS.Signals[] = [];
  ready = true;
  activeTurn = false;
  sessionId = `smoke-session-${SmokeAdapter.nextId++}`;
  status: DirectorRuntimeStatus = { kind: 'codex-app-server', alive: true, pid: null };

  constructor(
    readonly options: DirectorSessionAdapterOptions,
    readonly hooks: DirectorSessionAdapterHooks,
  ) {
    SmokeAdapter.instances.push(this);
  }

  async start(): Promise<boolean> {
    const restored = this.hooks.restorePersistedSession();
    if (restored.sessionId) {
      this.sessionId = restored.sessionId;
    } else {
      this.hooks.persistSession(this.sessionId, `fake-thread-${this.sessionId}`);
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

function createBridge(label: string, groupName: string, isMain = false): SessionBridge {
  return new SessionBridge({
    agents: {
      defaults: { director: 'fake', default: 'fake' },
      providers: {
        fake: { type: 'codex-app-server', command: 'fake-codex' },
      },
    },
    config: {
      persona_dir: TEST_DIR,
      pipe_dir: TEST_DIR,
      pid_file: join(TEST_DIR, 'director.pid'),
      time_sync_interval_ms: 999999,
      flush_context_limit: 999999,
      flush_interval_ms: 999999,
      quote_max_length: 32,
    },
    label,
    isMain,
    groupName,
    directorFactory: (options, hooks) => new SmokeAdapter(options, hooks),
  });
}

function createMessaging(): MessagingClient {
  return {
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
  };
}

class SmokePool extends DirectorPool {
  private smokeEntries = new Map<string, PoolEntry>();

  private async createEntry(routingKey: string, opts: { groupName?: string; feishuChatId: string; directorAgentName?: string }): Promise<PoolEntry> {
    const groupName = opts.groupName ?? routingKey;
    const bridge = createBridge(`smoke-${routingKey}-${SmokeAdapter.nextId}`, groupName);
    await bridge.start();
    return {
      bridge,
      queue: new MessageQueue('/dev/null'),
      routingKey,
      feishuChatId: opts.feishuChatId,
      groupName,
      lastActiveAt: Date.now(),
      directorAgentName: opts.directorAgentName,
      messagesSinceFlush: 0,
    };
  }

  async getOrCreate(routingKey: string, opts: { groupName?: string; feishuChatId: string; directorAgentName?: string }): Promise<PoolEntry> {
    const existing = this.smokeEntries.get(routingKey);
    if (existing) return existing;

    const entry = await this.createEntry(routingKey, opts);
    this.smokeEntries.set(routingKey, entry);
    return entry;
  }

  get(routingKey: string): PoolEntry | undefined {
    return this.smokeEntries.get(routingKey);
  }

  async send(routingKey: string, text: string): Promise<void> {
    const entry = this.smokeEntries.get(routingKey);
    if (!entry) throw new Error(`No smoke entry for ${routingKey}`);
    await entry.bridge.send(text);
  }

  async resetSession(routingKey: string, opts: { groupName?: string; feishuChatId: string; directorAgentName?: string }): Promise<PoolEntry> {
    const entry = await this.createEntry(routingKey, opts);
    entry.lastActiveAt = Date.now();
    this.smokeEntries.set(routingKey, entry);
    return entry;
  }
}

function createManager(): SessionManager {
  const pool = new SmokePool(
    createBridge('main', 'main', true),
    { max_directors: 10, idle_timeout_minutes: 0, small_group_threshold: 5 },
    {
      defaults: { director: 'fake', default: 'fake' },
      providers: {
        fake: { type: 'codex-app-server', command: 'fake-codex' },
      },
    },
    {
      persona_dir: TEST_DIR,
      pipe_dir: TEST_DIR,
      pid_file: join(TEST_DIR, 'director.pid'),
      time_sync_interval_ms: 999999,
      flush_context_limit: 999999,
      flush_interval_ms: 999999,
      quote_max_length: 32,
    },
    createMessaging(),
  );
  return new SessionManager(pool, new WorkspaceRegistry());
}

describe('smoke:workspace-routing', () => {
  beforeEach(() => {
    SmokeAdapter.instances = [];
    SmokeAdapter.nextId = 1;
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    initTaskStore(TEST_DIR);
    initLogDir(TEST_DIR);
  });

  test('web workspace creates a session and sends by sessionId', async () => {
    const manager = createManager();
    const session = await manager.createNewSession('smoke-web', { feishuChatId: 'web-console', directorAgentName: 'fake' });

    await manager.send(session.sessionId, 'web hello', 'msg-web', { webOnly: true });

    expect(session.workspace).toBe('smoke-web');
    expect(getSessionRecord(session.sessionId)?.workspace).toBe('smoke-web');
    expect(manager.getSession(session.sessionId)?.sessionId).toBe(session.sessionId);
    expect(SmokeAdapter.instances.at(-1)?.sent.some((line) => line.includes('web hello'))).toBe(true);
  });

  test('small group routes through workspace default session', async () => {
    const manager = createManager();

    const session = await manager.sendToWorkspaceDefaultSession('smoke-group', {
      feishuChatId: 'oc_smoke_group',
      groupName: 'smoke-group',
      directorAgentName: 'fake',
      text: 'group hello',
      messageId: 'msg-group-1',
    });
    await manager.sendToWorkspaceDefaultSession('smoke-group', {
      feishuChatId: 'oc_smoke_group',
      groupName: 'smoke-group',
      directorAgentName: 'fake',
      text: 'group again',
      messageId: 'msg-group-2',
    });

    expect(getWorkspace('smoke-group')?.default_session_id).toBe(session.sessionId);
    expect(getSessionRecord(session.sessionId)?.workspace).toBe('smoke-group');
    expect(SmokeAdapter.instances.at(-1)?.sent.some((line) => line.includes('group hello'))).toBe(true);
    expect(SmokeAdapter.instances.at(-1)?.sent.some((line) => line.includes('group again'))).toBe(true);
  });

  test('archived default session is replaced on next workspace message', async () => {
    const manager = createManager();
    const first = await manager.sendToWorkspaceDefaultSession('archive-smoke', {
      feishuChatId: 'oc_archive_smoke',
      groupName: 'archive-smoke',
      directorAgentName: 'fake',
      text: 'first',
      messageId: 'msg-archive-1',
    });

    expect(archiveSession(first.sessionId)).toBe(true);

    const second = await manager.sendToWorkspaceDefaultSession('archive-smoke', {
      feishuChatId: 'oc_archive_smoke',
      groupName: 'archive-smoke',
      directorAgentName: 'fake',
      text: 'second',
      messageId: 'msg-archive-2',
    });

    expect(second.sessionId).not.toBe(first.sessionId);
    expect(getSessionRecord(first.sessionId)?.archived).toBe(1);
    expect(getWorkspace('archive-smoke')?.default_session_id).toBe(second.sessionId);
    expect(getSessionRecord(second.sessionId)?.workspace).toBe('archive-smoke');
    expect(SmokeAdapter.instances.at(-1)?.sent.some((line) => line.includes('second'))).toBe(true);
  });

  test('task and cron records carry workspace/session routing evidence', async () => {
    const manager = createManager();
    const session = await manager.sendToWorkspaceDefaultSession('work-routing', {
      feishuChatId: 'oc_work_routing',
      groupName: 'work-routing',
      directorAgentName: 'fake',
      text: 'prepare',
      messageId: 'msg-work-routing',
    });

    const task = createTask({
      type: 'role',
      role: 'executor',
      description: 'workspace routing smoke task',
      prompt: 'verify routing',
      source_session_id: session.sessionId,
      workspace: session.workspace,
      source_director: 'legacy-label',
    });
    const cron = createCronJob({
      name: 'workspace-routing-smoke',
      role: 'executor',
      description: 'workspace routing smoke cron',
      prompt: 'verify cron routing',
      schedule: 'every 30m',
      workspace: session.workspace,
      source_director: 'legacy-label',
    });

    expect(task.source_session_id).toBe(session.sessionId);
    expect(task.workspace).toBe('work-routing');
    expect(task.source_director).toBeNull();
    expect(cron.workspace).toBe('work-routing');
    expect(cron.source_director).toBeNull();
    expect(manager.resolveDefaultSession('work-routing')).toBe(session.sessionId);
  });
});
