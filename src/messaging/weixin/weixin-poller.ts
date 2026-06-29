import { mkdirSync } from 'fs';
import { join } from 'path';
import type { IncomingMessage, Attachment } from '../messaging.js';
import { WeixinApi } from './weixin-api.js';
import { WeixinContextStore } from './weixin-context-store.js';
import {
  SESSION_EXPIRED_ERRCODE,
  ITEM_TYPE_TEXT,
  ITEM_TYPE_IMAGE,
  ITEM_TYPE_FILE,
  ITEM_TYPE_VOICE,
  type WeixinAccountCredentials,
  type WeixinInboundMessage,
  type GetUpdatesResponse,
} from './weixin-types.js';
import {
  makeChatId,
  makeMessageId,
  bodyFromItemList,
  extractQuotedText,
} from './weixin-text.js';
import { downloadMedia } from './weixin-media.js';

const ACCOUNT_PAUSE_MS = 60 * 60 * 1000;

export interface WeixinPollerConfig {
  accountId: string;
  credentials: WeixinAccountCredentials;
  api: WeixinApi;
  contextStore: WeixinContextStore;
  pollTimeoutMs: number;
  retryDelayMs: number;
  backoffDelayMs: number;
  attachmentDir: string;
  onMessage: (msg: IncomingMessage) => Promise<void>;
  onError?: (accountId: string, error: unknown) => void;
}

export class WeixinPoller {
  private config: WeixinPollerConfig;
  private abortController: AbortController | null = null;
  private running = false;
  private pausedUntil = 0;
  private consecutiveFailures = 0;
  private lastPollAt = 0;
  private lastInboundAt = 0;
  private lastError: unknown = null;

  constructor(config: WeixinPollerConfig) {
    this.config = config;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.abortController = new AbortController();
    this.config.contextStore.loadContextTokens(this.config.accountId);
    this.pollLoop();
  }

  stop(): void {
    this.running = false;
    this.abortController?.abort();
    this.abortController = null;
  }

  isRunning(): boolean {
    return this.running;
  }

  isPaused(): boolean {
    return Date.now() < this.pausedUntil;
  }

  getStatus(): { lastPollAt: number; lastInboundAt: number; lastError: unknown; paused: boolean } {
    return {
      lastPollAt: this.lastPollAt,
      lastInboundAt: this.lastInboundAt,
      lastError: this.lastError,
      paused: this.isPaused(),
    };
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      if (this.isPaused()) {
        const wait = this.pausedUntil - Date.now();
        await this.sleep(Math.min(wait, 10_000));
        continue;
      }

      try {
        const syncBuf = this.config.contextStore.getSyncBuf(this.config.accountId);
        this.lastPollAt = Date.now();

        const response = await this.config.api.getUpdates(
          this.config.credentials,
          syncBuf,
          this.abortController?.signal,
        );

        if (this.handleErrorCode(response)) continue;

        this.consecutiveFailures = 0;
        this.lastError = null;

        await this.processMessages(response);

        if (response.get_updates_buf) {
          this.config.contextStore.saveSyncBuf(this.config.accountId, response.get_updates_buf);
        }
      } catch (err: unknown) {
        if (!this.running) break;
        if (err instanceof DOMException && err.name === 'AbortError') break;

        this.lastError = err;
        this.consecutiveFailures++;
        this.config.onError?.(this.config.accountId, err);

        const delay = this.consecutiveFailures >= 3
          ? this.config.backoffDelayMs
          : this.config.retryDelayMs;
        await this.sleep(delay);
      }
    }
  }

  private handleErrorCode(response: GetUpdatesResponse): boolean {
    if (response.errcode === SESSION_EXPIRED_ERRCODE) {
      console.error(`[weixin:${this.config.accountId}] Session expired (errcode=${SESSION_EXPIRED_ERRCODE}), pausing for 1 hour`);
      this.pausedUntil = Date.now() + ACCOUNT_PAUSE_MS;
      this.lastError = new Error(`SESSION_EXPIRED (errcode=${SESSION_EXPIRED_ERRCODE})`);
      return true;
    }
    if (response.errcode && response.errcode !== 0) {
      console.warn(`[weixin:${this.config.accountId}] getUpdates errcode=${response.errcode}: ${response.errmsg}`);
      this.consecutiveFailures++;
      return true;
    }
    return false;
  }

  private async processMessages(response: GetUpdatesResponse): Promise<void> {
    const msgs = response.msg_list;
    if (!msgs?.length) return;

    const processedIds = this.config.contextStore.getProcessedIds(this.config.accountId);

    for (const raw of msgs) {
      const dedupKey = raw.message_id || String(raw.seq) || raw.client_id || String(raw.create_time_ms ?? '');
      const fullDedupKey = `${this.config.accountId}:${dedupKey}`;

      if (processedIds.has(fullDedupKey)) continue;

      if (raw.context_token) {
        this.config.contextStore.setContextToken(
          this.config.accountId,
          raw.from_user_id,
          raw.context_token,
        );
      }

      const incoming = await this.convertMessage(raw);
      if (!incoming) continue;

      try {
        await this.config.onMessage(incoming);
        this.config.contextStore.markProcessed(this.config.accountId, fullDedupKey);
        this.lastInboundAt = Date.now();
      } catch (err) {
        console.error(`[weixin:${this.config.accountId}] Handler failed for message ${dedupKey}:`, err);
      }
    }
  }

  private async convertMessage(raw: WeixinInboundMessage): Promise<IncomingMessage | null> {
    const text = bodyFromItemList(raw.item_list);
    const quotedText = extractQuotedText(raw);
    const rawId = raw.message_id || String(raw.seq) || raw.client_id || '';
    if (!rawId && !text) return null;

    const attachments = await this.downloadAttachments(raw);

    return {
      text: text || (attachments.length > 0 ? '[媒体消息]' : ''),
      messageId: makeMessageId(this.config.accountId, rawId),
      chatId: makeChatId(this.config.accountId, raw.from_user_id),
      chatType: 'p2p',
      senderOpenId: raw.from_user_id,
      channel: 'weixin',
      quotedText,
      attachments: attachments.length > 0 ? attachments : undefined,
    };
  }

  private async downloadAttachments(raw: WeixinInboundMessage): Promise<Attachment[]> {
    const attachments: Attachment[] = [];
    const dir = join(this.config.attachmentDir, this.config.accountId);

    for (const item of raw.item_list) {
      try {
        if (item.type === ITEM_TYPE_IMAGE && item.image_item) {
          mkdirSync(dir, { recursive: true });
          const fileName = `img_${raw.message_id || Date.now()}_${item.image_item.file_id}.jpg`;
          const filePath = join(dir, fileName);
          await downloadMedia(item.image_item.cdn_url, item.image_item.aes_key, filePath);
          attachments.push({ type: 'image', filePath, fileName });
        } else if (item.type === ITEM_TYPE_FILE && item.file_item) {
          mkdirSync(dir, { recursive: true });
          const fileName = item.file_item.file_name || `file_${Date.now()}`;
          const filePath = join(dir, fileName);
          await downloadMedia(item.file_item.cdn_url, item.file_item.aes_key, filePath);
          attachments.push({ type: 'file', filePath, fileName });
        } else if (item.type === ITEM_TYPE_VOICE && item.voice_item) {
          mkdirSync(dir, { recursive: true });
          const fileName = `voice_${raw.message_id || Date.now()}.silk`;
          const filePath = join(dir, fileName);
          await downloadMedia(item.voice_item.cdn_url, item.voice_item.aes_key, filePath);
          attachments.push({ type: 'audio', filePath, fileName });
        }
      } catch (err) {
        console.warn(`[weixin:${this.config.accountId}] Failed to download attachment:`, err);
      }
    }

    return attachments;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
