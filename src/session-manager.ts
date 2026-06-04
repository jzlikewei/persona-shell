import { EventEmitter } from 'events';
import type { DirectorPool, PoolEntry } from './director-pool.js';
import type { SessionBridge } from './session-bridge.js';
import type { MessageQueue } from './queue.js';
import type { AssistantTurnEvent, DirectorToolCall } from './director-session-adapter/index.js';
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
 * During the transition period, this wraps DirectorPool and delegates to it.
 * The goal is to eventually replace DirectorPool entirely.
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

  /** Get or create a session for a workspace (used by feishu path) */
  async getOrCreateForWorkspace(workspaceName: string, opts: {
    feishuChatId: string;
    directorAgentName?: string;
    groupName?: string;
  }): Promise<SessionEntry> {
    const ws = this.workspaceRegistry.getOrCreate(workspaceName);
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
