import { appendFileSync, mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import { randomBytes } from 'crypto';

export interface QueueItem {
  text: string;
  messageId: string;
  chatId: string;
  timestamp: number;
  correlationId: string;
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

  enqueue(item: Omit<QueueItem, 'timestamp' | 'correlationId'>): string {
    const correlationId = generateCorrelationId();
    const entry: QueueItem = { ...item, timestamp: Date.now(), correlationId };
    this.items.set(correlationId, entry);
    this.log('ENQUEUE', entry.messageId, `cid=${correlationId} ${item.text.slice(0, 100)}`);
    return correlationId;
  }

  /** Resolve a specific message by its correlation ID */
  resolve(correlationId: string): QueueItem | undefined {
    const item = this.items.get(correlationId);
    if (item) {
      this.items.delete(correlationId);
      this.log('RESOLVE', item.messageId, `cid=${correlationId}`);
    }
    return item;
  }

  /** Fallback: resolve the oldest message in the queue (by timestamp) */
  resolveOldest(): QueueItem | undefined {
    let oldest: QueueItem | undefined;
    for (const item of this.items.values()) {
      if (!oldest || item.timestamp < oldest.timestamp) {
        oldest = item;
      }
    }
    if (oldest) {
      this.items.delete(oldest.correlationId);
      this.log('RESOLVE_OLDEST', oldest.messageId, `cid=${oldest.correlationId}`);
    }
    return oldest;
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

  get length(): number {
    return this.items.size;
  }

  logAction(action: string, messageId: string, detail: string): void {
    this.log(action, messageId, detail);
  }

  private log(action: string, messageId: string, detail: string): void {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] [${action}] [${messageId}] ${detail}\n`;
    try {
      appendFileSync(this.logPath, line);
    } catch {
      console.error(`[queue] Failed to write log: ${line.trim()}`);
    }
  }
}
