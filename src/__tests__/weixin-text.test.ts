import { describe, expect, test } from 'bun:test';
import {
  chunkText,
  stripMarkdown,
  makeChatId,
  parseChatId,
  makeMessageId,
  parseMessageId,
  isWeixinChatId,
  generateClientId,
  normalizeAccountId,
  bodyFromItemList,
  extractQuotedText,
} from '../messaging/weixin/weixin-text.js';
import { ITEM_TYPE_TEXT, ITEM_TYPE_VOICE } from '../messaging/weixin/weixin-types.js';

describe('weixin-text', () => {
  // ── ID helpers ──

  describe('makeChatId / parseChatId', () => {
    test('round-trip', () => {
      const chatId = makeChatId('acct1', 'user_123@im.wechat');
      expect(chatId).toBe('weixin:acct1:user_123@im.wechat');
      const parsed = parseChatId(chatId);
      expect(parsed).toEqual({ accountId: 'acct1', userId: 'user_123@im.wechat' });
    });

    test('returns null for non-weixin chatId', () => {
      expect(parseChatId('oc_abc123')).toBeNull();
      expect(parseChatId('feishu:x:y')).toBeNull();
    });

    test('returns null for malformed weixin chatId', () => {
      expect(parseChatId('weixin:')).toBeNull();
      expect(parseChatId('weixin:onlyaccount')).toBeNull();
      expect(parseChatId('weixin::user')).toBeNull();
    });
  });

  describe('makeMessageId / parseMessageId', () => {
    test('round-trip', () => {
      const msgId = makeMessageId('acct1', 'msg_456');
      expect(msgId).toBe('weixin:acct1:msg_456');
      const parsed = parseMessageId(msgId);
      expect(parsed).toEqual({ accountId: 'acct1', rawId: 'msg_456' });
    });

    test('returns null for non-weixin messageId', () => {
      expect(parseMessageId('om_xxx')).toBeNull();
    });
  });

  describe('isWeixinChatId', () => {
    test('true for weixin prefix', () => {
      expect(isWeixinChatId('weixin:a:b')).toBe(true);
    });
    test('false for other', () => {
      expect(isWeixinChatId('oc_123')).toBe(false);
    });
  });

  describe('generateClientId', () => {
    test('produces unique values', () => {
      const ids = new Set(Array.from({ length: 100 }, () => generateClientId()));
      expect(ids.size).toBe(100);
    });
  });

  describe('normalizeAccountId', () => {
    test('replaces @, ., : with _', () => {
      expect(normalizeAccountId('bot@im.bot')).toBe('bot_im_bot');
      expect(normalizeAccountId('test:id.name')).toBe('test_id_name');
    });
  });

  // ── Text chunking ──

  describe('chunkText', () => {
    test('returns single chunk for short text', () => {
      expect(chunkText('hello', 4000)).toEqual(['hello']);
    });

    test('returns single chunk for empty string', () => {
      expect(chunkText('')).toEqual(['']);
    });

    test('splits at newline when possible', () => {
      const line = 'a'.repeat(3990) + '\n' + 'b'.repeat(100);
      const chunks = chunkText(line, 4000);
      expect(chunks.length).toBe(2);
      expect(chunks[0]).toBe('a'.repeat(3990));
    });

    test('splits at space when no newline', () => {
      const text = 'word '.repeat(900); // ~4500 chars
      const chunks = chunkText(text, 4000);
      expect(chunks.length).toBeGreaterThanOrEqual(2);
      expect(chunks[0].length).toBeLessThanOrEqual(4000);
    });

    test('hard-splits when no space or newline', () => {
      const text = 'x'.repeat(8500);
      const chunks = chunkText(text, 4000);
      expect(chunks.length).toBe(3);
      expect(chunks[0].length).toBe(4000);
      expect(chunks[1].length).toBe(4000);
      expect(chunks[2].length).toBe(500);
    });

    test('handles exact boundary', () => {
      const text = 'x'.repeat(4000);
      expect(chunkText(text, 4000)).toEqual([text]);
    });
  });

  // ── Markdown stripping ──

  describe('stripMarkdown', () => {
    test('removes bold', () => {
      expect(stripMarkdown('**hello**')).toBe('hello');
      expect(stripMarkdown('__hello__')).toBe('hello');
    });

    test('removes italic', () => {
      expect(stripMarkdown('*hello*')).toBe('hello');
    });

    test('converts links', () => {
      expect(stripMarkdown('[click](https://example.com)')).toBe('click (https://example.com)');
    });

    test('removes images', () => {
      expect(stripMarkdown('![alt](https://example.com/img.png)')).toBe('alt');
    });

    test('removes headers', () => {
      expect(stripMarkdown('## Title')).toBe('Title');
      expect(stripMarkdown('### Sub')).toBe('Sub');
    });

    test('removes code fences but keeps content', () => {
      const md = '```js\nconsole.log("hi");\n```';
      expect(stripMarkdown(md)).toBe('console.log("hi");');
    });

    test('removes inline code backticks', () => {
      expect(stripMarkdown('run `ls -la`')).toBe('run ls -la');
    });

    test('preserves plain text', () => {
      expect(stripMarkdown('just plain text')).toBe('just plain text');
    });
  });

  // ── Inbound message body extraction ──

  describe('bodyFromItemList', () => {
    test('extracts text items', () => {
      const items = [
        { type: ITEM_TYPE_TEXT, text_item: { text: 'hello' } },
        { type: ITEM_TYPE_TEXT, text_item: { text: 'world' } },
      ];
      expect(bodyFromItemList(items)).toBe('hello\nworld');
    });

    test('extracts voice transcription', () => {
      const items = [
        { type: ITEM_TYPE_VOICE, voice_item: { cdn_url: '', aes_key: '', duration: 5, text: '语音内容' } },
      ];
      expect(bodyFromItemList(items)).toBe('语音内容');
    });

    test('returns empty for non-text items', () => {
      const items = [{ type: 2 }]; // IMAGE with no text
      expect(bodyFromItemList(items)).toBe('');
    });
  });

  describe('extractQuotedText', () => {
    test('extracts quoted text', () => {
      const msg = {
        quote_message: {
          item_list: [{ type: ITEM_TYPE_TEXT, text_item: { text: 'original' } }],
        },
      };
      expect(extractQuotedText(msg)).toBe('[引用: original]');
    });

    test('returns undefined when no quote', () => {
      expect(extractQuotedText({})).toBeUndefined();
    });
  });
});
