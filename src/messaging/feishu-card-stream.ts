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
type ButtonType = 'default' | 'primary' | 'danger';
type CardButton = {
  tag: 'button';
  text: { tag: 'plain_text'; content: string };
  type: ButtonType;
  value: Record<string, string>;
};
type CardElement =
  | { tag: 'div'; text: { tag: 'plain_text'; content: string }; icon?: { tag: 'standard_icon'; token: string; color?: string } }
  | { tag: 'markdown'; content: string }
  | { tag: 'hr' }
  | {
      tag: 'column_set';
      flex_mode: 'flow';
      columns: Array<{
        tag: 'column';
        width: 'auto';
        elements: CardButton[];
      }>;
    };

export interface FeishuCard {
  schema: '2.0';
  config: { wide_screen_mode: boolean; update_multi?: boolean };
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
    elements: CardElement[];
  };
}

const STREAM_CANCEL_ACTION = 'persona_stream_cancel';
type StreamUpdateStatus = 'streaming' | 'done' | 'aborted' | 'error';
type PendingCardUpdate = {
  text: string;
  status: StreamUpdateStatus;
  allowFallback: boolean;
  sentToolCallVisible: boolean;
  sentToolCallName: string | null;
  resolve(): void;
  reject(err: unknown): void;
};

export function buildStreamingCard(opts: {
  botName: string;
  status: 'thinking' | 'streaming' | 'done' | 'aborted' | 'error';
  text: string;
  showToolCall?: boolean;
  toolCallName?: string | null;
  actionSourceMessageId?: string;
  actionCardMessageId?: string;
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
  const elements: FeishuCard['body']['elements'] = [];
  if (opts.showToolCall) {
    elements.push({
      tag: 'div',
      icon: { tag: 'standard_icon', token: 'loading_outlined', color: 'blue' },
      text: { tag: 'plain_text', content: formatToolCallText(opts.toolCallName) },
    });
  }
  if (text) {
    elements.push({ tag: 'markdown', content: toFeishuMarkdown(text) });
  }
  if (elements.length === 0) {
    elements.push({
      tag: 'div',
      icon: { tag: 'standard_icon', token: statusConfig.icon, color: statusConfig.color },
      text: { tag: 'plain_text', content: statusConfig.tag },
    });
  }
  if (opts.status === 'thinking' || opts.status === 'streaming') {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'column_set',
      flex_mode: 'flow',
      columns: [
        {
          tag: 'column',
          width: 'auto',
          elements: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '取消' },
              type: 'danger',
              value: {
                action: STREAM_CANCEL_ACTION,
                ...(opts.actionSourceMessageId ? { sourceMessageId: opts.actionSourceMessageId } : {}),
                ...(opts.actionCardMessageId ? { cardMessageId: opts.actionCardMessageId } : {}),
              },
            },
          ],
        },
      ],
    });
  }

  return {
    schema: '2.0',
    config: { wide_screen_mode: true, update_multi: true },
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
      elements,
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

function normalizeToolCallName(toolName?: string): string | null {
  const normalized = toolName?.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}

function formatToolCallText(toolName?: string | null): string {
  const normalized = normalizeToolCallName(toolName ?? undefined);
  return normalized ? `正在调用工具：${normalized}` : '正在调用工具...';
}

export class FeishuCardStreamingReply implements StreamingReplyHandle {
  private text = '';
  private lastSent = '';
  private toolCallVisible = false;
  private lastSentToolCallVisible = false;
  private toolCallName: string | null = null;
  private lastSentToolCallName: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private pendingUpdate: PendingCardUpdate | null = null;
  private pumpScheduled = false;
  private closed = false;

  constructor(private readonly options: FeishuCardStreamOptions) {}

  append(delta: string): void {
    if (this.closed || !delta) return;
    const nextLength = this.text.length + delta.length;
    const nextSinceLast = nextLength - this.lastSent.length;
    this.options.logDebug(
      `[streaming-card] append chars=${delta.length} total=${nextLength} since_last=${nextSinceLast} min_chars=${this.options.minUpdateChars}`,
    );
    this.text += delta;
    if (this.text.length - this.lastSent.length < this.options.minUpdateChars) {
      this.scheduleFlush('below-min-chars');
      return;
    }
    this.flushSoon('min-chars-met');
  }

  showToolCall(toolName?: string): void {
    if (this.closed) return;
    const nextToolName = normalizeToolCallName(toolName);
    if (this.toolCallVisible && (!nextToolName || nextToolName === this.toolCallName)) return;
    this.toolCallVisible = true;
    this.toolCallName = nextToolName ?? this.toolCallName;
    this.clearTimer();
    const text = this.text.trim();
    this.options.logDebug(`[streaming-card] tool call flush chars=${text.length} tool_name=${this.toolCallName ?? ''}`);
    void this.enqueueUpdate(text, 'streaming', false).catch((err) => {
      this.options.logDebug(`[streaming-card] tool call update failed: ${(err as Error).message}`);
    });
  }

  getMessageId(): string {
    return this.options.cardMessageId;
  }

  async final(text: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.clearTimer();
    this.toolCallVisible = false;
    this.toolCallName = null;
    const finalText = text.trim() || this.text.trim() || this.options.completeText;
    this.options.logDebug(`[streaming-card] final chars=${finalText.length}`);
    await this.enqueueUpdate(finalText, 'done', true);
  }

  async abort(text = this.options.abortText): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.clearTimer();
    this.toolCallVisible = false;
    this.toolCallName = null;
    this.options.logDebug(`[streaming-card] abort chars=${text.length}`);
    await this.enqueueUpdate(text, 'aborted', true).catch((err) => {
      this.options.logDebug(`[streaming-card] abort update failed: ${(err as Error).message}`);
    });
  }

  private scheduleFlush(reason: string): void {
    if (this.timer) return;
    this.options.logDebug(`[streaming-card] schedule flush reason=${reason} debounce_ms=${this.options.debounceMs}`);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flushSoon('debounce');
    }, this.options.debounceMs);
  }

  private flushSoon(reason: string): void {
    this.clearTimer();
    const text = this.text.trim();
    if (!text && !this.toolCallVisible) return;
    if (
      text === this.lastSent &&
      this.toolCallVisible === this.lastSentToolCallVisible &&
      this.toolCallName === this.lastSentToolCallName
    ) return;
    this.options.logDebug(
      `[streaming-card] flush reason=${reason} chars=${text.length} since_last=${text.length - this.lastSent.length} tool=${this.toolCallVisible} tool_name=${this.toolCallName ?? ''}`,
    );
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
    status: StreamUpdateStatus,
    allowFallback: boolean,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const sentToolCallVisible = status === 'streaming' && this.toolCallVisible;
      const sentToolCallName = sentToolCallVisible ? this.toolCallName : null;
      if (this.pendingUpdate) {
        this.options.logDebug(
          `[streaming-card] coalesce drop status=${this.pendingUpdate.status} chars=${this.pendingUpdate.text.length} next_status=${status}`,
        );
        this.pendingUpdate.resolve();
      }
      this.pendingUpdate = { text, status, allowFallback, sentToolCallVisible, sentToolCallName, resolve, reject };
      this.schedulePump();
    });
  }

  private schedulePump(): void {
    if (this.pumpScheduled) return;
    this.pumpScheduled = true;
    queueMicrotask(() => {
      this.pumpScheduled = false;
      this.pumpUpdates();
    });
  }

  private pumpUpdates(): void {
    if (this.inFlight || !this.pendingUpdate) return;
    const update = this.pendingUpdate;
    this.pendingUpdate = null;
    this.inFlight = this.runUpdate(update).finally(() => {
      this.inFlight = null;
      if (this.pendingUpdate) this.schedulePump();
    });
  }

  private async runUpdate(update: PendingCardUpdate): Promise<void> {
    const { text, status, allowFallback, sentToolCallVisible, sentToolCallName } = update;
    let failed = false;
    try {
      const card = buildStreamingCard({
        botName: this.options.botName,
        status,
        text,
        showToolCall: sentToolCallVisible,
        toolCallName: sentToolCallName,
        actionSourceMessageId: this.options.sourceMessageId,
        actionCardMessageId: this.options.cardMessageId,
      });
      this.options.logDebug(`[streaming-card] patch start status=${status} chars=${text.length} tool=${sentToolCallVisible} tool_name=${sentToolCallName ?? ''}`);
      await this.options.updateCard(this.options.cardMessageId, card);
      this.lastSent = text;
      this.lastSentToolCallVisible = sentToolCallVisible;
      this.lastSentToolCallName = sentToolCallName;
      this.options.logDebug(`[streaming-card] patch done status=${status} chars=${text.length} tool=${sentToolCallVisible} tool_name=${sentToolCallName ?? ''}`);
    } catch (err) {
      this.options.logDebug(`[streaming-card] update skipped: ${(err as Error).message}`);
      if (allowFallback) {
        try {
          await this.options.fallbackReply(this.options.sourceMessageId, text);
          this.lastSent = text;
          this.lastSentToolCallVisible = sentToolCallVisible;
          this.lastSentToolCallName = sentToolCallName;
        } catch (fallbackErr) {
          update.reject(fallbackErr);
          failed = true;
        }
      }
    }
    if (!failed) {
      update.resolve();
    }
  }
}
