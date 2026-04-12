/** 平台无关的入站消息 */
export interface IncomingMessage {
  text: string;
  messageId: string;
  chatId: string;
  chatType: 'p2p' | 'group';
  memberCount?: number;
  groupName?: string;
  threadId?: string;      // 子对话（飞书话题、Slack thread、Telegram topic）
  quotedText?: string;    // 引用回复的原文
}

export type MessageHandler = (msg: IncomingMessage) => Promise<void> | void;

/** 通讯层统一接口 — 飞书、Telegram、Slack 等平台的适配器需实现此接口 */
export interface MessagingClient {
  start(): void;
  onMessage(handler: MessageHandler): void;

  reply(messageId: string, text: string): Promise<void>;
  sendMessage(chatId: string, text: string): Promise<string | null>;
  addReaction(messageId: string, emoji: string): Promise<void>;

  uploadAndReplyImage(messageId: string, filePath: string): Promise<void>;
  uploadAndReplyFile(messageId: string, filePath: string): Promise<void>;
  uploadAndSendImage(chatId: string, filePath: string): Promise<string | null>;
  uploadAndSendFile(chatId: string, filePath: string): Promise<string | null>;

  getLastChatId(): string | null;
  getConnectionStatus(): 'connected' | 'disconnected';
}
