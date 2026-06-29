import { randomUUID } from 'crypto';
import { ITEM_TYPE_TEXT, ITEM_TYPE_VOICE, type MessageItem } from './weixin-types.js';

const WEIXIN_PREFIX = 'weixin:';

// ── ID helpers ──

export function makeChatId(accountId: string, userId: string): string {
  return `${WEIXIN_PREFIX}${accountId}:${userId}`;
}

export function parseChatId(chatId: string): { accountId: string; userId: string } | null {
  if (!chatId.startsWith(WEIXIN_PREFIX)) return null;
  const rest = chatId.slice(WEIXIN_PREFIX.length);
  const idx = rest.indexOf(':');
  if (idx <= 0 || idx === rest.length - 1) return null;
  return { accountId: rest.slice(0, idx), userId: rest.slice(idx + 1) };
}

export function makeMessageId(accountId: string, rawId: string): string {
  return `${WEIXIN_PREFIX}${accountId}:${rawId}`;
}

export function parseMessageId(messageId: string): { accountId: string; rawId: string } | null {
  if (!messageId.startsWith(WEIXIN_PREFIX)) return null;
  const rest = messageId.slice(WEIXIN_PREFIX.length);
  const idx = rest.indexOf(':');
  if (idx <= 0 || idx === rest.length - 1) return null;
  return { accountId: rest.slice(0, idx), rawId: rest.slice(idx + 1) };
}

export function isWeixinChatId(chatId: string): boolean {
  return chatId.startsWith(WEIXIN_PREFIX);
}

export function generateClientId(): string {
  return randomUUID();
}

// ── Account ID normalization ──

export function normalizeAccountId(raw: string): string {
  return raw.replace(/[@.:]/g, '_');
}

// ── Text chunking ──

export function chunkText(text: string, maxLen = 4000): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt <= 0) splitAt = remaining.lastIndexOf(' ', maxLen);
    if (splitAt <= 0) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, '');
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

// ── Markdown stripping ──

export function stripMarkdown(text: string): string {
  let result = text;
  // code blocks — keep content, remove fences
  result = result.replace(/```[\s\S]*?```/g, (m) => {
    const lines = m.split('\n');
    return lines.slice(1, -1).join('\n');
  });
  // inline code
  result = result.replace(/`([^`]+)`/g, '$1');
  // images
  result = result.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1');
  // links
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
  // bold/italic
  result = result.replace(/\*\*(.+?)\*\*/g, '$1');
  result = result.replace(/__(.+?)__/g, '$1');
  result = result.replace(/\*(.+?)\*/g, '$1');
  result = result.replace(/_(.+?)_/g, '$1');
  // headers
  result = result.replace(/^#{1,6}\s+/gm, '');
  return result;
}

// ── Inbound message body extraction ──

export function bodyFromItemList(items: MessageItem[]): string {
  const parts: string[] = [];
  for (const item of items) {
    if (item.type === ITEM_TYPE_TEXT && item.text_item?.text) {
      parts.push(item.text_item.text);
    } else if (item.type === ITEM_TYPE_VOICE && item.voice_item?.text) {
      parts.push(item.voice_item.text);
    }
  }
  return parts.join('\n');
}

export function extractQuotedText(msg: { quote_message?: { item_list: MessageItem[] } }): string | undefined {
  if (!msg.quote_message?.item_list?.length) return undefined;
  const text = bodyFromItemList(msg.quote_message.item_list);
  return text ? `[引用: ${text}]` : undefined;
}
