import { EventEmitter } from 'events';
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
 * SessionManager — manages Session/Agent lifecycle with sessionId as the routing key.
 *
 * Wraps DirectorPool and delegates lifecycle operations to it.
 * Adds workspace-centric routing on top.
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

  /** Get or create a session for a workspace */
  async getOrCreateForWorkspace(workspaceName: string, opts: {
    feishuChatId: string;
    directorAgentName?: string;
    groupName?: string;
  }): Promise<SessionEntry> {
    this.workspaceRegistry.getOrCreate(workspaceName);
    const routingKey = opts.feishuChatId === 'web-console'
      ? `web-workspace:${workspaceName}`
      : opts.feishuChatId;

    const entry = await this.pool.getOrCreate(routingKey, {
      groupName: opts.groupName ?? workspaceName,
      feishuChatId: opts.feishuChatId,
      directorAgentName: opts.directorAgentName,
    });

    const sessionId = entry.bridge.getStatus().sessionId;
    if (sessionId) {
      this.registerSession(sessionId, routingKey, workspaceName, entry);
    }

    return this.toSessionEntry(entry);
  }

  /** Register a session mapping (sessionId → routingKey) */
  registerSession(sessionId: string, routingKey: string, workspace: string, entry: PoolEntry): void {
    this.sessionToRoutingKey.set(sessionId, routingKey);
    const existing = getSessionRecord(sessionId);
    if (!existing) {
      createSessionRecord({
        sessionId,
        workspace,
        role: entry.bridge.getPersonaRole(),
        cwd: entry.bridge.getStatus().agentType,
      });
    }
    const ws = this.workspaceRegistry.get(workspace);
    if (ws && !ws.default_session_id) {
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
    return archiveSessionInDb(sessionId);
  }

  /** List sessions for a workspace */
  listSessions(workspace: string, opts?: { includeArchived?: boolean }): SessionRow[] {
    return listSessionRecords(workspace, opts);
  }

  /** Resolve workspace default sessionId (for feishu path) */
  resolveDefaultSession(workspaceName: string): string | null {
    return this.workspaceRegistry.resolveDefaultSession(workspaceName);
  }

  // --- Delegated pool operations (lifecycle management) ---

  async restoreEntries(): Promise<void> {
    await this.pool.restoreEntries();
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

  // --- Lookup helpers (delegated) ---

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
