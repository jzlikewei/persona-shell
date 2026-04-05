import { appendFileSync, mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';

export interface QueueItem {
  text: string;
  messageId: string;
  chatId: string;
  timestamp: number;
}

export class MessageQueue {
  private queue: QueueItem[] = [];
  private logPath: string;

  constructor(logPath: string) {
    this.logPath = logPath;
    const dir = dirname(logPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  enqueue(item: Omit<QueueItem, 'timestamp'>): void {
    const entry: QueueItem = { ...item, timestamp: Date.now() };
    this.queue.push(entry);
    this.log('ENQUEUE', entry.messageId, item.text.slice(0, 100));
  }

  dequeue(): QueueItem | undefined {
    const item = this.queue.shift();
    if (item) {
      this.log('DEQUEUE', item.messageId, '');
    }
    return item;
  }

  peek(): QueueItem | undefined {
    return this.queue[0];
  }

  get length(): number {
    return this.queue.length;
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
