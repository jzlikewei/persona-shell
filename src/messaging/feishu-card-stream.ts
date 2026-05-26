import type { StreamingReplyHandle } from './messaging.js';

export interface FeishuCardStreamOptions {
  sourceMessageId: string;
  cardMessageId: string;
  updateCard(messageId: string, card: FeishuCard): Promise<void>;
  fallbackReply(messageId: string, text: string): Promise<unknown>;
  logDebug(message: string): void;
  debounceMs: number;
  minUpdateChars: number;
  botName: string;
  completeText: string;
  abortText: string;
}

type CardTemplate = 'blue' | 'green' | 'red' | 'indigo';

export interface FeishuCard {
  schema: '2.0';
  config: { wide_screen_mode: boolean };
  header: {
    title: { tag: 'plain_text'; content: string };
    subtitle?: { tag: 'plain_text'; content: string };
    template: CardTemplate;
    icon?: { tag: 'standard_icon'; token: string };
    text_tag_list?: Array<{
      tag: 'text_tag';
      text: { tag: 'plain_text'; content: string };
      color: string;
    }>;
  };
  body: {
    elements: Array<
      | { tag: 'div'; text: { tag: 'plain_text'; content: string }; icon?: { tag: 'standard_icon'; token: string; color?: string } }
      | { tag: 'markdown'; content: string }
    >;
  };
}

export function buildStreamingCard(opts: {
  botName: string;
  status: 'thinking' | 'streaming' | 'done' | 'aborted' | 'error';
  text: string;
}): FeishuCard {
  const statusConfig = {
    thinking: {
      subtitle: 'thinking...',
      template: 'blue' as const,
      icon: 'loading_outlined',
      tag: '思考中',
      color: 'blue',
    },
    streaming: {
      subtitle: 'streaming...',
      template: 'indigo' as const,
      icon: 'loading_outlined',
      tag: '生成中',
      color: 'blue',
    },
    done: {
      subtitle: 'done',
      template: 'green' as const,
      icon: 'yes_outlined',
      tag: '完成',
      color: 'green',
    },
    aborted: {
      subtitle: 'aborted',
      template: 'red' as const,
      icon: 'close_outlined',
      tag: '已中断',
      color: 'red',
    },
    error: {
      subtitle: 'error',
      template: 'red' as const,
      icon: 'warning_outlined',
      tag: '失败',
      color: 'red',
    },
  }[opts.status];

  const text = opts.text.trim();
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: opts.botName },
      subtitle: { tag: 'plain_text', content: statusConfig.subtitle },
      template: statusConfig.template,
      icon: { tag: 'standard_icon', token: statusConfig.icon },
      text_tag_list: [
        {
          tag: 'text_tag',
          text: { tag: 'plain_text', content: statusConfig.tag },
          color: statusConfig.color,
        },
      ],
    },
    body: {
      elements: [
        text
          ? { tag: 'markdown', content: toFeishuMarkdown(text) }
          : {
              tag: 'div',
              icon: { tag: 'standard_icon', token: statusConfig.icon, color: statusConfig.color },
              text: { tag: 'plain_text', content: statusConfig.tag },
            },
      ],
    },
  };
}

function toFeishuMarkdown(markdown: string): string {
  return markdown
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/^#{1,6}\s+(.+)$/gm, '**$1**')
    .replace(/^>\s?/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export class FeishuCardStreamingReply implements StreamingReplyHandle {
  private text = '';
  private lastSent = '';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly options: FeishuCardStreamOptions) {}

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
    await this.enqueueUpdate(finalText, 'done', true);
  }

  async abort(text = this.options.abortText): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.clearTimer();
    await this.enqueueUpdate(text, 'aborted', true).catch((err) => {
      this.options.logDebug(`[streaming-card] abort update failed: ${(err as Error).message}`);
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
    void this.enqueueUpdate(text, 'streaming', false).catch((err) => {
      this.options.logDebug(`[streaming-card] update failed: ${(err as Error).message}`);
    });
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private enqueueUpdate(
    text: string,
    status: 'streaming' | 'done' | 'aborted' | 'error',
    allowFallback: boolean,
  ): Promise<void> {
    const card = buildStreamingCard({
      botName: this.options.botName,
      status,
      text,
    });
    const run = this.queue.catch(() => undefined).then(async () => {
      await this.options.updateCard(this.options.cardMessageId, card);
      this.lastSent = text;
    });
    this.queue = run.catch(async (err) => {
      if (allowFallback) {
        await this.options.fallbackReply(this.options.sourceMessageId, text);
        this.lastSent = text;
        return;
      }
      this.options.logDebug(`[streaming-card] update skipped: ${(err as Error).message}`);
    });
    return this.queue;
  }
}
