import type { StreamingReplyHandle } from './messaging.js';

export interface UpdatingTextStreamOptions {
  sourceMessageId: string;
  streamMessageId: string;
  updateText(messageId: string, text: string): Promise<void>;
  fallbackReply(messageId: string, text: string): Promise<unknown>;
  logDebug(message: string): void;
  debounceMs: number;
  minUpdateChars: number;
  completeText: string;
  abortText: string;
}

export class UpdatingTextStreamingReply implements StreamingReplyHandle {
  private text = '';
  private lastSent = '';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly options: UpdatingTextStreamOptions) {}

  append(delta: string): void {
    if (this.closed || !delta) return;
    this.text += delta;
    if (this.text.length - this.lastSent.length < this.options.minUpdateChars) {
      this.scheduleFlush();
      return;
    }
    this.flushSoon();
  }

  async final(text: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.clearTimer();
    const finalText = text.trim() || this.text.trim() || this.options.completeText;
    await this.enqueueUpdate(finalText, true);
  }

  async abort(text = this.options.abortText): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.clearTimer();
    await this.enqueueUpdate(text, true).catch((err) => {
      this.options.logDebug(`[streaming] abort update failed: ${(err as Error).message}`);
    });
  }

  private scheduleFlush(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flushSoon();
    }, this.options.debounceMs);
  }

  private flushSoon(): void {
    this.clearTimer();
    const text = this.text.trim();
    if (!text || text === this.lastSent) return;
    void this.enqueueUpdate(text, false).catch((err) => {
      this.options.logDebug(`[streaming] update failed: ${(err as Error).message}`);
    });
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private enqueueUpdate(text: string, allowFallback: boolean): Promise<void> {
    const run = this.queue.catch(() => undefined).then(async () => {
      await this.options.updateText(this.options.streamMessageId, text);
      this.lastSent = text;
    });
    this.queue = run.catch(async (err) => {
      if (allowFallback) {
        await this.options.fallbackReply(this.options.sourceMessageId, text);
        this.lastSent = text;
        return;
      }
      this.options.logDebug(`[streaming] update skipped: ${(err as Error).message}`);
    });
    return this.queue;
  }
}
