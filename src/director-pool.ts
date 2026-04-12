import { createHash } from 'crypto';
import { Director, type DirectorOptions } from './director.js';
import { MessageQueue, type QueueItem } from './queue.js';
import type { Config } from './config.js';
import { log } from './logger.js';

export interface PoolConfig {
  max_directors: number;
  idle_timeout_minutes: number;
  small_group_threshold: number;
}

/** Callbacks for wiring Director events to external systems (feishu, metrics, etc.) */
export interface PoolEventHandlers {
  reply: (messageId: string, text: string) => Promise<void>;
  sendMessage: (chatId: string, text: string) => Promise<string | null>;
  addReaction: (messageId: string, emoji: string) => Promise<void>;
}

interface PoolEntry {
  director: Director;
  queue: MessageQueue;
  chatId: string;
  groupName: string;
  lastActiveAt: number;
}

export class DirectorPool {
  private entries: Map<string, PoolEntry> = new Map();
  private creating: Map<string, Promise<PoolEntry>> = new Map();
  private mainDirector: Director;
  private poolConfig: PoolConfig;
  private directorConfig: Config['director'];
  private handlers: PoolEventHandlers;

  constructor(
    mainDirector: Director,
    poolConfig: PoolConfig,
    directorConfig: Config['director'],
    handlers: PoolEventHandlers,
  ) {
    this.mainDirector = mainDirector;
    this.poolConfig = poolConfig;
    this.directorConfig = directorConfig;
    this.handlers = handlers;
  }

  /** Get the main (p2p) Director */
  getMain(): Director {
    return this.mainDirector;
  }

  /** Get a group Director if it exists */
  get(chatId: string): PoolEntry | undefined {
    return this.entries.get(chatId);
  }

  /** Number of active group Directors */
  get size(): number {
    return this.entries.size;
  }

  /** Get or create a Director for a group chat */
  async getOrCreate(chatId: string, groupName?: string): Promise<PoolEntry> {
    const existing = this.entries.get(chatId);
    if (existing) {
      existing.lastActiveAt = Date.now();
      return existing;
    }

    // 防止并发创建同一个 chatId 的 Director（竞态锁）
    const inflight = this.creating.get(chatId);
    if (inflight) return inflight;

    const promise = this._doCreate(chatId, groupName);
    this.creating.set(chatId, promise);
    try {
      return await promise;
    } finally {
      this.creating.delete(chatId);
    }
  }

  private async _doCreate(chatId: string, groupName?: string): Promise<PoolEntry> {
    // Evict LRU if at capacity
    if (this.entries.size >= this.poolConfig.max_directors) {
      await this.evictLRU();
    }

    const label = chatIdToLabel(chatId);
    const name = groupName ?? chatId.slice(0, 8);
    console.log(`[pool] Creating Director for group "${name}" (label=${label})`);

    const director = new Director({
      config: this.directorConfig,
      label,
      isMain: false,
      groupName: name,
    } satisfies DirectorOptions);

    const queue = new MessageQueue(`logs/queue-${label}.log`);

    await director.start();
    director.bootstrap();

    this.wireEvents(director, queue, chatId, name);

    const entry: PoolEntry = {
      director,
      queue,
      chatId,
      groupName: name,
      lastActiveAt: Date.now(),
    };
    this.entries.set(chatId, entry);
    return entry;
  }

  /** Send a message to a group Director, managing queue correlation */
  async send(chatId: string, text: string, messageId: string): Promise<void> {
    const entry = this.entries.get(chatId);
    if (!entry) throw new Error(`No Director for chatId ${chatId}`);

    entry.lastActiveAt = Date.now();
    const correlationId = entry.queue.enqueue({ text, messageId, chatId });
    entry.queue.logAction('SEND_TO_DIRECTOR', messageId, `cid=${correlationId} ${text.slice(0, 100)}`);

    try {
      await entry.director.send(text);
    } catch (err) {
      entry.queue.resolve(correlationId);
      throw err;
    }
  }

  /** Shutdown a specific group Director */
  async shutdown(chatId: string): Promise<void> {
    const entry = this.entries.get(chatId);
    if (!entry) return;

    console.log(`[pool] Shutting down Director for group "${entry.groupName}"`);
    await entry.director.stop();
    // Kill the claude process
    const status = entry.director.getStatus();
    if (status.pid) {
      try { process.kill(-status.pid, 'SIGTERM'); } catch { /* already dead */ }
    }
    this.entries.delete(chatId);
  }

  /** Shutdown all non-main Directors */
  async shutdownAll(): Promise<void> {
    const chatIds = [...this.entries.keys()];
    for (const chatId of chatIds) {
      await this.shutdown(chatId);
    }
    console.log(`[pool] All ${chatIds.length} group Director(s) shut down`);
  }

  /** Get status of all pool entries for dashboard */
  getPoolStatus(): Array<{
    chatId: string;
    groupName: string;
    label: string;
    lastActiveAt: number;
    directorStatus: ReturnType<Director['getStatus']>;
    queueLength: number;
  }> {
    return [...this.entries.values()].map((entry) => ({
      chatId: entry.chatId,
      groupName: entry.groupName,
      label: entry.director.label,
      lastActiveAt: entry.lastActiveAt,
      directorStatus: entry.director.getStatus(),
      queueLength: entry.queue.length,
    }));
  }

  /** Wire Director events for a group chat Director */
  private wireEvents(director: Director, queue: MessageQueue, chatId: string, groupName: string): void {
    // response → resolve oldest queue item → reply to feishu
    director.on('response', async (reply: string, durationMs?: number) => {
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
        await this.handlers.reply(item.messageId, replyWithTiming);
        queue.logAction('REPLY_SENT', item.messageId, `cid=${item.correlationId} elapsed=${elapsedSec}s`);
        console.log(`[pool:${groupName}] Replied to ${item.messageId} (${elapsedSec}s)`);
      } catch (err) {
        queue.logAction('ERROR', item.messageId, `cid=${item.correlationId} ${String(err)}`);
        console.error(`[pool:${groupName}] Failed to reply:`, err);
      }
    });

    // close → remove from pool (non-main Director does not exit process)
    director.on('close', () => {
      console.log(`[pool] Director for group "${groupName}" closed, removing from pool`);
      this.entries.delete(chatId);
    });

    // alert → forward to group chat
    director.on('alert', (message: string) => {
      this.handlers.sendMessage(chatId, message).catch((err) => {
        console.warn(`[pool:${groupName}] Failed to send alert:`, err);
      });
    });

    // auto-flush-complete → notify group chat
    director.on('auto-flush-complete', () => {
      this.handlers.sendMessage(chatId, '🔄 上下文已自动刷新').catch((err) => {
        console.warn(`[pool:${groupName}] Failed to send flush notification:`, err);
      });
    });

    // flush-drain-complete → clear orphaned queue items
    director.on('flush-drain-complete', () => {
      const orphaned = queue.clearAll();
      if (orphaned.length > 0) {
        console.log(`[pool:${groupName}] Cleared ${orphaned.length} orphaned queue items after flush drain`);
      }
    });
  }

  /** Evict the least recently used group Director */
  private async evictLRU(): Promise<void> {
    let lruChatId: string | null = null;
    let lruTime = Infinity;

    for (const [chatId, entry] of this.entries) {
      if (entry.lastActiveAt < lruTime) {
        lruTime = entry.lastActiveAt;
        lruChatId = chatId;
      }
    }

    if (lruChatId) {
      const entry = this.entries.get(lruChatId)!;
      console.log(`[pool] Evicting LRU Director for group "${entry.groupName}" (idle ${Math.floor((Date.now() - lruTime) / 1000)}s)`);
      await this.shutdown(lruChatId);
    }
  }
}

/** Convert chatId to a short, filesystem-safe label */
function chatIdToLabel(chatId: string): string {
  return createHash('sha256').update(chatId).digest('hex').slice(0, 8);
}
