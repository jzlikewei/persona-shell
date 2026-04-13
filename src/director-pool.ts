import { createHash } from 'crypto';
import { EventEmitter } from 'events';
import { SessionBridge, type SessionBridgeOptions } from './session-bridge.js';
import { MessageQueue, type QueueItem } from './queue.js';
import type { Config } from './config.js';
import type { MessagingClient } from './messaging.js';
import { log } from './logger.js';

export interface PoolConfig {
  max_directors: number;
  idle_timeout_minutes: number;
  small_group_threshold: number;
}

export interface PoolEntry {
  bridge: SessionBridge;
  queue: MessageQueue;
  routingKey: string;       // Map key（chatId 或 threadId）
  feishuChatId: string;     // 实际的飞书 chatId（oc_xxx），用于 sendMessage
  groupName: string;
  lastActiveAt: number;
}

/** 管理多个 Director 会话实例的生命周期。
 *
 *  命名说明："DirectorPool" 是领域概念（管理多个 Director 角色的会话），
 *  底层实现使用 SessionBridge。保留 "Director" 命名以对齐架构文档和用户心智模型。 */
export class DirectorPool extends EventEmitter {
  private entries: Map<string, PoolEntry> = new Map();
  private creating: Map<string, Promise<PoolEntry>> = new Map();
  private mainBridge: SessionBridge;
  private poolConfig: PoolConfig;
  private directorConfig: Config['director'];
  private messaging: MessagingClient;
  private idleTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    mainBridge: SessionBridge,
    poolConfig: PoolConfig,
    directorConfig: Config['director'],
    messaging: MessagingClient,
  ) {
    super();
    this.mainBridge = mainBridge;
    this.poolConfig = poolConfig;
    this.directorConfig = directorConfig;
    this.messaging = messaging;

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
  get(routingKey: string): PoolEntry | undefined {
    return this.entries.get(routingKey);
  }

  /** Find a pool entry by Director label (for task callback routing) */
  findByLabel(label: string): PoolEntry | undefined {
    for (const entry of this.entries.values()) {
      if (entry.bridge.label === label) return entry;
    }
    return undefined;
  }

  /** Number of active group Directors */
  get size(): number {
    return this.entries.size;
  }

  /** Get or create a Director for a group chat.
   *  @param routingKey — Map key (chatId for regular groups, threadId for topic groups)
   *  @param opts — group metadata for creation */
  async getOrCreate(routingKey: string, opts: { groupName?: string; feishuChatId: string }): Promise<PoolEntry> {
    const existing = this.entries.get(routingKey);
    if (existing) {
      existing.lastActiveAt = Date.now();
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

  private async _doCreate(routingKey: string, opts: { groupName?: string; feishuChatId: string }): Promise<PoolEntry> {
    // Evict LRU if at capacity
    if (this.entries.size >= this.poolConfig.max_directors) {
      await this.evictLRU();
    }

    const label = routingKeyToLabel(routingKey);
    const name = opts.groupName ?? routingKey.slice(0, 8);
    console.log(`[pool] Creating session bridge for group "${name}" (label=${label})`);

    const bridge = new SessionBridge({
      config: this.directorConfig,
      label,
      isMain: false,
      groupName: name,
    } satisfies SessionBridgeOptions);

    const queue = new MessageQueue(`logs/queue-${label}.log`);

    await bridge.start();

    // Wire events BEFORE bootstrap so response handler is ready
    this.wireEvents(bridge, queue, routingKey, opts.feishuChatId, name);

    const entry: PoolEntry = {
      bridge,
      queue,
      routingKey,
      feishuChatId: opts.feishuChatId,
      groupName: name,
      lastActiveAt: Date.now(),
    };
    this.entries.set(routingKey, entry);

    // Await bootstrap completion — ensures user messages sent after getOrCreate()
    // won't be merged into the bootstrap turn by Claude Code
    await bridge.bootstrap();

    return entry;
  }

  /** Send a message to a group Director, managing queue correlation */
  async send(routingKey: string, text: string, messageId: string): Promise<void> {
    const entry = this.entries.get(routingKey);
    if (!entry) throw new Error(`No Director for routingKey ${routingKey}`);

    entry.lastActiveAt = Date.now();
    const correlationId = entry.queue.enqueue({ text, messageId, chatId: entry.feishuChatId });
    entry.queue.logAction('SEND_TO_DIRECTOR', messageId, `cid=${correlationId} ${text.slice(0, 100)}`);

    try {
      await entry.bridge.send(text);
    } catch (err) {
      entry.queue.resolve(correlationId);
      throw err;
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
      console.log(`[pool] Reviving dead Director "${entry.groupName}" (label=${label}) for task callback`);
      // Re-create the Director
      const routingKey = entry.routingKey;
      const groupName = entry.groupName;
      const feishuChatId = entry.feishuChatId;
      // Remove stale entry
      this.entries.delete(routingKey);
      // Create new one
      const newEntry = await this.getOrCreate(routingKey, { groupName, feishuChatId });
      entry = newEntry;
    }

    await entry.bridge.notifyTaskDone(taskId, success, notifyMsgId);
  }

  /** Get the feishuChatId for a Director by label (for sending notification messages) */
  getChatIdByLabel(label: string): string | null {
    const entry = this.findByLabel(label);
    return entry?.feishuChatId ?? null;
  }

  /** Shutdown a specific group Director */
  async shutdown(routingKey: string): Promise<void> {
    const entry = this.entries.get(routingKey);
    if (!entry) return;

    console.log(`[pool] Shutting down Director for group "${entry.groupName}"`);
    this.entries.delete(routingKey);
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

  /** Get status of all pool entries for dashboard */
  getPoolStatus(): Array<{
    routingKey: string;
    groupName: string;
    label: string;
    lastActiveAt: number;
    directorStatus: ReturnType<SessionBridge['getStatus']>;
    queueLength: number;
  }> {
    return [...this.entries.values()].map((entry) => ({
      routingKey: entry.routingKey,
      groupName: entry.groupName,
      label: entry.bridge.label,
      lastActiveAt: entry.lastActiveAt,
      directorStatus: entry.bridge.getStatus(),
      queueLength: entry.queue.length,
    }));
  }

  /** Reap idle Directors that have exceeded idle_timeout_minutes */
  private reapIdle(): void {
    const timeoutMs = this.poolConfig.idle_timeout_minutes * 60_000;
    const now = Date.now();

    for (const [routingKey, entry] of this.entries) {
      // Skip Directors with pending messages
      if (entry.queue.length > 0) continue;

      if (now - entry.lastActiveAt > timeoutMs) {
        console.log(`[pool] Reaping idle Director for group "${entry.groupName}" (idle ${Math.floor((now - entry.lastActiveAt) / 1000)}s)`);
        this.shutdown(routingKey).catch((err) => {
          console.error(`[pool] Failed to reap idle Director "${entry.groupName}":`, err);
        });
      }
    }
  }

  /** Wire SessionBridge events for a group chat */
  private wireEvents(bridge: SessionBridge, queue: MessageQueue, routingKey: string, feishuChatId: string, groupName: string): void {
    // response → resolve oldest queue item → reply to feishu
    bridge.on('response', async (reply: string, durationMs?: number) => {
      const item = queue.resolveOldest();
      if (!item) {
        console.warn(`[pool:${groupName}] Got response but queue is empty`);
        return;
      }

      const elapsedMs = (typeof durationMs === 'number' && durationMs > 0)
        ? durationMs
        : Date.now() - item.timestamp;
      const elapsedSec = (elapsedMs / 1000).toFixed(1);
      const replyWithTiming = `${reply}\n\n(耗时 ${elapsedSec}s)`;

      try {
        await this.messaging.reply(item.messageId, replyWithTiming);
        queue.logAction('REPLY_SENT', item.messageId, `cid=${item.correlationId} elapsed=${elapsedSec}s`);
        console.log(`[pool:${groupName}] Replied to ${item.messageId} (${elapsedSec}s)`);
      } catch (err) {
        queue.logAction('ERROR', item.messageId, `cid=${item.correlationId} ${String(err)}`);
        console.error(`[pool:${groupName}] Failed to reply:`, err);
      }
    });

    // system-response → reply to task notification message
    bridge.on('system-response', async (reply: string, replyToMessageId: string) => {
      try {
        await this.messaging.reply(replyToMessageId, reply);
        log.debug(`[pool:${groupName}] System response replied to ${replyToMessageId}`);
      } catch (err) {
        console.warn(`[pool:${groupName}] Failed to reply system response:`, err);
      }
    });

    // close → remove from pool
    bridge.on('close', () => {
      console.log(`[pool] Session bridge for group "${groupName}" closed, removing from pool`);
      this.entries.delete(routingKey);
    });

    // alert → forward to group chat (use feishuChatId, not routingKey)
    bridge.on('alert', (message: string) => {
      this.messaging.sendMessage(feishuChatId, message).catch((err) => {
        console.warn(`[pool:${groupName}] Failed to send alert:`, err);
      });
    });

    // auto-flush-complete → notify group chat
    bridge.on('auto-flush-complete', () => {
      this.messaging.sendMessage(feishuChatId, '🔄 上下文已自动刷新').catch((err) => {
        console.warn(`[pool:${groupName}] Failed to send flush notification:`, err);
      });
    });

    // flush-drain-complete → clear orphaned queue items
    bridge.on('flush-drain-complete', () => {
      const orphaned = queue.clearAll();
      if (orphaned.length > 0) {
        console.log(`[pool:${groupName}] Cleared ${orphaned.length} orphaned queue items after flush drain`);
      }
    });

    // chunk / stream-abort → re-emit on pool level for console broadcast
    bridge.on('chunk', (text: string) => {
      this.emit('chunk', bridge.label, text);
    });
    bridge.on('stream-abort', () => {
      this.emit('stream-abort', bridge.label);
    });
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
      console.log(`[pool] Evicting LRU Director for group "${entry.groupName}" (idle ${Math.floor((Date.now() - lruTime) / 1000)}s)`);
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

