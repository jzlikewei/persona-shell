import { createHash } from 'crypto';
import { EventEmitter } from 'events';
import type { AssistantTurnEvent, DirectorToolCall } from './director-session-adapter/index.js';
import { existsSync, readdirSync } from 'fs';
import { extname, join } from 'path';
import { SessionBridge, type SessionBridgeOptions } from './session-bridge.js';
import { MessageQueue, type PendingAttachment, type QueueItem } from './queue.js';
import type { DirectorInputAttachment } from './director-input.js';
import { ClaudeProcess } from './claude-process.js';
import { loadConfig, type Config, isCodexFamily } from './config.js';
import type { CardAction, MessagingClient, StreamingReplyHandle } from './messaging/messaging.js';
import { getState, setState, getWorkspace } from './task/task-store.js';
import { log, getLogDir } from './logger.js';

/** Pool entry data persisted to SQLite for crash recovery */
interface PersistedRuntimeEntry {
  routingKey: string;
  feishuChatId: string;
  workspaceName: string;
  label: string;
  lastActiveAt: number;
  agentName?: string;
  /** @deprecated legacy field name, migrated to workspaceName on restore */
  groupName?: string;
  /** @deprecated legacy field name, migrated to agentName on restore */
  directorAgentName?: string;
}

export interface PoolConfig {
  max_directors: number;
  idle_timeout_minutes: number;
  small_group_threshold: number;
}

export interface RuntimeEntry {
  bridge: SessionBridge;
  queue: MessageQueue;
  routingKey: string;       // Map key（chatId 或 threadId）
  feishuChatId: string;     // 实际的飞书 chatId（oc_xxx），用于 sendMessage
  workspaceName: string;
  lastActiveAt: number;
  agentName?: string;
  messagesSinceFlush: number;
}

interface RuntimeCreateOptions {
  workspaceName?: string;
  feishuChatId: string;
  agentName?: string;
  initialSessionId?: string;
}

/** Metadata for closed pool sessions (kept for UI display) */
interface ClosedRuntimeEntry {
  routingKey: string;
  feishuChatId: string;
  workspaceName: string;
  label: string;
  lastActiveAt: number;
  closedAt: number;
  closedReason?: 'shutdown' | 'detached' | 'closed';
  agentName?: string;
  /** @deprecated legacy field name, migrated to workspaceName on restore */
  groupName?: string;
  /** @deprecated legacy field name, migrated to agentName on restore */
  directorAgentName?: string;
}

const MIN_MESSAGES_FOR_FLUSH = 5;

/**
 * Runtime pool for non-main Agent processes.
 *
 * AgentRuntimePool owns process lifecycle, queues, streaming transports, recovery,
 * and low-level runtime commands. Workspace/session routing belongs to
 * SessionManager; routingKey is only this pool's internal Map key.
 */
export class AgentRuntimePool extends EventEmitter {
  private entries: Map<string, RuntimeEntry> = new Map();
  private closedEntries: Map<string, ClosedRuntimeEntry> = new Map();
  private creating: Map<string, Promise<RuntimeEntry>> = new Map();
  private mainBridge: SessionBridge;
  private poolConfig: PoolConfig;
  private agentsConfig: Config['agents'];
  private directorConfig: Config['director'];
  private messaging: MessagingClient;
  private dynamicToolHandler?: SessionBridgeOptions['dynamicToolHandler'];
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private configPath?: string;
  private streamingReplies = new Map<string, StreamingReplyHandle>();
  private systemStreamingReplies = new Map<string, StreamingReplyHandle>();
  private streamCardToCorrelationId = new Map<string, string>();
  private streamSourceToCorrelationId = new Map<string, string>();
  private streamReplyRoutingKeys = new Map<string, string>();
  private systemCardToMessageId = new Map<string, { label: string; messageId: string }>();
  private systemSourceMessageIds = new Map<string, string>();
  private cancelledSystemMessageIds = new Set<string>();

  constructor(
    mainBridge: SessionBridge,
    poolConfig: PoolConfig,
    agentsConfig: Config['agents'],
    directorConfig: Config['director'],
    messaging: MessagingClient,
    configPath?: string,
    dynamicToolHandler?: SessionBridgeOptions['dynamicToolHandler'],
  ) {
    super();
    this.mainBridge = mainBridge;
    this.poolConfig = poolConfig;
    this.agentsConfig = agentsConfig;
    this.directorConfig = directorConfig;
    this.messaging = messaging;
    this.configPath = configPath;
    this.dynamicToolHandler = dynamicToolHandler;

    // Restore closed entries from SQLite
    const savedClosed = getState<ClosedRuntimeEntry[]>('pool:closed');
    if (savedClosed) {
      let migrated = false;
      for (const entry of savedClosed) {
        // [MIGRATION] 0ad1d3f renamed groupName→workspaceName, directorAgentName→agentName.
        // Persisted data may still use old field names, or workspaceName may be missing entirely.
        // Safe to remove once all running instances have restarted at least once after 2026-06-10.
        // entry may carry deprecated groupName / directorAgentName from old persisted data
        if (!entry.workspaceName && entry.groupName) {
          entry.workspaceName = entry.groupName;
          delete entry.groupName;
          migrated = true;
        }
        if (!entry.workspaceName) {
          entry.workspaceName = entry.routingKey.startsWith('web-workspace:')
            ? entry.routingKey.slice('web-workspace:'.length)
            : entry.routingKey.startsWith('web-session:')
              ? entry.routingKey.slice('web-session:'.length)
              : entry.routingKey.slice(0, 8);
          migrated = true;
        }
        if (!entry.agentName && entry.directorAgentName) {
          entry.agentName = entry.directorAgentName;
          delete entry.directorAgentName;
          migrated = true;
        }
        this.closedEntries.set(entry.routingKey, entry);
      }
      if (migrated) {
        setState('pool:closed', [...this.closedEntries.values()]);
        console.log('[pool] Migrated pool:closed entries from legacy field names (groupName→workspaceName)');
      }
    }

    // Start idle Director reaper — check every minute, shutdown Directors
    // that have been idle longer than idle_timeout_minutes
    if (poolConfig.idle_timeout_minutes > 0) {
      this.idleTimer = setInterval(() => this.reapIdle(), 60_000);
    }
  }

  /** Get the main (p2p) SessionBridge */
  getMain(): SessionBridge {
    return this.mainBridge;
  }

  /** Get a group Director if it exists (by routingKey) */
  get(routingKey: string): RuntimeEntry | undefined {
    return this.entries.get(routingKey);
  }

  /** List active (non-closed) pool entries. Used by SessionManager to backfill
   *  the sessionId→routingKey map after restoreEntries() reconnects orphan Directors;
   *  without this, /api/send by sessionId would 404 on every restored workspace session. */
  listActiveEntries(): RuntimeEntry[] {
    return [...this.entries.values()];
  }

  /** Reset an existing or remembered group Director session. */
  async resetSession(routingKey: string, opts: RuntimeCreateOptions): Promise<RuntimeEntry> {
    const existing = this.entries.get(routingKey);
    if (existing) {
      await existing.bridge.resetSession();
      existing.agentName = existing.bridge.getAgentName();
      existing.lastActiveAt = Date.now();
      this.closedEntries.delete(routingKey);
      this.persistEntries();
      return existing;
    }

    const entry = await this.getOrCreate(routingKey, opts);
    await entry.bridge.resetSession();
    entry.agentName = entry.bridge.getAgentName();
    entry.lastActiveAt = Date.now();
    this.persistEntries();
    return entry;
  }

  /** Find a pool entry by Director label (for task callback routing) */
  findByLabel(label: string): RuntimeEntry | undefined {
    for (const entry of this.entries.values()) {
      if (entry.bridge.label === label) return entry;
    }
    return undefined;
  }

  /** Resolve a pool Director by workspace name (or label as fallback).
   *  When multiple sessions exist for the same workspace, returns the most recently active.
   *  Priority: workspaceName match (most recent) → web-workspace derived key → label exact */
  resolveWorkspace(name: string): RuntimeEntry | undefined {
    const candidates: RuntimeEntry[] = [];
    const safe = name.replace(/[\/\\:*?"<>|]/g, '_');
    for (const entry of this.entries.values()) {
      if (entry.workspaceName === name || entry.workspaceName.replace(/[\/\\:*?"<>|]/g, '_') === safe) {
        candidates.push(entry);
      }
    }
    if (candidates.length > 0) {
      return candidates.reduce((best, e) => e.lastActiveAt > best.lastActiveAt ? e : best);
    }
    const derived = this.entries.get(`web-workspace:${name}`);
    if (derived) return derived;
    return this.findByLabel(name);
  }

  private requireByLabel(label: string): RuntimeEntry {
    const entry = this.findByLabel(label);
    if (!entry) throw new Error(`Director label not found: ${label}`);
    return entry;
  }

  /** Number of active group Directors */
  get size(): number {
    return this.entries.size;
  }


  /** Get or create a Director for a group chat.
   *  @param routingKey — Map key (chatId for regular groups, threadId for topic groups)
   *  @param opts — group metadata for creation */
  async getOrCreate(routingKey: string, opts: RuntimeCreateOptions): Promise<RuntimeEntry> {
    const existing = this.entries.get(routingKey);
    if (existing) {
      existing.lastActiveAt = Date.now();
      if (opts.workspaceName && opts.workspaceName !== existing.workspaceName) {
        existing.workspaceName = opts.workspaceName;
      }
      existing.agentName = existing.bridge.getAgentName();
      this.persistEntries();
      return existing;
    }

    // 防止并发创建同一个 routingKey 的 Director（竞态锁）
    const inflight = this.creating.get(routingKey);
    if (inflight) return inflight;

    const promise = this._doCreate(routingKey, opts);
    this.creating.set(routingKey, promise);
    try {
      return await promise;
    } finally {
      this.creating.delete(routingKey);
    }
  }

  private async _doCreate(routingKey: string, opts: RuntimeCreateOptions): Promise<RuntimeEntry> {
    // Evict LRU if at capacity
    if (this.entries.size >= this.poolConfig.max_directors) {
      await this.evictLRU();
    }

    const label = routingKeyToLabel(routingKey);
    const name = opts.workspaceName ?? routingKey.slice(0, 8);
    const workspaceCwd = getWorkspace(name)?.cwd ?? undefined;
    console.log(`[pool] Creating session bridge for group "${name}" (label=${label}${workspaceCwd ? `, cwd=${workspaceCwd}` : ''})`);

    const bridge = new SessionBridge({
      agents: this.getFreshAgentsConfig(),
      agentsProvider: () => this.getFreshAgentsConfig(),
      config: this.directorConfig,
      agentName: opts.agentName,
      initialSessionId: opts.initialSessionId,
      label,
      isMain: false,
      workspaceName: name,
      workspaceCwd,
      dynamicToolHandler: this.dynamicToolHandler,
    } satisfies SessionBridgeOptions);

    const queue = new MessageQueue(join(getLogDir(), `queue-${label}.log`));

    await bridge.start();
    const activeDirectorAgentName = bridge.getAgentName();

    // Wire events BEFORE bootstrap so response handler is ready
    this.wireEvents(bridge, queue, routingKey, opts.feishuChatId, name);

    const entry: RuntimeEntry = {
      bridge,
      queue,
      routingKey,
      feishuChatId: opts.feishuChatId,
      workspaceName: name,
      lastActiveAt: Date.now(),
      agentName: activeDirectorAgentName,
      messagesSinceFlush: 0,
    };
    this.entries.set(routingKey, entry);
    this.closedEntries.delete(routingKey); // re-activated
    this.persistEntries();

    // Skip bootstrap if resuming an existing session (e.g. after shell restart).
    // The Director already has context from the previous session.
    if (!bridge.hasRestoredSession) {
      const statePath = bridge.getSessionStatePath();
      bridge.bootstrap(statePath).catch(err => {
        console.error(`[pool] Bootstrap failed for "${name}":`, err);
      });
    } else {
      console.log(`[pool] Skipping bootstrap for "${name}" — resumed existing session`);
    }

    return entry;
  }

  /** Send a message to a group Director, managing queue correlation */
  async send(routingKey: string, text: string, messageId: string, options: { webOnly?: boolean; inputAttachments?: DirectorInputAttachment[] } = {}): Promise<void> {
    const entry = this.entries.get(routingKey);
    if (!entry) throw new Error(`No Director for routingKey ${routingKey}`);

    entry.lastActiveAt = Date.now();
    if (entry.bridge.getStatus().pendingCount > 0) {
      entry.bridge.promoteActiveTurnToUser();
      await entry.bridge.send(text, { expectResponse: false, inputAttachments: options.inputAttachments });
      entry.queue.logAction('INSERT_INTO_ACTIVE_TURN', messageId, text.slice(0, 100));
      console.log(`[pool:${entry.workspaceName}] Inserted message into active turn: ${messageId}`);
      return;
    }

    const correlationId = entry.queue.enqueue({
      text,
      messageId,
      chatId: options.webOnly ? 'web-console' : entry.feishuChatId,
      inputAttachments: options.inputAttachments,
    });
    entry.queue.logAction('SEND_TO_DIRECTOR', messageId, `cid=${correlationId} ${text.slice(0, 100)}`);

    try {
      await this.startStreamingReply(entry.queue, correlationId, messageId, routingKey);
      entry.queue.markDispatching(correlationId);
      await entry.bridge.send(text, { correlationId, inputAttachments: options.inputAttachments });
      entry.queue.markDispatched(correlationId);
      await this.startStreamingReply(entry.queue, correlationId, messageId, routingKey);
      entry.messagesSinceFlush++;
      const countKey = `pool:${routingKey}:msgCount`;
      setState(countKey, entry.messagesSinceFlush);
    } catch (err) {
      entry.queue.markDispatched(correlationId);
      entry.queue.resolve(correlationId);
      await this.abortStreamingReply(correlationId, '消息发送失败');
      throw err;
    }
  }

  async abortStreamingReply(correlationId: string, text?: string): Promise<void> {
    const handle = this.streamingReplies.get(correlationId);
    if (!handle) return;
    this.streamingReplies.delete(correlationId);
    this.streamReplyRoutingKeys.delete(correlationId);
    this.deleteStreamSourceMapping(correlationId);
    const cardMessageId = handle.getMessageId?.();
    if (cardMessageId) this.streamCardToCorrelationId.delete(cardMessageId);
    await handle.abort(text).catch((err) => {
      log.debug(`[pool] Streaming reply abort failed: ${(err as Error).message}`);
    });
  }

  private async startStreamingReply(queue: MessageQueue, correlationId: string, messageId: string, routingKey: string): Promise<void> {
    if (!this.messaging.startStreamingReply) return;
    const head = queue.peek();
    if (!head || head.correlationId !== correlationId) return;
    if (head.chatId === 'web-console') return;
    if (head.cancelled) return;
    if (queue.isDispatching(correlationId)) return;
    if (this.streamingReplies.has(correlationId)) return;
    const handle = await this.messaging.startStreamingReply(messageId);
    if (handle) {
      this.streamingReplies.set(correlationId, handle);
      this.streamSourceToCorrelationId.set(messageId, correlationId);
      this.streamReplyRoutingKeys.set(correlationId, routingKey);
      const cardMessageId = handle.getMessageId?.();
      if (cardMessageId) this.streamCardToCorrelationId.set(cardMessageId, correlationId);
    }
  }

  private async startStreamingReplyForHead(queue: MessageQueue, routingKey: string): Promise<void> {
    const item = queue.peek();
    if (!item) return;
    await this.startStreamingReply(queue, item.correlationId, item.messageId, routingKey);
  }

  private appendStreamingReply(queue: MessageQueue, text: string): void {
    const item = queue.peek();
    if (!item) return;
    this.streamingReplies.get(item.correlationId)?.append(text);
  }

  private showToolCallInStreamingReply(queue: MessageQueue, toolName?: string): void {
    const item = queue.peek();
    if (!item) return;
    this.streamingReplies.get(item.correlationId)?.showToolCall?.(toolName);
  }

  private async finishStreamingReply(correlationId: string, text: string): Promise<boolean> {
    const handle = this.streamingReplies.get(correlationId);
    if (!handle) return false;
    this.streamingReplies.delete(correlationId);
    this.streamReplyRoutingKeys.delete(correlationId);
    this.deleteStreamSourceMapping(correlationId);
    const cardMessageId = handle.getMessageId?.();
    if (cardMessageId) this.streamCardToCorrelationId.delete(cardMessageId);
    await handle.final(text);
    return true;
  }

  private abortStreamingReplies(items: QueueItem[], text?: string): void {
    for (const item of items) {
      void this.abortStreamingReply(item.correlationId, text);
    }
  }

  private async startSystemStreamingReply(messageId: string, label: string): Promise<void> {
    if (!this.messaging.startStreamingReply || this.systemStreamingReplies.has(messageId)) return;
    const handle = await this.messaging.startStreamingReply(messageId);
    if (handle) {
      this.systemStreamingReplies.set(messageId, handle);
      this.systemSourceMessageIds.set(messageId, label);
      const cardMessageId = handle.getMessageId?.();
      if (cardMessageId) this.systemCardToMessageId.set(cardMessageId, { label, messageId });
    }
  }

  private appendSystemStreamingReply(messageId: string, text: string): void {
    this.systemStreamingReplies.get(messageId)?.append(text);
  }

  private showSystemToolCall(messageId: string, toolName?: string): void {
    this.systemStreamingReplies.get(messageId)?.showToolCall?.(toolName);
  }

  private async finishSystemStreamingReply(messageId: string, text: string): Promise<boolean> {
    const handle = this.systemStreamingReplies.get(messageId);
    if (!handle) return false;
    this.systemStreamingReplies.delete(messageId);
    this.systemSourceMessageIds.delete(messageId);
    const cardMessageId = handle.getMessageId?.();
    if (cardMessageId) this.systemCardToMessageId.delete(cardMessageId);
    await handle.final(text);
    return true;
  }

  private async abortSystemStreamingReply(messageId: string, text?: string): Promise<void> {
    const handle = this.systemStreamingReplies.get(messageId);
    if (!handle) return;
    this.systemStreamingReplies.delete(messageId);
    this.systemSourceMessageIds.delete(messageId);
    const cardMessageId = handle.getMessageId?.();
    if (cardMessageId) this.systemCardToMessageId.delete(cardMessageId);
    await handle.abort(text).catch((err) => {
      log.debug(`[pool] System streaming reply abort failed: ${(err as Error).message}`);
    });
  }

  async cancelByCardAction(action: CardAction): Promise<boolean> {
    const correlationId = this.streamCardToCorrelationId.get(action.messageId)
      ?? (action.sourceMessageId ? this.streamSourceToCorrelationId.get(action.sourceMessageId) : undefined);
    if (correlationId) {
      const routingKey = this.streamReplyRoutingKeys.get(correlationId);
      const entry = routingKey ? this.entries.get(routingKey) : undefined;
      const cancelled = entry?.queue.cancel(correlationId);
      await this.abortStreamingReply(correlationId, '已取消');
      if (!entry || !cancelled) return false;
      console.log(`[pool:${entry.workspaceName}] Feishu card cancel: cancelling ${cancelled.messageId} (cid=${correlationId})`);
      await entry.bridge.interrupt();
      return true;
    }

    const systemMeta = this.systemCardToMessageId.get(action.messageId);
    if (systemMeta) {
      this.cancelledSystemMessageIds.add(systemMeta.messageId);
      await this.abortSystemStreamingReply(systemMeta.messageId, '已取消');
      const entry = this.findByLabel(systemMeta.label);
      console.log(`[pool:${systemMeta.label}] Feishu card cancel: cancelling system reply ${systemMeta.messageId}`);
      await entry?.bridge.interrupt();
      return true;
    }

    if (action.sourceMessageId) {
      const label = this.systemSourceMessageIds.get(action.sourceMessageId);
      if (label) {
        this.cancelledSystemMessageIds.add(action.sourceMessageId);
        await this.abortSystemStreamingReply(action.sourceMessageId, '已取消');
        const entry = this.findByLabel(label);
        console.log(`[pool:${label}] Feishu card cancel: cancelling system reply ${action.sourceMessageId}`);
        await entry?.bridge.interrupt();
        return true;
      }
    }

    return false;
  }

  private deleteStreamSourceMapping(correlationId: string): void {
    for (const [sourceMessageId, sourceCorrelationId] of this.streamSourceToCorrelationId.entries()) {
      if (sourceCorrelationId === correlationId) this.streamSourceToCorrelationId.delete(sourceMessageId);
    }
  }

  /** Notify a specific pool Director that a task has completed.
   *  If the Director is dead, revive it first.
   *  @returns the feishuChatId for sending the notification message */
  async notifyTaskDone(label: string, taskId: string, success: boolean, notifyMsgId?: string): Promise<void> {
    let entry = this.findByLabel(label);

    if (!entry) {
      console.warn(`[pool] Director ${label} not found for task callback, cannot revive (routing context lost)`);
      // Fallback: notify main Director
      await this.mainBridge.notifyTaskDone(taskId, success, notifyMsgId);
      return;
    }

    // Check if Director is alive, revive if dead
    if (!entry.bridge.getStatus().alive) {
      console.log(`[pool] Reviving dead Director "${entry.workspaceName}" (label=${label}) for task callback`);
      // Re-create the Director
      const routingKey = entry.routingKey;
      const workspaceName = entry.workspaceName;
      const feishuChatId = entry.feishuChatId;
      // Remove stale entry
      this.entries.delete(routingKey);
      // Create new one
      const newEntry = await this.getOrCreate(routingKey, {
        workspaceName,
        feishuChatId,
        agentName: entry.agentName,
      });
      entry = newEntry;
    }

    if (notifyMsgId && entry.feishuChatId !== 'web-console') {
      await this.startSystemStreamingReply(notifyMsgId, entry.bridge.label);
    }
    await entry.bridge.notifyTaskDone(taskId, success, notifyMsgId);
  }

  /** Get the messageId of the currently-processing user message for a Director by label */
  getProcessingMessageIdByLabel(label: string): string | null {
    const entry = this.findByLabel(label);
    const item = entry?.queue.peek();
    return item?.messageId ?? null;
  }

  enqueueAttachmentForHeadByLabel(label: string, attachment: PendingAttachment): QueueItem | null {
    const entry = this.findByLabel(label);
    return entry?.queue.addPendingAttachmentToOldest(attachment) ?? null;
  }

  /** Cancel a queued or currently-processing message for a Director by label. */
  async cancelQueuedByLabel(label: string, correlationId: string): Promise<{
    item: QueueItem;
    interrupted: boolean;
    label: string;
    workspaceName: string;
  } | null> {
    const entry = this.findByLabel(label);
    if (!entry) return null;
    const headId = entry.queue.peek()?.correlationId;
    const item = entry.queue.cancel(correlationId);
    if (!item) return null;
    await this.abortStreamingReply(correlationId, '已取消');
    const interrupted = headId === correlationId;
    if (interrupted) await entry.bridge.interrupt();
    return { item, interrupted, label: entry.bridge.label, workspaceName: entry.workspaceName };
  }

  /** Get the feishuChatId for a Director by label (for sending notification messages) */
  getChatIdByLabel(label: string): string | null {
    const entry = this.findByLabel(label);
    return entry?.feishuChatId ?? null;
  }

  getAgentName(routingKey: string): string | undefined {
    return this.entries.get(routingKey)?.agentName ?? this.closedEntries.get(routingKey)?.agentName;
  }

  async switchAgentByLabel(label: string, agentName: string): Promise<RuntimeEntry> {
    const entry = this.findByLabel(label);
    if (!entry) throw new Error(`Director label not found: ${label}`);
    const currentAgentName = entry.bridge.getAgentName();
    if (currentAgentName !== agentName) {
      const switched = await entry.bridge.switchAgent(agentName);
      if (!switched) throw new Error(`failed to switch Director ${label} to ${agentName}`);
    }
    entry.agentName = entry.bridge.getAgentName();
    entry.lastActiveAt = Date.now();
    this.closedEntries.delete(entry.routingKey);
    this.persistEntries();
    return entry;
  }

  async switchPersonaByLabel(label: string, roleName: string): Promise<RuntimeEntry> {
    const entry = this.findByLabel(label);
    if (!entry) throw new Error(`Director label not found: ${label}`);
    const switched = await entry.bridge.switchPersona(roleName);
    if (!switched) throw new Error(`failed to switch Director ${label} to persona ${roleName}`);
    entry.lastActiveAt = Date.now();
    this.closedEntries.delete(entry.routingKey);
    this.persistEntries();
    return entry;
  }

  async flushByLabel(label: string): Promise<boolean> {
    const entry = this.requireByLabel(label);
    const success = await entry.bridge.flush();
    if (success) {
      entry.messagesSinceFlush = 0;
      entry.lastActiveAt = Date.now();
      setState(`pool:${entry.routingKey}:msgCount`, 0);
      this.persistEntries();
    }
    return success;
  }

  async clearContextByLabel(label: string): Promise<boolean> {
    const entry = this.requireByLabel(label);
    const success = await entry.bridge.clearContext();
    if (success) {
      entry.lastActiveAt = Date.now();
      this.persistEntries();
    }
    return success;
  }

  async restartByLabel(label: string): Promise<void> {
    const entry = this.requireByLabel(label);
    await entry.bridge.restartProcess();
    entry.lastActiveAt = Date.now();
    this.persistEntries();
  }

  async interruptOldestByLabel(label: string): Promise<QueueItem | undefined> {
    const entry = this.requireByLabel(label);
    const cancelled = entry.queue.cancelOldest();
    if (cancelled) {
      await entry.bridge.interrupt();
      entry.lastActiveAt = Date.now();
      this.persistEntries();
    }
    return cancelled;
  }

  async detachByLabel(label: string): Promise<RuntimeEntry> {
    const entry = this.requireByLabel(label);
    console.log(`[pool] Detaching Director for group "${entry.workspaceName}" (label=${label})`);
    entry.queue.clearAll();
    await entry.bridge.detach();
    this.moveToClosedEntries(entry.routingKey, entry, 'detached');
    this.entries.delete(entry.routingKey);
    this.persistEntries();
    return entry;
  }

  async setAgent(routingKey: string, opts: RuntimeCreateOptions & { agentName: string }): Promise<RuntimeEntry> {
    const existing = this.entries.get(routingKey);
    if (existing) {
      if (opts.workspaceName && opts.workspaceName !== existing.workspaceName) {
        existing.workspaceName = opts.workspaceName;
      }
      existing.feishuChatId = opts.feishuChatId;
      existing.lastActiveAt = Date.now();
      const currentAgentName = existing.bridge.getAgentName();
      if (currentAgentName === opts.agentName) {
        existing.agentName = currentAgentName;
        this.persistEntries();
        return existing;
      }
      const switched = await existing.bridge.switchAgent(opts.agentName);
      if (!switched) {
        throw new Error(`failed to switch Director for ${routingKey} to ${opts.agentName}`);
      }
      existing.agentName = existing.bridge.getAgentName();
      existing.lastActiveAt = Date.now();
      this.closedEntries.delete(routingKey);
      this.persistEntries();
      return existing;
    }

    const closed = this.closedEntries.get(routingKey);
    if (closed) {
      if (opts.workspaceName) closed.workspaceName = opts.workspaceName;
      closed.feishuChatId = opts.feishuChatId;
      closed.lastActiveAt = Date.now();
      closed.agentName = opts.agentName;
      setState('pool:closed', [...this.closedEntries.values()]);
    }

    return this.getOrCreate(routingKey, opts);
  }

  /** Shutdown a specific group Director */
  async shutdown(routingKey: string): Promise<void> {
    const entry = this.entries.get(routingKey);
    if (!entry) return;

    console.log(`[pool] Shutting down Director for group "${entry.workspaceName}"`);
    this.moveToClosedEntries(routingKey, entry);
    this.entries.delete(routingKey);
    this.persistEntries();
    await entry.bridge.shutdown();
  }

  /** Shutdown all non-main Directors */
  async shutdownAll(): Promise<void> {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    const keys = [...this.entries.keys()];
    for (const key of keys) {
      await this.shutdown(key);
    }
    console.log(`[pool] All ${keys.length} group Director(s) shut down`);
  }

  /** Flush all pool Directors: checkpoint → clearSession → restart → bootstrap.
   *  Each Director gets a new session with latest config/skills. */
  async flushAll(): Promise<void> {
    const keys = [...this.entries.keys()];
    for (const key of keys) {
      const entry = this.entries.get(key);
      if (entry) {
        const countKey = `pool:${key}:msgCount`;
        const msgCount = getState<number>(countKey) ?? 0;
        if (msgCount < MIN_MESSAGES_FOR_FLUSH) {
          console.log(`[pool] Skipping flush for "${entry.workspaceName}" (only ${msgCount} messages since last flush)`);
          continue;
        }
        console.log(`[pool] Flushing Director for group "${entry.workspaceName}" (${msgCount} messages)`);
        try {
          await entry.bridge.flush();
          setState(countKey, 0);
          entry.messagesSinceFlush = 0;
        } catch (err) {
          console.error(`[pool] Failed to flush Director "${entry.workspaceName}":`, err);
        }
      }
    }
    console.log(`[pool] Flushed group Director(s)`);
  }

  /** Detach from all pool Directors without killing them (for shell restart).
   *  Processes become orphans; restoreEntries() will reconnect on next startup. */
  async detachAll(): Promise<void> {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    const keys = [...this.entries.keys()];
    // Detach all Directors in parallel for faster shutdown
    await Promise.allSettled(keys.map(async (key) => {
      const entry = this.entries.get(key);
      if (entry) {
        console.log(`[pool] Detaching Director for group "${entry.workspaceName}" (keeping alive for reconnect)`);
        await entry.bridge.detach();
      }
    }));
    // Keep entries in persisted state so restoreEntries() can reconnect
    console.log(`[pool] Detached ${keys.length} group Director(s) — orphans preserved for reconnect`);
  }

  /** Get status of all pool entries (active + closed) for dashboard */
  getRuntimeStatus(): Array<{
    routingKey: string;
    workspaceName: string;
    label: string;
    lastActiveAt: number;
    directorStatus: ReturnType<SessionBridge['getStatus']> | null;
    agentName?: string;
    personaRole?: string | null;
    queueLength: number;
    queue: ReturnType<MessageQueue['getSnapshot']>;
    closed?: boolean;
    closedAt?: number;
    closedReason?: ClosedRuntimeEntry['closedReason'];
  }> {
    const active = [...this.entries.values()].map((entry) => ({
      routingKey: entry.routingKey,
      workspaceName: entry.workspaceName,
      label: entry.bridge.label,
      lastActiveAt: entry.lastActiveAt,
      directorStatus: entry.bridge.getStatus(),
      queueLength: entry.queue.length,
      queue: entry.queue.getSnapshot(),
      agentName: entry.agentName,
      personaRole: entry.bridge.getPersonaRole(),
    }));
    const closed = [...this.closedEntries.values()].map((entry) => ({
      routingKey: entry.routingKey,
      workspaceName: entry.workspaceName,
      label: entry.label,
      lastActiveAt: entry.lastActiveAt,
      directorStatus: null,
      queueLength: 0,
      queue: [],
      closed: true as const,
      closedAt: entry.closedAt,
      closedReason: entry.closedReason ?? 'closed',
      agentName: entry.agentName,
      personaRole: null,
    }));
    return [...active, ...closed];
  }

  /** Move an active entry to the closed list (max 50, evict oldest) */
  private moveToClosedEntries(routingKey: string, entry: RuntimeEntry, reason: ClosedRuntimeEntry['closedReason'] = 'shutdown'): void {
    this.closedEntries.set(routingKey, {
      routingKey,
      feishuChatId: entry.feishuChatId,
      workspaceName: entry.workspaceName,
      label: entry.bridge.label,
      lastActiveAt: entry.lastActiveAt,
      closedAt: Date.now(),
      closedReason: reason,
      agentName: entry.agentName,
    });
    // Evict oldest if over limit
    while (this.closedEntries.size > 50) {
      const oldest = this.closedEntries.keys().next().value!;
      this.closedEntries.delete(oldest);
    }
    setState('pool:closed', [...this.closedEntries.values()]);
  }

  private getFreshAgentsConfig(): Config['agents'] {
    if (!this.configPath) return this.agentsConfig;
    try {
      return loadConfig(this.configPath).agents;
    } catch {
      return this.agentsConfig;
    }
  }

  /** Persist pool entries to SQLite for crash recovery */
  private persistEntries(): void {
    const data: PersistedRuntimeEntry[] = [...this.entries.values()].map(e => ({
      routingKey: e.routingKey,
      feishuChatId: e.feishuChatId,
      workspaceName: e.workspaceName,
      label: e.bridge.label,
      lastActiveAt: e.lastActiveAt,
      agentName: e.agentName,
    }));
    setState('pool:entries', data);
  }

  /** Restore pool entries from SQLite after Shell restart.
   *  For each persisted entry, check if the Director process is still alive:
   *  - alive → reconnect (reuse process + session)
   *  - dead → clean up pipe directory */
  async restoreEntries(): Promise<void> {
    const saved = getState<PersistedRuntimeEntry[]>('pool:entries');
    if (!saved || saved.length === 0) return;

    // [MIGRATION] 0ad1d3f renamed groupName→workspaceName, directorAgentName→agentName.
    // Persisted data may still use old field names, or workspaceName may be missing entirely
    // (written as undefined after a prior restore from legacy data). Migrate in-place.
    // Safe to remove once all running instances have restarted at least once after 2026-06-10.
    for (const item of saved) {
      if (!item.workspaceName && item.groupName) {
        item.workspaceName = item.groupName;
        delete item.groupName;
      }
      // workspaceName still missing — derive from routingKey (e.g. "web-workspace:p.sh维修" → "p.sh维修")
      if (!item.workspaceName) {
        item.workspaceName = item.routingKey.startsWith('web-workspace:')
          ? item.routingKey.slice('web-workspace:'.length)
          : item.routingKey.startsWith('web-session:')
            ? item.routingKey.slice('web-session:'.length)
            : item.routingKey.slice(0, 8);
      }
      if (!item.agentName && item.directorAgentName) {
        item.agentName = item.directorAgentName;
        delete item.directorAgentName;
      }
    }

    const pipeBaseDir = this.directorConfig.pipe_dir;
    let restored = 0;

    for (const item of saved) {
      const workspaceCwd = getWorkspace(item.workspaceName)?.cwd ?? undefined;
      const bridge = new SessionBridge({
        agents: this.getFreshAgentsConfig(),
        agentsProvider: () => this.getFreshAgentsConfig(),
        config: this.directorConfig,
        agentName: item.agentName,
        label: item.label,
        isMain: false,
        workspaceName: item.workspaceName,
        workspaceCwd,
        dynamicToolHandler: this.dynamicToolHandler,
      } satisfies SessionBridgeOptions);

      const queue = new MessageQueue(`logs/queue-${item.label}.log`);

      if (!isCodexFamily(bridge.getDirectorAgentType())) {
        const pipeDir = join(pipeBaseDir, item.label);
        const pidFile = join(pipeDir, 'director.pid');

        // Claude-backed Directors are long-lived processes, so we only reconnect if the orphan is still alive.
        const proc = new ClaudeProcess({ pipeDir, pidFile, label: item.label });
        if (!proc.isAlive()) {
          console.log(`[pool] Orphan "${item.workspaceName}" (label=${item.label}) is dead, cleaning up`);
          proc.cleanPipes();
          continue;
        }

        console.log(`[pool] Reconnecting to orphan "${item.workspaceName}" (label=${item.label}, pid=${proc.getPid()})`);

        try {
          await bridge.start(); // start() detects alive process → reconnect path
        } catch (err) {
          console.error(`[pool] Failed to reconnect "${item.workspaceName}":`, err);
          // Kill the orphan — we can't talk to it
          proc.kill('SIGTERM');
          proc.cleanPipes();
          continue;
        }
      } else {
        // Codex-family Directors restore from persisted session metadata.
        // App Server starts a fresh stdio process for the saved thread; turn-based spawns `codex exec` on demand.
        console.log(`[pool] Restoring Codex Director for "${item.workspaceName}" (label=${item.label})`);
        try {
          await bridge.start();
        } catch (err) {
          console.error(`[pool] Failed to restore Codex Director "${item.workspaceName}":`, err);
          continue;
        }
      }

      this.wireEvents(bridge, queue, item.routingKey, item.feishuChatId, item.workspaceName);

      const entry: RuntimeEntry = {
        bridge,
        queue,
        routingKey: item.routingKey,
        feishuChatId: item.feishuChatId,
        workspaceName: item.workspaceName,
        lastActiveAt: item.lastActiveAt,
        agentName: bridge.getAgentName(),
        messagesSinceFlush: getState<number>(`pool:${item.routingKey}:msgCount`) ?? 0,
      };
      this.entries.set(item.routingKey, entry);
      this.closedEntries.delete(item.routingKey); // re-activated, remove stale closed entry
      restored++;
    }

    // Update persisted state (remove dead entries)
    this.persistEntries();
    console.log(`[pool] Restored ${restored}/${saved.length} pool Director(s)`);
  }

  /** Kill orphan Director processes not tracked in the pool.
   *  Scans pipe directories for alive processes that aren't in `entries`. */
  async killUnknownOrphans(): Promise<void> {
    const pipeBaseDir = this.directorConfig.pipe_dir;
    const knownLabels = new Set([...this.entries.values()].map(e => e.bridge.label));
    // Also exclude main Director's pipe dir
    knownLabels.add('');  // pipeBaseDir itself has director.pid

    let dirNames: string[];
    try {
      dirNames = readdirSync(pipeBaseDir)
        .map(String)
        .filter(name => {
          try { return existsSync(join(pipeBaseDir, name, 'director.pid')); } catch { return false; }
        });
    } catch {
      return; // pipe dir doesn't exist yet
    }

    for (const name of dirNames) {
      if (knownLabels.has(name)) continue;

      const pipeDir = join(pipeBaseDir, name);
      const pidFile = join(pipeDir, 'director.pid');

      const proc = new ClaudeProcess({ pipeDir, pidFile, label: name });
      if (proc.isAlive()) {
        console.log(`[pool] Killing unknown orphan ${name} (pid=${proc.getPid()})`);
        proc.kill('SIGTERM');
      }
      proc.cleanPipes();
    }
  }

  /** Reap idle Directors that have exceeded idle_timeout_minutes.
   *  Keeps at least 3 Directors alive regardless of idle time. */
  private reapIdle(): void {
    if (this.entries.size <= 3) return;

    const timeoutMs = this.poolConfig.idle_timeout_minutes * 60_000;
    const now = Date.now();

    for (const [routingKey, entry] of this.entries) {
      if (this.entries.size <= 3) break;
      // Skip Directors with pending messages
      if (entry.queue.length > 0) continue;

      if (now - entry.lastActiveAt > timeoutMs) {
        console.log(`[pool] Reaping idle Director for group "${entry.workspaceName}" (idle ${Math.floor((now - entry.lastActiveAt) / 1000)}s)`);
        this.shutdown(routingKey).catch((err) => {
          console.error(`[pool] Failed to reap idle Director "${entry.workspaceName}":`, err);
        });
      }
    }
  }

  /** Wire SessionBridge events for a group chat */
  private wireEvents(bridge: SessionBridge, queue: MessageQueue, routingKey: string, feishuChatId: string, workspaceName: string): void {
    const isWeb = routingKey.startsWith('web-') || feishuChatId === 'web-console';

    // response → resolve oldest queue item → reply to feishu (or web)
    bridge.on('response', async (reply: string, durationMs?: number) => {
      const item = queue.resolveOldest();
      if (!item) {
        console.warn(`[pool:${workspaceName}] Got response but queue is empty`);
        return;
      }

      const elapsedMs = (typeof durationMs === 'number' && durationMs > 0)
        ? durationMs
        : Date.now() - item.timestamp;
      const elapsedSec = (elapsedMs / 1000).toFixed(1);
      const displayReply = reply.trim() || '仅执行工具调用，无文本输出';
      const replyWithTiming = `${displayReply}\n\n(耗时 ${elapsedSec}s)`;

      const webOnly = isWeb || item.chatId === 'web-console';
      if (webOnly) {
        this.emit('web-reply', bridge.label, item.messageId, replyWithTiming);
        queue.logAction('WEB_REPLY_SENT', item.messageId, `cid=${item.correlationId} elapsed=${elapsedSec}s`);
        console.log(`[pool:${workspaceName}] Web replied to ${item.messageId} (${elapsedSec}s)`);
        return;
      }

      try {
        const streamed = await this.finishStreamingReply(item.correlationId, replyWithTiming);
        if (!streamed) {
          await this.messaging.reply(item.messageId, replyWithTiming);
        }
        queue.logAction('REPLY_SENT', item.messageId, `cid=${item.correlationId} elapsed=${elapsedSec}s`);
        console.log(`[pool:${workspaceName}] Replied to ${item.messageId} (${elapsedSec}s)`);
        this.emit('web-reply', bridge.label, item.messageId, replyWithTiming);
      } catch (err) {
        this.streamingReplies.delete(item.correlationId);
        queue.logAction('ERROR', item.messageId, `cid=${item.correlationId} ${String(err)}`);
        console.error(`[pool:${workspaceName}] reply failed, trying sendMessage as fallback:`, err);
        await this.messaging.sendMessage(feishuChatId, replyWithTiming).catch((e) => {
          console.error(`[pool:${workspaceName}] sendMessage fallback also failed:`, e);
        });
        this.emit('web-reply', bridge.label, item.messageId, replyWithTiming);
      }
      await this.sendQueuedAttachments(item, queue, feishuChatId, webOnly, workspaceName);
      await this.startStreamingReplyForHead(queue, routingKey);
    });

    // system-response → reply to task notification message (web sessions: forward via WebSocket)
    bridge.on('system-response', async (reply: string, replyToMessageId: string) => {
      if (this.cancelledSystemMessageIds.delete(replyToMessageId)) return;
      this.emit('web-reply', bridge.label, replyToMessageId, reply);
      if (isWeb) {
        return;
      }
      try {
        const streamed = await this.finishSystemStreamingReply(replyToMessageId, reply);
        if (!streamed) {
          await this.messaging.reply(replyToMessageId, reply);
        }
        log.debug(`[pool:${workspaceName}] System response replied to ${replyToMessageId}`);
      } catch (err) {
        console.warn(`[pool:${workspaceName}] Failed to reply system response:`, err);
      }
    });

    bridge.on('system-chunk', (text: string, replyToMessageId: string) => {
      this.emit('chunk', bridge.label, text);
      if (!isWeb) this.appendSystemStreamingReply(replyToMessageId, text);
    });

    bridge.on('turn-event', (event: AssistantTurnEvent) => {
      this.emit('turn-event', bridge.label, event);
    });

    bridge.on('input-message', (text: string) => {
      this.emit('input-message', bridge.label, text);
    });

    bridge.on('system-tool-call', (replyToMessageId: string, toolName?: string, tool?: DirectorToolCall) => {
      if (!isWeb) this.showSystemToolCall(replyToMessageId, toolName);
      this.emit('tool-call', bridge.label, toolName, tool);
    });

    bridge.on('system-stream-abort', (replyToMessageId: string, text?: string) => {
      if (!isWeb) void this.abortSystemStreamingReply(replyToMessageId, text);
    });

    // close → remove from pool
    bridge.on('close', () => {
      console.log(`[pool] Session bridge for group "${workspaceName}" closed, removing from pool`);
      const orphaned = queue.clearAll();
      if (orphaned.length > 0) {
        this.abortStreamingReplies(orphaned, 'Director 已关闭，本轮回复已中断');
      }
      const entry = this.entries.get(routingKey);
      if (entry) this.moveToClosedEntries(routingKey, entry, 'closed');
      this.entries.delete(routingKey);
      this.persistEntries();
    });

    // alert → forward to group chat or web
    bridge.on('alert', (message: string) => {
      if (isWeb) {
        this.emit('web-alert', bridge.label, message);
        return;
      }
      this.messaging.sendMessage(feishuChatId, message).catch((err) => {
        console.warn(`[pool:${workspaceName}] Failed to send alert:`, err);
      });
    });

    // cron-response → forward Director's cron message response to the group chat (or web)
    bridge.on('cron-response', (reply: string) => {
      if (isWeb) {
        this.emit('web-alert', bridge.label, reply);
        return;
      }
      this.messaging.sendMessage(feishuChatId, reply).catch((err) => {
        console.warn(`[pool:${workspaceName}] Failed to forward cron response:`, err);
      });
    });

    // auto-flush-complete → notify group chat or web
    bridge.on('auto-flush-complete', () => {
      if (isWeb) {
        this.emit('web-alert', bridge.label, '🔄 上下文已自动刷新');
        return;
      }
      this.messaging.sendMessage(feishuChatId, '🔄 上下文已自动刷新').catch((err) => {
        console.warn(`[pool:${workspaceName}] Failed to send flush notification:`, err);
      });
    });

    // flush-drain-complete → clear orphaned queue items
    bridge.on('flush-drain-complete', () => {
      const orphaned = queue.clearAll();
      if (orphaned.length > 0) {
        this.abortStreamingReplies(orphaned, '上下文刷新中断了本轮回复');
        console.log(`[pool:${workspaceName}] Cleared ${orphaned.length} orphaned queue items after flush drain`);
      }
    });

    bridge.on('message-steered', (correlationId?: string) => {
      const item = correlationId ? queue.resolve(correlationId) : queue.resolveOldest();
      if (item) {
        queue.logAction('STEERED', item.messageId, `cid=${item.correlationId}`);
        void this.abortStreamingReply(item.correlationId, '已并入上一轮处理');
      }
    });

    // queue-desync → clear orphaned queue items after Director crash
    bridge.on('queue-desync', () => {
      const orphans = queue.clearAll();
      if (orphans.length > 0) {
        this.abortStreamingReplies(orphans, 'Director 已重启，本轮回复已中断');
        console.warn(`[pool:${workspaceName}] Cleared ${orphans.length} orphaned queue items after crash`);
      }
    });

    // chunk / stream-abort → re-emit on pool level for console broadcast
    bridge.on('chunk', (text: string) => {
      if (!isWeb) this.appendStreamingReply(queue, text);
      this.emit('chunk', bridge.label, text);
    });
    bridge.on('tool-call', (toolName?: string, tool?: DirectorToolCall) => {
      if (!isWeb) this.showToolCallInStreamingReply(queue, toolName);
      this.emit('tool-call', bridge.label, toolName, tool);
    });
    bridge.on('stream-abort', () => {
      const item = queue.peek();
      if (item) void this.abortStreamingReply(item.correlationId, 'Director 流式输出已中断');
      this.emit('stream-abort', bridge.label);
    });
  }

  private async sendQueuedAttachments(item: QueueItem, queue: MessageQueue, chatId: string, webOnly: boolean, workspaceName: string): Promise<void> {
    const attachments = item.pendingAttachments ?? [];
    if (attachments.length === 0) return;
    if (webOnly) {
      console.warn(`[pool:${workspaceName}] Skipping ${attachments.length} queued attachment(s) for web-only chat`);
      return;
    }

    const imageExts = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.ico']);
    for (const attachment of attachments) {
      const isImage = imageExts.has(extname(attachment.path).toLowerCase());
      try {
        try {
          if (isImage) await this.messaging.uploadAndReplyImage(item.messageId, attachment.path);
          else await this.messaging.uploadAndReplyFile(item.messageId, attachment.path);
        } catch (err) {
          console.warn(`[pool:${workspaceName}] queued attachment reply failed, sending as new message instead: ${String(err)}`);
          if (isImage) await this.messaging.uploadAndSendImage(chatId, attachment.path);
          else await this.messaging.uploadAndSendFile(chatId, attachment.path);
        }
        queue.logAction('ATTACHMENT_SENT', item.messageId, `cid=${item.correlationId} path=${attachment.path}`);
      } catch (err) {
        queue.logAction('ATTACHMENT_ERROR', item.messageId, `cid=${item.correlationId} path=${attachment.path} ${String(err)}`);
        console.error(`[pool:${workspaceName}] queued attachment send failed:`, err);
      }
    }
  }

  /** Evict the least recently used group Director (skip Directors with pending messages) */
  private async evictLRU(): Promise<void> {
    let lruKey: string | null = null;
    let lruTime = Infinity;

    for (const [routingKey, entry] of this.entries) {
      // Skip Directors that are still processing messages
      if (entry.queue.length > 0) continue;
      if (entry.lastActiveAt < lruTime) {
        lruTime = entry.lastActiveAt;
        lruKey = routingKey;
      }
    }

    if (lruKey) {
      const entry = this.entries.get(lruKey)!;
      console.log(`[pool] Evicting LRU Director for group "${entry.workspaceName}" (idle ${Math.floor((Date.now() - lruTime) / 1000)}s)`);
      await this.shutdown(lruKey);
    } else {
      // All Directors have pending messages — cannot evict safely
      console.warn(`[pool] All ${this.entries.size} Directors are busy, cannot evict`);
      throw new Error('所有会话都在忙碌中，系统繁忙，请稍后重试');
    }
  }
}

/** Convert routingKey to a short, filesystem-safe label */
function routingKeyToLabel(routingKey: string): string {
  return createHash('sha256').update(routingKey).digest('hex').slice(0, 8);
}
