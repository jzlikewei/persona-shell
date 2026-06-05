import type { MessagingClient, MessageHandler, IncomingMessage, StreamingReplyHandle, CardActionHandler } from './messaging.js';

const MAX_ORIGIN_ENTRIES = 10_000;

/**
 * 多渠道路由器 — 包装多个 MessagingClient，按 messageId 路由回复到正确渠道。
 * 自身实现 MessagingClient 接口，对上层透明。
 *
 * 回复策略：
 * - 总是推送到 WebUI（通过事件系统，不经过 MessagingRouter）
 * - 如果消息来源是 IM → 同时转发到 IM client
 *
 * Agent/Session 不直接调用 MessagingRouter，由基础设施层（wireEvents / console.ts）负责。
 */
export class MessagingRouter implements MessagingClient {
  private primary: MessagingClient;
  private clients: MessagingClient[] = [];
  private handler: MessageHandler | null = null;
  private cardActionHandlers: CardActionHandler[] = [];
  private messageOrigin = new Map<string, MessagingClient>();

  constructor(primary: MessagingClient) {
    this.primary = primary;
    this.addClient(primary);
  }

  addClient(client: MessagingClient): void {
    this.clients.push(client);
    client.onMessage((msg) => {
      this.messageOrigin.set(msg.messageId, client);
      if (this.messageOrigin.size > MAX_ORIGIN_ENTRIES) {
        const first = this.messageOrigin.keys().next().value as string;
        this.messageOrigin.delete(first);
      }
      this.handler?.(msg);
    });
    for (const handler of this.cardActionHandlers) {
      client.onCardAction?.(handler);
    }
  }

  start(): void {
    for (const client of this.clients) {
      client.start();
    }
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  onCardAction(handler: CardActionHandler): void {
    this.cardActionHandlers.push(handler);
    for (const client of this.clients) {
      client.onCardAction?.(handler);
    }
  }

  async reply(messageId: string, text: string): Promise<void> {
    const client = this.messageOrigin.get(messageId) ?? this.primary;
    return client.reply(messageId, text);
  }

  async sendMessage(chatId: string, text: string): Promise<string | null> {
    return this.primary.sendMessage(chatId, text);
  }

  async startStreamingReply(messageId: string, initialText?: string): Promise<StreamingReplyHandle | null> {
    const client = this.messageOrigin.get(messageId) ?? this.primary;
    if (!client.startStreamingReply) return null;
    return client.startStreamingReply(messageId, initialText);
  }

  async addReaction(messageId: string, emoji: string): Promise<void> {
    const client = this.messageOrigin.get(messageId) ?? this.primary;
    return client.addReaction(messageId, emoji);
  }

  async uploadAndReplyImage(messageId: string, filePath: string): Promise<void> {
    const client = this.messageOrigin.get(messageId) ?? this.primary;
    return client.uploadAndReplyImage(messageId, filePath);
  }

  async uploadAndReplyFile(messageId: string, filePath: string): Promise<void> {
    const client = this.messageOrigin.get(messageId) ?? this.primary;
    return client.uploadAndReplyFile(messageId, filePath);
  }

  async uploadAndSendImage(chatId: string, filePath: string): Promise<string | null> {
    return this.primary.uploadAndSendImage(chatId, filePath);
  }

  async uploadAndSendFile(chatId: string, filePath: string): Promise<string | null> {
    return this.primary.uploadAndSendFile(chatId, filePath);
  }

  getLastChatId(): string | null {
    return this.primary.getLastChatId();
  }

  getConnectionStatus(): 'connected' | 'disconnected' {
    return this.clients.some(c => c.getConnectionStatus() === 'connected')
      ? 'connected'
      : 'disconnected';
  }
}
