import { appendFileSync, mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import { randomBytes } from 'crypto';
import { getState, setState } from './task-store.js';

export interface QueueItem {
  text: string;
  messageId: string;
  chatId: string;
  timestamp: number;
  correlationId: string;
  cancelled?: boolean;
}

export function generateCorrelationId(): string {
  const ts = Math.floor(Date.now() / 1000);
  const rand = randomBytes(2).toString('hex'); // 4 hex chars
  return `cid-${ts}-${rand}`;
}

export class MessageQueue {
  private items: Map<string, QueueItem> = new Map();
  private logPath: string;

  constructor(logPath: string) {
    this.logPath = logPath;
    const dir = dirname(logPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  /** Restore queue items from persisted state. Returns number of restored items.
   *  Skips items older than 5 minutes — after Shell restart, Director has moved on
   *  and those messages are orphans. */
  restoreFromState(): number {
    const saved = getState<QueueItem[]>('queue');
    if (!saved || !Array.isArray(saved) || saved.length === 0) return 0;
    const MAX_AGE_MS = 5 * 60_000; // 5 minutes
    const now = Date.now();
    let skipped = 0;
    for (const item of saved) {
      if (item.correlationId && item.text) {
        // Guard: treat missing/invalid timestamp as stale (NaN > number is always false)
        const age = now - item.timestamp;
        if (!Number.isFinite(age) || age > MAX_AGE_MS) {
          skipped++;
          continue;
        }
        this.items.set(item.correlationId, item);
      }
    }
    if (skipped > 0) {
      this.log('RESTORE', '-', `skipped ${skipped} stale items (older than 5m)`);
    }
    if (this.items.size > 0) {
      this.log('RESTORE', '-', `restored ${this.items.size} items from state`);
    }
    this.persist(); // Clean up stale items from disk
    return this.items.size;
  }

  private persist(): void {
    setState<QueueItem[]>('queue', Array.from(this.items.values()));
  }

  /** 返回队列当前所有项的快照，供控制台使用 */
  getSnapshot(): Array<{
    text: string;
    messageId: string;
    correlationId: string;
    timestamp: number;
    cancelled: boolean;
  }> {
    return Array.from(this.items.values()).map((item) => ({
      text: item.text.slice(0, 50),
      messageId: item.messageId,
      correlationId: item.correlationId,
      timestamp: item.timestamp,
      cancelled: !!item.cancelled,
    }));
  }

  enqueue(item: Omit<QueueItem, 'timestamp' | 'correlationId'>): string {
    const correlationId = generateCorrelationId();
    const entry: QueueItem = { ...item, timestamp: Date.now(), correlationId };
    this.items.set(correlationId, entry);
    this.persist();
    this.log('ENQUEUE', entry.messageId, `cid=${correlationId} ${item.text.slice(0, 100)}`);
    return correlationId;
  }

  /** Resolve a specific message by its correlation ID */
  resolve(correlationId: string): QueueItem | undefined {
    const item = this.items.get(correlationId);
    if (item) {
      this.items.delete(correlationId);
      this.persist();
      this.log('RESOLVE', item.messageId, `cid=${correlationId}`);
    }
    return item;
  }

  /** Mark the oldest non-cancelled message as cancelled (does NOT remove from queue) */
  cancelOldest(): QueueItem | undefined {
    let oldest: QueueItem | undefined;
    for (const item of this.items.values()) {
      if (!item.cancelled && (!oldest || item.timestamp < oldest.timestamp)) {
        oldest = item;
      }
    }
    if (oldest) {
      oldest.cancelled = true;
      this.persist();
      this.log('CANCEL', oldest.messageId, `cid=${oldest.correlationId}`);
    }
    return oldest;
  }

  /** Resolve the oldest message, skipping and discarding cancelled items */
  resolveOldest(): QueueItem | undefined {
    let modified = false;
    while (this.items.size > 0) {
      let oldest: QueueItem | undefined;
      for (const item of this.items.values()) {
        if (!oldest || item.timestamp < oldest.timestamp) {
          oldest = item;
        }
      }
      if (!oldest) break;

      this.items.delete(oldest.correlationId);
      modified = true;

      if (oldest.cancelled) {
        this.log('DISCARD_CANCELLED', oldest.messageId, `cid=${oldest.correlationId}`);
        continue;
      }

      this.log('RESOLVE_OLDEST', oldest.messageId, `cid=${oldest.correlationId}`);
      this.persist();
      return oldest;
    }
    if (modified) this.persist();
    return undefined;
  }

  peek(): QueueItem | undefined {
    let oldest: QueueItem | undefined;
    for (const item of this.items.values()) {
      if (!oldest || item.timestamp < oldest.timestamp) {
        oldest = item;
      }
    }
    return oldest;
  }

  /** Clear all items from the queue (e.g., after flush when orphaned items can never be resolved).
   *  Returns the cleared items for notification purposes. */
  clearAll(): QueueItem[] {
    const items = Array.from(this.items.values());
    if (items.length > 0) {
      this.items.clear();
      this.persist();
      this.log('CLEAR_ALL', '-', `cleared ${items.length} orphaned items`);
    }
    return items;
  }

  get length(): number {
    return this.items.size;
  }

  logAction(action: string, messageId: string, detail: string): void {
    this.log(action, messageId, detail);
  }

  private log(action: string, messageId: string, detail: string): void {
    const timestamp = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai', hour12: false }).replace(',', '');
    const line = `[${timestamp}] [${action}] [${messageId}] ${detail}\n`;
    try {
      appendFileSync(this.logPath, line);
    } catch {
      console.error(`[queue] Failed to write log: ${line.trim()}`);
    }
  }
}
