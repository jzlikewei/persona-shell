import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import type { DirectorPool, PoolEntry } from './director-pool.js';
import type { SessionBridge } from './session-bridge.js';
import type { MessageQueue, QueueItem } from './queue.js';
import type { AssistantTurnEvent, DirectorToolCall } from './director-session-adapter/index.js';
import type { CardAction } from './messaging/messaging.js';
import { WorkspaceRegistry } from './workspace-registry.js';
import { createSessionRecord, getSessionRecord, archiveSession as archiveSessionInDb, listSessionRecords, type SessionRow } from './task/task-store.js';

export interface SessionEntry {
  sessionId: string;
  workspace: string;
  bridge: SessionBridge;
  queue: MessageQueue;
  role: string;
  cwd?: string;
  lastActiveAt: number;
}

/**
 * SessionManager is the domain boundary for workspace/session routing.
 *
 * Business code should enter through workspace + sessionId methods here. The
 * underlying DirectorPool remains a runtime implementation detail for process,
 * queue, and streaming transport control.
 */
export class SessionManager extends EventEmitter {
  private pool: DirectorPool;
  private workspaceRegistry: WorkspaceRegistry;
  private sessionToRoutingKey = new Map<string, string>();

  constructor(pool: DirectorPool, workspaceRegistry: WorkspaceRegistry) {
    super();
    this.pool = pool;
    this.workspaceRegistry = workspaceRegistry;
    this.forwardPoolEvents();
  }

  // --- Session routing (new sessionId-based API) ---

  /** Send a message to a session by sessionId */
  async send(sessionId: string, text: string, messageId: string, options?: { webOnly?: boolean }): Promise<void> {
    const routingKey = this.sessionToRoutingKey.get(sessionId);
    if (!routingKey) throw new Error(`Session not found: ${sessionId}`);
    await this.pool.send(routingKey, text, messageId, options);
  }

  /** Get a session entry by sessionId */
  getSession(sessionId: string): SessionEntry | null {
    const routingKey = this.sessionToRoutingKey.get(sessionId);
    if (!routingKey) return null;
    const poolEntry = this.pool.get(routingKey);
    if (!poolEntry) return null;
    return this.toSessionEntry(poolEntry);
  }

  getPoolEntryBySessionId(sessionId: string): PoolEntry | null {
    const routingKey = this.sessionToRoutingKey.get(sessionId);
    if (!routingKey) return null;
    return this.pool.get(routingKey) ?? null;
  }

  getChatIdBySessionId(sessionId: string): string | null {
    return this.getPoolEntryBySessionId(sessionId)?.feishuChatId ?? null;
  }

  /** Get or create a session for a workspace */
  async getOrCreateForWorkspace(workspaceName: string, opts: {
    feishuChatId: string;
    directorAgentName?: string;
    groupName?: string;
  }): Promise<SessionEntry> {
    const workspace = this.workspaceRegistry.getOrCreate(workspaceName);
    const directorAgentName = opts.directorAgentName ?? workspace.agent ?? undefined;
    const routingKey = opts.feishuChatId === 'web-console'
      ? `web-workspace:${workspaceName}`
      : opts.feishuChatId;

    let entry = await this.pool.getOrCreate(routingKey, {
      groupName: opts.groupName ?? workspaceName,
      feishuChatId: opts.feishuChatId,
      directorAgentName,
    });

    let sessionId = entry.bridge.getStatus().sessionId;
    if (sessionId && getSessionRecord(sessionId)?.archived) {
      this.sessionToRoutingKey.delete(sessionId);
      entry = await this.pool.resetSession(routingKey, {
        groupName: opts.groupName ?? workspaceName,
        feishuChatId: opts.feishuChatId,
        directorAgentName,
      });
      sessionId = entry.bridge.getStatus().sessionId;
    }

    if (sessionId) {
      this.registerSession(sessionId, routingKey, workspaceName, entry);
    } else {
      entry.bridge.once('session-id-ready', (sid: string) => {
        this.registerSession(sid, routingKey, workspaceName, entry);
      });
    }

    return this.toSessionEntry(entry);
  }

  /** Revive a concrete session by its sessionId without falling back to another workspace session. */
  async reviveSession(sessionId: string, opts: {
    feishuChatId: string;
    directorAgentName?: string;
  }): Promise<SessionEntry | null> {
    const record = getSessionRecord(sessionId);
    if (!record || record.archived === 1) return null;

    const routingKey = this.sessionToRoutingKey.get(sessionId) ?? this.deriveReviveRoutingKey(sessionId, record);
    if (!routingKey) return null;

    const workspace = this.workspaceRegistry.getOrCreate(record.workspace);
    const directorAgentName = opts.directorAgentName
      ?? record.agent_name
      ?? workspace.agent
      ?? undefined;
    const entry = await this.pool.getOrCreate(routingKey, {
      groupName: record.workspace,
      feishuChatId: opts.feishuChatId,
      directorAgentName,
      initialSessionId: sessionId,
    });
    const revivedSessionId = entry.bridge.getStatus().sessionId;
    if (revivedSessionId) {
      this.registerSession(revivedSessionId, routingKey, record.workspace, entry);
    } else {
      entry.bridge.once('session-id-ready', (sid: string) => {
        this.registerSession(sid, routingKey, record.workspace, entry);
      });
    }
    return this.toSessionEntry(entry);
  }

  private deriveReviveRoutingKey(sessionId: string, record: SessionRow): string | null {
    // Codex app-server sessions are durable by threadId. Even if Shell restart
    // lost the runtime sessionId→routingKey map and pool:entries no longer
    // contains this concrete session, we can create a fresh runtime entry and
    // let the Codex adapter call thread/resume(sessionId).
    if (record.agent_type === 'codex-app-server') {
      return `web-session:${sessionId}`;
    }
    return null;
  }

  async sendToWorkspaceDefaultSession(workspaceName: string, opts: {
    feishuChatId: string;
    directorAgentName?: string;
    groupName?: string;
    text: string;
    messageId: string;
    sendOptions?: { webOnly?: boolean };
  }): Promise<SessionEntry> {
    const session = await this.getOrCreateForWorkspace(workspaceName, opts);
    if (session.sessionId) {
      await this.send(session.sessionId, opts.text, opts.messageId, opts.sendOptions);
      return session;
    }

    const routingKey = opts.feishuChatId === 'web-console'
      ? `web-workspace:${workspaceName}`
      : opts.feishuChatId;
    await this.pool.send(routingKey, opts.text, opts.messageId, opts.sendOptions);
    return session;
  }

  /** Create a brand-new session for a workspace (always spawns a new Agent) */
  async createNewSession(workspaceName: string, opts: {
    feishuChatId: string;
    directorAgentName?: string;
  }): Promise<SessionEntry> {
    const workspace = this.workspaceRegistry.getOrCreate(workspaceName);
    const directorAgentName = opts.directorAgentName ?? workspace.agent ?? undefined;
    const sessionKey = `web-session:${randomUUID().slice(0, 12)}`;
    const entry = await this.pool.getOrCreate(sessionKey, {
      groupName: workspaceName,
      feishuChatId: opts.feishuChatId,
      directorAgentName,
    });
    const sessionId = entry.bridge.getStatus().sessionId;
    if (sessionId) {
      this.registerSession(sessionId, sessionKey, workspaceName, entry);
    } else {
      // sessionId not yet available (Claude process still initializing).
      // Listen for the init event and register then.
      entry.bridge.once('session-id-ready', (sid: string) => {
        this.registerSession(sid, sessionKey, workspaceName, entry);
      });
    }
    return this.toSessionEntry(entry);
  }

  /** Register a session mapping (sessionId → routingKey) */
  registerSession(sessionId: string, routingKey: string, workspace: string, entry: PoolEntry): void {
    this.sessionToRoutingKey.set(sessionId, routingKey);
    const existing = getSessionRecord(sessionId);
    if (existing?.archived) {
      return;
    }
    if (!existing) {
      createSessionRecord({
        sessionId,
        workspace,
        role: entry.bridge.getPersonaRole(),
        cwd: entry.bridge.getWorkspaceCwd(),
        agentName: entry.bridge.getDirectorAgentName(),
        agentType: entry.bridge.getDirectorAgentType(),
        model: entry.bridge.getDirectorAgentModel(),
      });
    }
    const ws = this.workspaceRegistry.get(workspace);
    const defaultRecord = ws?.default_session_id ? getSessionRecord(ws.default_session_id) : null;
    if (ws && (!ws.default_session_id || defaultRecord?.archived)) {
      this.workspaceRegistry.setDefaultSession(workspace, sessionId);
    }
  }

  /** Archive a session — stop Agent, mark archived */
  async archiveSession(sessionId: string): Promise<boolean> {
    const routingKey = this.sessionToRoutingKey.get(sessionId);
    if (routingKey) {
      const entry = this.pool.get(routingKey);
      if (entry) {
        await this.pool.shutdown(routingKey);
      }
    }
    this.sessionToRoutingKey.delete(sessionId);
    const archived = archiveSessionInDb(sessionId);
    if (archived) {
      const record = getSessionRecord(sessionId);
      if (record) {
        const ws = this.workspaceRegistry.get(record.workspace);
        if (ws && ws.default_session_id === sessionId) {
          const remaining = listSessionRecords(record.workspace).filter(s => s.session_id !== sessionId);
          this.workspaceRegistry.setDefaultSession(record.workspace, remaining[0]?.session_id ?? null);
        }
      }
    }
    return archived;
  }

  /**
   * Mark a session as archived in the DB WITHOUT shutting down the Director process.
   * Used by the "soft archive" path (UI default) so live sessions keep running.
   *
   * MUST replicate the default_session_id cleanup from archiveSession (L113-118)
   * to avoid regressing B2 — otherwise the next getOrCreateForWorkspace would
   * resurrect the archived session as default.
   */
  async markArchived(sessionId: string): Promise<boolean> {
    const archived = archiveSessionInDb(sessionId);
    if (archived) {
      const record = getSessionRecord(sessionId);
      if (record) {
        const ws = this.workspaceRegistry.get(record.workspace);
        if (ws && ws.default_session_id === sessionId) {
          // 跟 archiveSession 一致:默认 filter archived=0(只选非归档的做新 default)
          const remaining = listSessionRecords(record.workspace).filter(s => s.session_id !== sessionId);
          this.workspaceRegistry.setDefaultSession(record.workspace, remaining[0]?.session_id ?? null);
        }
      }
    }
    return archived;
  }

  /** List sessions for a workspace */
  listSessions(workspace: string, opts?: { includeArchived?: boolean }): SessionRow[] {
    return listSessionRecords(workspace, opts);
  }

  /** Resolve workspace default sessionId (for feishu path) */
  resolveDefaultSession(workspaceName: string): string | null {
    return this.workspaceRegistry.resolveDefaultSession(workspaceName);
  }

  // --- Runtime operations ---
  // These methods intentionally expose runtime controls for command handlers,
  // diagnostics, queue cancellation, process recovery, and Web Console runtime
  // panels. They are not domain sources for workspace/session routing.

  async restoreEntries(): Promise<void> {
    await this.pool.restoreEntries();
    // Backfill the sessionId→routingKey map for every restored entry.
    // The pool's restoreEntries() reconnects orphan Director processes and assigns
    // bridge.sessionId from persisted state, but it doesn't (and shouldn't) know about
    // SessionManager's routing index. Without this, /api/send by sessionId 404s for
    // every workspace session restored from a previous Shell run.
    let registered = 0;
    for (const entry of this.pool.listActiveEntries()) {
      const sessionId = entry.bridge.getStatus().sessionId;
      if (!sessionId) continue;
      this.registerSession(sessionId, entry.routingKey, entry.groupName, entry);
      registered++;
    }
    if (registered > 0) {
      console.log(`[session-manager] Registered ${registered} restored session(s) in routing map`);
    }
  }

  async killUnknownOrphans(): Promise<void> {
    await this.pool.killUnknownOrphans();
  }

  async cancelByCardAction(action: CardAction): Promise<boolean> {
    return this.pool.cancelByCardAction(action);
  }

  async abortStreamingReply(correlationId: string, text?: string): Promise<void> {
    return this.pool.abortStreamingReply(correlationId, text);
  }

  async notifyTaskDone(label: string, taskId: string, success: boolean, notifyMsgId?: string): Promise<void> {
    return this.pool.notifyTaskDone(label, taskId, success, notifyMsgId);
  }

  async flushAll(): Promise<void> {
    return this.pool.flushAll();
  }

  async detachAll(): Promise<void> {
    return this.pool.detachAll();
  }

  async shutdownAll(): Promise<void> {
    return this.pool.shutdownAll();
  }

  async resetSession(routingKey: string, opts: { groupName?: string; feishuChatId: string; directorAgentName?: string }): Promise<PoolEntry> {
    return this.pool.resetSession(routingKey, opts);
  }

  async setDirectorAgent(routingKey: string, opts: { groupName?: string; feishuChatId: string; directorAgentName: string }): Promise<PoolEntry> {
    return this.pool.setDirectorAgent(routingKey, opts);
  }

  async switchAgentByLabel(label: string, agentName: string): Promise<PoolEntry> {
    return this.pool.switchAgentByLabel(label, agentName);
  }

  async switchPersonaByLabel(label: string, roleName: string): Promise<PoolEntry> {
    return this.pool.switchPersonaByLabel(label, roleName);
  }

  async flushByLabel(label: string): Promise<boolean> {
    return this.pool.flushByLabel(label);
  }

  async clearContextByLabel(label: string): Promise<boolean> {
    return this.pool.clearContextByLabel(label);
  }

  async restartByLabel(label: string): Promise<void> {
    return this.pool.restartByLabel(label);
  }

  async interruptOldestByLabel(label: string): Promise<QueueItem | undefined> {
    return this.pool.interruptOldestByLabel(label);
  }

  async detachByLabel(label: string): Promise<PoolEntry> {
    return this.pool.detachByLabel(label);
  }

  // --- Runtime lookup helpers ---

  findByLabel(label: string): PoolEntry | undefined {
    return this.pool.findByLabel(label);
  }

  get(routingKey: string): PoolEntry | undefined {
    return this.pool.get(routingKey);
  }

  getChatIdByLabel(label: string): string | null {
    return this.pool.getChatIdByLabel(label);
  }

  getDirectorAgentName(routingKey: string): string | undefined {
    return this.pool.getDirectorAgentName(routingKey);
  }

  getProcessingMessageIdByLabel(label: string): string | null {
    return this.pool.getProcessingMessageIdByLabel(label);
  }

  async cancelQueuedByLabel(label: string, correlationId: string) {
    return this.pool.cancelQueuedByLabel(label, correlationId);
  }

  getPoolStatus() {
    return this.pool.getPoolStatus();
  }

  get size(): number {
    return this.pool.size;
  }

  /** Access the underlying pool (transition period) */
  getPool(): DirectorPool {
    return this.pool;
  }

  private toSessionEntry(poolEntry: PoolEntry): SessionEntry {
    const status = poolEntry.bridge.getStatus();
    return {
      sessionId: status.sessionId ?? '',
      workspace: poolEntry.groupName,
      bridge: poolEntry.bridge,
      queue: poolEntry.queue,
      role: status.personaRole,
      cwd: poolEntry.bridge.getWorkspaceCwd(),
      lastActiveAt: poolEntry.lastActiveAt,
    };
  }

  private forwardPoolEvents(): void {
    for (const event of ['chunk', 'tool-call', 'stream-abort', 'turn-event', 'input-message', 'web-reply', 'web-alert']) {
      this.pool.on(event, (...args: unknown[]) => {
        this.emit(event, ...args);
      });
    }
  }
}
