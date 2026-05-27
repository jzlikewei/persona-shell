export interface Attachment {
  type: 'image' | 'file' | 'audio';
  filePath: string;
  fileName?: string;
}

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
  senderOpenId?: string;  // 发送者的飞书 open_id（用于本体识别）
  senderName?: string;
  attachments?: Attachment[];
}

export type MessageHandler = (msg: IncomingMessage) => Promise<void> | void;

export interface CardAction {
  action: string;
  messageId: string;
  sourceMessageId?: string;
  chatId?: string;
  senderOpenId?: string;
}

export type CardActionHandler = (action: CardAction) => Promise<void> | void;

export interface StreamingReplyHandle {
  append(text: string): void;
  showToolCall?(toolName?: string): void;
  getMessageId?(): string;
  final(text: string): Promise<void>;
  abort(text?: string): Promise<void>;
}

/** 通讯层统一接口 — 飞书、Telegram、Slack 等平台的适配器需实现此接口 */
export interface MessagingClient {
  start(): void;
  onMessage(handler: MessageHandler): void;
  onCardAction?(handler: CardActionHandler): void;

  reply(messageId: string, text: string): Promise<void>;
  sendMessage(chatId: string, text: string): Promise<string | null>;
  startStreamingReply?(messageId: string, initialText?: string): Promise<StreamingReplyHandle | null>;
  addReaction(messageId: string, emoji: string): Promise<void>;

  uploadAndReplyImage(messageId: string, filePath: string): Promise<void>;
  uploadAndReplyFile(messageId: string, filePath: string): Promise<void>;
  uploadAndSendImage(chatId: string, filePath: string): Promise<string | null>;
  uploadAndSendFile(chatId: string, filePath: string): Promise<string | null>;

  getLastChatId(): string | null;
  getConnectionStatus(): 'connected' | 'disconnected';
}
