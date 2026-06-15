import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import type { AgentRuntimePool, RuntimeEntry } from './agent-runtime-pool.js';
import type { SessionBridge } from './session-bridge.js';
import type { MessageQueue, QueueItem, PendingAttachment } from './queue.js';
import type { DirectorInputAttachment } from './director-input.js';
import type { AssistantTurnEvent, DirectorToolCall } from './director-session-adapter/index.js';
import type { CardAction } from './messaging/messaging.js';
import { WorkspaceRegistry } from './workspace-registry.js';
import { createSessionRecord, getSessionRecord, archiveSession as archiveSessionInDb, listSessionRecords, setDefaultSession, type SessionRow } from './task/task-store.js';

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
 * underlying AgentRuntimePool remains a runtime implementation detail for process,
 * queue, and streaming transport control.
 */
export class SessionManager extends EventEmitter {
  private pool: AgentRuntimePool;
  private workspaceRegistry: WorkspaceRegistry;
  private sessionToRoutingKey = new Map<string, string>();

  constructor(pool: AgentRuntimePool, workspaceRegistry: WorkspaceRegistry) {
    super();
    this.pool = pool;
    this.workspaceRegistry = workspaceRegistry;
    this.forwardPoolEvents();
  }

  // --- Session routing (new sessionId-based API) ---

  /** Send a message to a session by sessionId */
  async send(sessionId: string, text: string, messageId: string, options?: { webOnly?: boolean; inputAttachments?: DirectorInputAttachment[] }): Promise<void> {
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

  getRuntimeEntryBySessionId(sessionId: string): RuntimeEntry | null {
    const routingKey = this.sessionToRoutingKey.get(sessionId);
    if (!routingKey) return null;
    return this.pool.get(routingKey) ?? null;
  }

  getChatIdBySessionId(sessionId: string): string | null {
    return this.getRuntimeEntryBySessionId(sessionId)?.feishuChatId ?? null;
  }

  getProcessingMessageIdBySessionId(sessionId: string): string | null {
    const entry = this.getRuntimeEntryBySessionId(sessionId);
    const item = entry?.queue.peek();
    return item?.messageId ?? null;
  }

  enqueueAttachmentForHeadBySessionId(sessionId: string, attachment: PendingAttachment): QueueItem | null {
    const entry = this.getRuntimeEntryBySessionId(sessionId);
    return entry?.queue.addPendingAttachmentToOldest(attachment) ?? null;
  }

  /** Get or create a session for a workspace */
  async getOrCreateForWorkspace(workspaceName: string, opts: {
    feishuChatId: string;
    agentName?: string;
    workspaceName?: string;
  }): Promise<SessionEntry> {
    const workspace = this.workspaceRegistry.getOrCreate(workspaceName);
    const agentName = opts.agentName ?? workspace.agent ?? undefined;
    const routingKey = opts.feishuChatId === 'web-console'
      ? `web-workspace:${workspaceName}`
      : opts.feishuChatId;

    let entry = await this.pool.getOrCreate(routingKey, {
      workspaceName: opts.workspaceName ?? workspaceName,
      feishuChatId: opts.feishuChatId,
      agentName,
    });

    let sessionId = entry.bridge.getStatus().sessionId;
    if (sessionId && getSessionRecord(sessionId)?.archived) {
      this.sessionToRoutingKey.delete(sessionId);
      entry = await this.pool.resetSession(routingKey, {
        workspaceName: opts.workspaceName ?? workspaceName,
        feishuChatId: opts.feishuChatId,
        agentName,
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
    agentName?: string;
  }): Promise<SessionEntry | null> {
    const record = getSessionRecord(sessionId);
    if (!record || record.archived === 1) return null;

    const routingKey = this.sessionToRoutingKey.get(sessionId) ?? this.deriveReviveRoutingKey(sessionId, record);
    if (!routingKey) return null;

    const workspace = this.workspaceRegistry.getOrCreate(record.workspace);
    const agentName = opts.agentName
      ?? record.agent_name
      ?? workspace.agent
      ?? undefined;
    const entry = await this.pool.getOrCreate(routingKey, {
      workspaceName: record.workspace,
      feishuChatId: opts.feishuChatId,
      agentName,
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
    // Session routing must be independent from channel/runtime labels.  When a
    // runtime map is gone, create a fresh internal routing key and let the
    // adapter resume from initialSessionId.  The prefix is intentionally
    // channel-neutral: Feishu/Web must both route through workspace.default_session_id.
    void record;
    return `session:${sessionId}`;
  }

  async sendToWorkspaceDefaultSession(workspaceName: string, opts: {
    feishuChatId: string;
    agentName?: string;
    workspaceName?: string;
    text: string;
    messageId: string;
    sendOptions?: { webOnly?: boolean };
    inputAttachments?: DirectorInputAttachment[];
  }): Promise<SessionEntry> {
    const session = await this.resolveWorkspaceDefaultSession(workspaceName, {
      feishuChatId: opts.feishuChatId,
      agentName: opts.agentName,
    });
    await this.send(session.sessionId, opts.text, opts.messageId, { ...opts.sendOptions, inputAttachments: opts.inputAttachments });
    return session;
  }

  /**
   * Resolve the business-level default session for a workspace.
   *
   * Rules:
   * - valid workspace.default_session_id wins;
   * - if no valid default and exactly one active session remains, promote it;
   * - if no active session exists, create a new session and make it default;
   * - if multiple active sessions exist without an explicit default, refuse to guess.
   */
  async resolveWorkspaceDefaultSession(workspaceName: string, opts: {
    feishuChatId: string;
    agentName?: string;
  }): Promise<SessionEntry> {
    this.workspaceRegistry.getOrCreate(workspaceName);
    const defaultId = this.normalizeWorkspaceDefault(workspaceName);
    if (defaultId) {
      const live = this.getSession(defaultId);
      if (live) return live;

      const record = getSessionRecord(defaultId);
      const revived = await this.reviveSession(defaultId, {
        feishuChatId: opts.feishuChatId,
        agentName: record?.agent_name ?? opts.agentName,
      });
      if (revived?.sessionId) return revived;
      throw new Error(`default session cannot be revived: ${defaultId}`);
    }

    const active = listSessionRecords(workspaceName);
    if (active.length === 0) {
      return this.createNewSession(workspaceName, opts);
    }

    throw new Error(`workspace "${workspaceName}" has ${active.length} active sessions but no default_session_id`);
  }

  /** Set a workspace default session explicitly. */
  setWorkspaceDefaultSession(sessionId: string): SessionRow {
    const record = getSessionRecord(sessionId);
    if (!record) throw new Error(`session not found: ${sessionId}`);
    if (record.archived === 1) throw new Error(`cannot set archived session as default: ${sessionId}`);
    this.workspaceRegistry.getOrCreate(record.workspace);
    this.workspaceRegistry.setDefaultSession(record.workspace, sessionId);
    return record;
  }

  /** Create a brand-new session for a workspace (always spawns a new Agent) */
  async createNewSession(workspaceName: string, opts: {
    feishuChatId: string;
    agentName?: string;
  }): Promise<SessionEntry> {
    const workspace = this.workspaceRegistry.getOrCreate(workspaceName);
    const agentName = opts.agentName ?? workspace.agent ?? undefined;
    const sessionKey = `web-session:${randomUUID().slice(0, 12)}`;
    const entry = await this.pool.getOrCreate(sessionKey, {
      workspaceName: workspaceName,
      feishuChatId: opts.feishuChatId,
      agentName,
    });
    let sessionId = entry.bridge.getStatus().sessionId;
    if (!sessionId) {
      // Wait for Claude process to emit system.init with session_id (typically <5s)
      sessionId = await new Promise<string>((resolve) => {
        const timeout = setTimeout(() => resolve(''), 15_000);
        entry.bridge.once('session-id-ready', (sid: string) => {
          clearTimeout(timeout);
          resolve(sid);
        });
      });
    }
    if (sessionId) {
      this.registerSession(sessionId, sessionKey, workspaceName, entry);
    }
    return this.toSessionEntry(entry);
  }

  /** Register a session mapping (sessionId → routingKey) */
  registerSession(sessionId: string, routingKey: string, workspace: string, entry: RuntimeEntry): void {
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
        agentName: entry.bridge.getAgentName(),
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
        this.normalizeWorkspaceDefault(record.workspace);
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
        this.normalizeWorkspaceDefault(record.workspace);
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
    return this.normalizeWorkspaceDefault(workspaceName);
  }

  private normalizeWorkspaceDefault(workspaceName: string): string | null {
    const ws = this.workspaceRegistry.getOrCreate(workspaceName);
    const current = ws.default_session_id ? getSessionRecord(ws.default_session_id) : null;
    if (current && current.workspace === workspaceName && current.archived !== 1) {
      return current.session_id;
    }

    const active = listSessionRecords(workspaceName);
    const nextDefault = active.length === 1 ? active[0].session_id : null;
    setDefaultSession(workspaceName, nextDefault);
    return nextDefault;
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
      this.registerSession(sessionId, entry.routingKey, entry.workspaceName, entry);
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

  async resetSession(routingKey: string, opts: { workspaceName?: string; feishuChatId: string; agentName?: string }): Promise<RuntimeEntry> {
    return this.pool.resetSession(routingKey, opts);
  }

  async setAgent(routingKey: string, opts: { workspaceName?: string; feishuChatId: string; agentName: string }): Promise<RuntimeEntry> {
    return this.pool.setAgent(routingKey, opts);
  }

  async runtimeSwitchAgentByLabel(label: string, agentName: string): Promise<RuntimeEntry> {
    return this.pool.switchAgentByLabel(label, agentName);
  }

  async runtimeSwitchPersonaByLabel(label: string, roleName: string): Promise<RuntimeEntry> {
    return this.pool.switchPersonaByLabel(label, roleName);
  }

  async runtimeFlushByLabel(label: string): Promise<boolean> {
    return this.pool.flushByLabel(label);
  }

  async runtimeClearContextByLabel(label: string): Promise<boolean> {
    return this.pool.clearContextByLabel(label);
  }

  async runtimeRestartByLabel(label: string): Promise<void> {
    return this.pool.restartByLabel(label);
  }

  async runtimeInterruptOldestByLabel(label: string): Promise<QueueItem | undefined> {
    return this.pool.interruptOldestByLabel(label);
  }

  async runtimeDetachByLabel(label: string): Promise<RuntimeEntry> {
    return this.pool.detachByLabel(label);
  }

  // --- Runtime lookup helpers ---

  runtimeFindByLabel(label: string): RuntimeEntry | undefined {
    return this.pool.findByLabel(label);
  }

  runtimeGet(routingKey: string): RuntimeEntry | undefined {
    return this.pool.get(routingKey);
  }

  runtimeGetChatIdByLabel(label: string): string | null {
    return this.pool.getChatIdByLabel(label);
  }

  runtimeGetAgentName(routingKey: string): string | undefined {
    return this.pool.getAgentName(routingKey);
  }

  runtimeGetProcessingMessageIdByLabel(label: string): string | null {
    return this.pool.getProcessingMessageIdByLabel(label);
  }

  async runtimeCancelQueuedByLabel(label: string, correlationId: string) {
    return this.pool.cancelQueuedByLabel(label, correlationId);
  }

  getRuntimeStatus() {
    return this.pool.getRuntimeStatus();
  }

  get size(): number {
    return this.pool.size;
  }

  /** Access the underlying pool (transition period) */
  getRuntime(): AgentRuntimePool {
    return this.pool;
  }

  private toSessionEntry(poolEntry: RuntimeEntry): SessionEntry {
    const status = poolEntry.bridge.getStatus();
    return {
      sessionId: status.sessionId ?? '',
      workspace: poolEntry.workspaceName,
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
