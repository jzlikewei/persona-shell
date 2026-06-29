import { describe, expect, test, mock, beforeEach } from 'bun:test';
import { MessagingRouter } from '../messaging/messaging-router.js';
import type { MessagingClient, MessageHandler, IncomingMessage } from '../messaging/messaging.js';

function createFakeClient(options?: { canHandle?: (chatId: string) => boolean }): MessagingClient & {
  handlers: MessageHandler[];
  lastReply: { messageId: string; text: string } | null;
  lastSend: { chatId: string; text: string } | null;
} {
  const handlers: MessageHandler[] = [];
  return {
    handlers,
    lastReply: null,
    lastSend: null,
    start() {},
    onMessage(handler) { handlers.push(handler); },
    async reply(messageId, text) { this.lastReply = { messageId, text }; },
    async sendMessage(chatId, text) { this.lastSend = { chatId, text }; return null; },
    async addReaction() {},
    async uploadAndReplyImage() {},
    async uploadAndReplyFile() {},
    async uploadAndSendImage() { return null; },
    async uploadAndSendFile() { return null; },
    getLastChatId() { return null; },
    getConnectionStatus() { return 'connected' as const; },
    ...(options?.canHandle ? { canHandleChatId: options.canHandle } : {}),
  };
}

describe('MessagingRouter with weixin routing', () => {
  test('sendMessage routes weixin: chatId to weixin client', async () => {
    const feishu = createFakeClient();
    const weixin = createFakeClient({
      canHandle: (chatId: string) => chatId.startsWith('weixin:'),
    });

    const router = new MessagingRouter(feishu);
    router.addClient(weixin);

    await router.sendMessage('weixin:acct1:user1', 'hi weixin');
    expect(weixin.lastSend).toEqual({ chatId: 'weixin:acct1:user1', text: 'hi weixin' });
    expect(feishu.lastSend).toBeNull();
  });

  test('sendMessage routes non-weixin chatId to primary', async () => {
    const feishu = createFakeClient();
    const weixin = createFakeClient({
      canHandle: (chatId: string) => chatId.startsWith('weixin:'),
    });

    const router = new MessagingRouter(feishu);
    router.addClient(weixin);

    await router.sendMessage('oc_feishu_chat', 'hi feishu');
    expect(feishu.lastSend).toEqual({ chatId: 'oc_feishu_chat', text: 'hi feishu' });
    expect(weixin.lastSend).toBeNull();
  });

  test('reply routes to origin client via messageOrigin', async () => {
    const feishu = createFakeClient();
    const weixin = createFakeClient({
      canHandle: (chatId: string) => chatId.startsWith('weixin:'),
    });

    const router = new MessagingRouter(feishu);
    router.addClient(weixin);

    let routerHandler: MessageHandler | null = null;
    router.onMessage(async (msg) => { routerHandler = null; });

    // Simulate an incoming weixin message
    const weixinMsg: IncomingMessage = {
      text: 'hello',
      messageId: 'weixin:acct1:msg1',
      chatId: 'weixin:acct1:user1',
      chatType: 'p2p',
      channel: 'weixin',
    };
    for (const h of weixin.handlers) {
      await h(weixinMsg);
    }

    // Reply should go to weixin client
    await router.reply('weixin:acct1:msg1', 'reply text');
    expect(weixin.lastReply).toEqual({ messageId: 'weixin:acct1:msg1', text: 'reply text' });
    expect(feishu.lastReply).toBeNull();
  });

  test('getLastChatId tracks last p2p message across channels', async () => {
    const feishu = createFakeClient();
    const weixin = createFakeClient({
      canHandle: (chatId: string) => chatId.startsWith('weixin:'),
    });

    const router = new MessagingRouter(feishu);
    router.addClient(weixin);
    router.onMessage(async () => {});

    // Simulate p2p message from weixin
    const weixinMsg: IncomingMessage = {
      text: 'hello',
      messageId: 'weixin:acct1:msg1',
      chatId: 'weixin:acct1:user1',
      chatType: 'p2p',
      channel: 'weixin',
    };
    for (const h of weixin.handlers) await h(weixinMsg);

    expect(router.getLastChatId()).toBe('weixin:acct1:user1');
  });

  test('getLastChatId does not track group messages', async () => {
    const feishu = createFakeClient();
    const router = new MessagingRouter(feishu);
    router.onMessage(async () => {});

    const groupMsg: IncomingMessage = {
      text: 'hello',
      messageId: 'msg1',
      chatId: 'oc_group_123',
      chatType: 'group',
    };
    for (const h of feishu.handlers) await h(groupMsg);

    // No p2p message yet, falls through to primary
    expect(router.getLastChatId()).toBeNull();
  });

  test('stop calls stop on all clients', async () => {
    let feishuStopped = false;
    let weixinStopped = false;

    const feishu = createFakeClient();
    (feishu as MessagingClient).stop = async () => { feishuStopped = true; };

    const weixin = createFakeClient({
      canHandle: (chatId: string) => chatId.startsWith('weixin:'),
    });
    (weixin as MessagingClient).stop = async () => { weixinStopped = true; };

    const router = new MessagingRouter(feishu);
    router.addClient(weixin);

    await router.stop();
    expect(feishuStopped).toBe(true);
    expect(weixinStopped).toBe(true);
  });
});
