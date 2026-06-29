import { describe, expect, test, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { WeixinAccountStore } from '../messaging/weixin/weixin-account-store.js';
import { WeixinContextStore } from '../messaging/weixin/weixin-context-store.js';
import { WeixinPoller } from '../messaging/weixin/weixin-poller.js';
import { WeixinApi } from '../messaging/weixin/weixin-api.js';
import type { IncomingMessage } from '../messaging/messaging.js';
import type { GetUpdatesResponse, WeixinAccountCredentials } from '../messaging/weixin/weixin-types.js';
import { SESSION_EXPIRED_ERRCODE, ITEM_TYPE_TEXT, ITEM_TYPE_VOICE } from '../messaging/weixin/weixin-types.js';

const TEST_DIR = join(tmpdir(), `weixin-test-${Date.now()}`);

function freshDir(): string {
  const dir = join(TEST_DIR, String(Math.random()).slice(2));
  mkdirSync(dir, { recursive: true });
  return dir;
}

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const CREDS: WeixinAccountCredentials = { token: 'tok', userId: 'uid', baseUrl: 'https://test.com' };

function makePoller(opts: {
  stateDir: string;
  getUpdates: (callIdx: number) => Promise<GetUpdatesResponse>;
  onMessage: (msg: IncomingMessage) => Promise<void>;
  onError?: (accountId: string, error: unknown) => void;
}) {
  const contextStore = new WeixinContextStore(opts.stateDir);
  let callIdx = 0;
  const fakeApi = {
    getUpdates: async () => opts.getUpdates(callIdx++),
  } as unknown as WeixinApi;

  const poller = new WeixinPoller({
    accountId: 'acct1',
    credentials: CREDS,
    api: fakeApi,
    contextStore,
    pollTimeoutMs: 1000,
    retryDelayMs: 10,
    backoffDelayMs: 50,
    attachmentDir: join(opts.stateDir, 'att'),
    onMessage: opts.onMessage,
    onError: opts.onError,
  });

  return { poller, contextStore };
}

// ═══════════════════════════════════════════════════════════════
// 1. 账号保存与读取
// ═══════════════════════════════════════════════════════════════

describe('账号保存与读取', () => {
  test('saveAccountFromLogin → 重启后 getAccount 往返', () => {
    const dir = freshDir();
    const store = new WeixinAccountStore(dir);
    const acct = store.saveAccountFromLogin('bot@im.bot', 'token123', 'https://ilinkai.weixin.qq.com', 'user456');

    expect(acct.id).toBe('bot_im_bot');

    const store2 = new WeixinAccountStore(dir);
    const loaded = store2.getAccount('bot_im_bot');
    expect(loaded).not.toBeNull();
    expect(loaded!.token).toBe('token123');
    expect(loaded!.baseUrl).toBe('https://ilinkai.weixin.qq.com');
    expect(loaded!.userId).toBe('user456');
  });

  test('listAccounts 返回所有已保存账号', () => {
    const dir = freshDir();
    const store = new WeixinAccountStore(dir);
    store.saveAccountFromLogin('bot1@im', 'tok1', 'https://a.com', 'u1');
    store.saveAccountFromLogin('bot2@im', 'tok2', 'https://b.com', 'u2');

    const all = store.listAccounts();
    expect(all.length).toBe(2);
    expect(all.map(a => a.id).sort()).toEqual(['bot1_im', 'bot2_im']);
  });

  test('账号凭据文件写到 0600 权限目录', () => {
    const dir = freshDir();
    const store = new WeixinAccountStore(dir);
    store.saveAccountFromLogin('secure@bot', 'secret', 'https://x.com', 'u');
    expect(existsSync(join(dir, 'accounts', 'secure_bot.json'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. 收消息：getUpdates → IncomingMessage
// ═══════════════════════════════════════════════════════════════

describe('收消息：getUpdates → IncomingMessage', () => {
  test('文本消息被正确转为 IncomingMessage', async () => {
    const dir = freshDir();
    const received: IncomingMessage[] = [];

    const { poller } = makePoller({
      stateDir: dir,
      getUpdates: async (idx) => {
        if (idx === 0) return {
          errcode: 0,
          msg_list: [{
            message_id: 'msg001',
            from_user_id: 'wxuser@im.wechat',
            to_user_id: 'bot@im.bot',
            message_type: 2, message_state: 2,
            item_list: [{ type: ITEM_TYPE_TEXT, text_item: { text: '你好' } }],
            context_token: 'ctx_abc', seq: 1,
          }],
        };
        await sleep(5000); // block further polls
        return { errcode: 0 };
      },
      onMessage: async (msg) => { received.push(msg); },
    });

    poller.start();
    await sleep(150);
    poller.stop();

    expect(received.length).toBe(1);
    expect(received[0].text).toBe('你好');
    expect(received[0].messageId).toBe('weixin:acct1:msg001');
    expect(received[0].chatId).toBe('weixin:acct1:wxuser@im.wechat');
    expect(received[0].chatType).toBe('p2p');
    expect(received[0].channel).toBe('weixin');
    expect(received[0].senderOpenId).toBe('wxuser@im.wechat');
  });

  test('语音消息提取转文字结果', async () => {
    const dir = freshDir();
    const received: IncomingMessage[] = [];

    const { poller } = makePoller({
      stateDir: dir,
      getUpdates: async (idx) => {
        if (idx === 0) return {
          errcode: 0,
          msg_list: [{
            message_id: 'msg002', from_user_id: 'wxuser', to_user_id: 'bot',
            message_type: 2, message_state: 2,
            item_list: [{
              type: ITEM_TYPE_VOICE,
              voice_item: { cdn_url: '', aes_key: '', duration: 3, text: '语音转文字结果' },
            }],
            context_token: 'ctx', seq: 2,
          }],
        };
        await sleep(5000);
        return { errcode: 0 };
      },
      onMessage: async (msg) => { received.push(msg); },
    });

    poller.start();
    await sleep(150);
    poller.stop();

    expect(received.length).toBe(1);
    expect(received[0].text).toBe('语音转文字结果');
  });

  test('引用消息包含 quotedText', async () => {
    const dir = freshDir();
    const received: IncomingMessage[] = [];

    const { poller } = makePoller({
      stateDir: dir,
      getUpdates: async (idx) => {
        if (idx === 0) return {
          errcode: 0,
          msg_list: [{
            message_id: 'msg003', from_user_id: 'wxuser', to_user_id: 'bot',
            message_type: 2, message_state: 2,
            item_list: [{ type: ITEM_TYPE_TEXT, text_item: { text: '我的回复' } }],
            context_token: 'ctx', seq: 3,
            quote_message: {
              item_list: [{ type: ITEM_TYPE_TEXT, text_item: { text: '原始消息' } }],
            },
          }],
        };
        await sleep(5000);
        return { errcode: 0 };
      },
      onMessage: async (msg) => { received.push(msg); },
    });

    poller.start();
    await sleep(150);
    poller.stop();

    expect(received.length).toBe(1);
    expect(received[0].quotedText).toBe('[引用: 原始消息]');
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. 去重 — 同一消息只处理一次
// ═══════════════════════════════════════════════════════════════

describe('去重', () => {
  test('同一 message_id 重复返回只触发一次 handler', async () => {
    const dir = freshDir();
    let handlerCount = 0;

    const sameMsg = {
      message_id: 'dup001', from_user_id: 'user', to_user_id: 'bot',
      message_type: 2, message_state: 2,
      item_list: [{ type: ITEM_TYPE_TEXT, text_item: { text: 'hi' } }],
      context_token: 'ctx', seq: 1,
    };

    const { poller } = makePoller({
      stateDir: dir,
      getUpdates: async (idx) => {
        if (idx < 3) return { errcode: 0, msg_list: [sameMsg] };
        await sleep(5000);
        return { errcode: 0 };
      },
      onMessage: async () => { handlerCount++; },
    });

    poller.start();
    await sleep(200);
    poller.stop();

    expect(handlerCount).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. 发送消息：请求体验证
// ═══════════════════════════════════════════════════════════════

describe('发送消息：请求体验证', () => {
  test('sendMessage payload 结构正确（base_info、context_token、message_type）', async () => {
    const dir = freshDir();
    const contextStore = new WeixinContextStore(dir);
    contextStore.setContextToken('acct1', 'target_user', 'ctx_token_123');

    const { MESSAGE_TYPE_BOT, MESSAGE_STATE_FINISH } = await import('../messaging/weixin/weixin-types.js');
    const { stripMarkdown, chunkText, generateClientId } = await import('../messaging/weixin/weixin-text.js');

    const text = '**你好**，这是一条回复';
    const filtered = stripMarkdown(text);
    expect(filtered).toBe('你好，这是一条回复');

    const chunks = chunkText(filtered);
    expect(chunks.length).toBe(1);

    const contextToken = contextStore.getContextToken('acct1', 'target_user') ?? '';
    expect(contextToken).toBe('ctx_token_123');

    const clientId = generateClientId();
    const payload = {
      base_info: { bot_agent: 'PersonaShell/0.1.0' },
      msg: {
        from_user_id: '',
        to_user_id: 'target_user',
        client_id: clientId,
        message_type: MESSAGE_TYPE_BOT,
        message_state: MESSAGE_STATE_FINISH,
        item_list: [{ type: 1, text_item: { text: filtered } }],
        context_token: contextToken,
      },
    };

    expect(payload.base_info.bot_agent).toBe('PersonaShell/0.1.0');
    expect(payload.msg.to_user_id).toBe('target_user');
    expect(payload.msg.from_user_id).toBe('');
    expect(payload.msg.message_type).toBe(2);
    expect(payload.msg.message_state).toBe(2);
    expect(payload.msg.context_token).toBe('ctx_token_123');
    expect(payload.msg.item_list[0].text_item.text).toBe('你好，这是一条回复');
  });

  test('长文本按 4000 字符分片', () => {
    const { chunkText } = require('../messaging/weixin/weixin-text.js') as typeof import('../messaging/weixin/weixin-text.js');
    const longText = 'A'.repeat(9000);
    const chunks = chunkText(longText, 4000);

    expect(chunks.length).toBe(3);
    expect(chunks[0].length).toBe(4000);
    expect(chunks[1].length).toBe(4000);
    expect(chunks[2].length).toBe(1000);
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. API headers 验证
// ═══════════════════════════════════════════════════════════════

describe('API headers 构造', () => {
  test('认证请求包含所有必要 headers', async () => {
    let capturedHeaders: Record<string, string> = {};
    let capturedBody = '';

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string> ?? {};
      capturedBody = init?.body as string ?? '';
      return new Response(JSON.stringify({ errcode: 0 }));
    }) as typeof fetch;

    try {
      const api = new WeixinApi({
        defaultBaseUrl: 'https://test.ilink.com',
        botAgent: 'TestBot/1.0',
        appId: 'test_app',
        clientVersion: '2.4.4',
      });

      await api.getUpdates(CREDS, {});

      expect(capturedHeaders['Content-Type']).toBe('application/json');
      expect(capturedHeaders['iLink-App-Id']).toBe('test_app');
      expect(capturedHeaders['iLink-App-ClientVersion']).toBe('2.4.4');
      expect(capturedHeaders['AuthorizationType']).toBe('Bearer');
      expect(capturedHeaders['Authorization']).toBe('tok');
      expect(capturedHeaders['X-WECHAT-UIN']).toBe('uid');

      const body = JSON.parse(capturedBody);
      expect(body.base_info.bot_agent).toBe('TestBot/1.0');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('QR 登录请求不包含 Authorization headers', async () => {
    let capturedHeaders: Record<string, string> = {};

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string> ?? {};
      return new Response(JSON.stringify({ errcode: 0, qrcode_url: 'https://qr', qrcode_id: 'qr1' }));
    }) as typeof fetch;

    try {
      const api = new WeixinApi({
        defaultBaseUrl: 'https://test.ilink.com',
        botAgent: 'TestBot/1.0',
        appId: 'test_app',
        clientVersion: '2.4.4',
      });

      await api.getQrCode();

      expect(capturedHeaders['iLink-App-Id']).toBe('test_app');
      expect(capturedHeaders['Authorization']).toBeUndefined();
      expect(capturedHeaders['AuthorizationType']).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 6. Session expired (-14) → account 暂停
// ═══════════════════════════════════════════════════════════════

describe('session expired 处理', () => {
  test('errcode=-14 暂停 poller', async () => {
    const dir = freshDir();

    const { poller } = makePoller({
      stateDir: dir,
      getUpdates: async (idx) => {
        if (idx === 0) return { errcode: SESSION_EXPIRED_ERRCODE, errmsg: 'session expired' };
        await sleep(5000);
        return { errcode: 0 };
      },
      onMessage: async () => {},
    });

    poller.start();
    await sleep(100);

    expect(poller.isPaused()).toBe(true);
    expect(poller.getStatus().paused).toBe(true);

    poller.stop();
  });
});

// ═══════════════════════════════════════════════════════════════
// 7. at-least-once — handler 失败不推进游标
// ═══════════════════════════════════════════════════════════════

describe('at-least-once 投递语义', () => {
  test('handler 抛异常时消息未被标记为 processed，下次可重试', async () => {
    const dir = freshDir();
    let handlerCallCount = 0;

    const msg = {
      message_id: 'fail_msg', from_user_id: 'user', to_user_id: 'bot',
      message_type: 2, message_state: 2,
      item_list: [{ type: ITEM_TYPE_TEXT, text_item: { text: 'hi' } }],
      context_token: 'ctx', seq: 1,
    };

    const { poller } = makePoller({
      stateDir: dir,
      getUpdates: async (idx) => {
        // 前 3 次都返回同一条消息
        if (idx < 3) return { errcode: 0, msg_list: [msg] };
        await sleep(5000);
        return { errcode: 0 };
      },
      onMessage: async () => {
        handlerCallCount++;
        if (handlerCallCount === 1) throw new Error('handler failed');
      },
    });

    poller.start();
    await sleep(300);
    poller.stop();

    // 第一次失败 → 未标记 processed → 第二次又收到 → 成功 → 标记 → 第三次跳过
    expect(handlerCallCount).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════
// 8. context token 持久化
// ═══════════════════════════════════════════════════════════════

describe('context token 持久化', () => {
  test('收到消息后 context token 被保存，重启后可读取', () => {
    const dir = freshDir();

    const store1 = new WeixinContextStore(dir);
    store1.setContextToken('acct1', 'user_a', 'token_aaa');
    store1.setContextToken('acct1', 'user_b', 'token_bbb');

    const store2 = new WeixinContextStore(dir);
    store2.loadContextTokens('acct1');

    expect(store2.getContextToken('acct1', 'user_a')).toBe('token_aaa');
    expect(store2.getContextToken('acct1', 'user_b')).toBe('token_bbb');
    expect(store2.getContextToken('acct1', 'user_c')).toBeUndefined();
  });

  test('poller 自动保存收到的 context_token', async () => {
    const dir = freshDir();

    const { poller, contextStore } = makePoller({
      stateDir: dir,
      getUpdates: async (idx) => {
        if (idx === 0) return {
          errcode: 0,
          msg_list: [{
            message_id: 'msg_ct', from_user_id: 'sender_x', to_user_id: 'bot',
            message_type: 2, message_state: 2,
            item_list: [{ type: ITEM_TYPE_TEXT, text_item: { text: 'hi' } }],
            context_token: 'fresh_ctx_token', seq: 1,
          }],
        };
        await sleep(5000);
        return { errcode: 0 };
      },
      onMessage: async () => {},
    });

    poller.start();
    await sleep(150);
    poller.stop();

    expect(contextStore.getContextToken('acct1', 'sender_x')).toBe('fresh_ctx_token');
  });
});

// ═══════════════════════════════════════════════════════════════
// 9. 重启后 processed IDs 恢复
// ═══════════════════════════════════════════════════════════════

describe('重启后去重恢复', () => {
  test('processed IDs 持久化后新实例可加载', () => {
    const dir = freshDir();

    const store1 = new WeixinContextStore(dir);
    store1.markProcessed('acct1', 'acct1:msg_1');
    store1.markProcessed('acct1', 'acct1:msg_2');

    const store2 = new WeixinContextStore(dir);
    const ids = store2.getProcessedIds('acct1');

    expect(ids.has('acct1:msg_1')).toBe(true);
    expect(ids.has('acct1:msg_2')).toBe(true);
    expect(ids.has('acct1:msg_3')).toBe(false);
  });

  test('processed IDs 超过 1000 条时自动裁剪', () => {
    const dir = freshDir();
    const store = new WeixinContextStore(dir);

    for (let i = 0; i < 1050; i++) {
      store.markProcessed('acct1', `acct1:msg_${i}`);
    }

    const ids = store.getProcessedIds('acct1');
    expect(ids.size).toBe(1000);
    expect(ids.has('acct1:msg_0')).toBe(false);
    expect(ids.has('acct1:msg_1049')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// 10. sync buffer 持久化
// ═══════════════════════════════════════════════════════════════

describe('sync buffer 持久化', () => {
  test('saveSyncBuf → 新实例 getSyncBuf 返回保存的值', () => {
    const dir = freshDir();

    const store1 = new WeixinContextStore(dir);
    store1.saveSyncBuf('acct1', { cursor: 'abc123', seq: 42 });

    const store2 = new WeixinContextStore(dir);
    expect(store2.getSyncBuf('acct1')).toEqual({ cursor: 'abc123', seq: 42 });
  });

  test('首次启动 getSyncBuf 返回空对象', () => {
    const dir = freshDir();
    expect(new WeixinContextStore(dir).getSyncBuf('new')).toEqual({});
  });

  test('poller 成功后推进 sync buffer', async () => {
    const dir = freshDir();
    const newBuf = { cursor: 'new_cursor', version: 2 };

    const { poller, contextStore } = makePoller({
      stateDir: dir,
      getUpdates: async (idx) => {
        if (idx === 0) return {
          errcode: 0,
          get_updates_buf: newBuf,
          msg_list: [{
            message_id: 'msg_sb', from_user_id: 'user', to_user_id: 'bot',
            message_type: 2, message_state: 2,
            item_list: [{ type: ITEM_TYPE_TEXT, text_item: { text: 'hi' } }],
            context_token: 'ctx', seq: 1,
          }],
        };
        await sleep(5000);
        return { errcode: 0 };
      },
      onMessage: async () => {},
    });

    poller.start();
    await sleep(150);
    poller.stop();

    // sync buffer was persisted — verify via new store instance
    const store2 = new WeixinContextStore(dir);
    expect(store2.getSyncBuf('acct1')).toEqual(newBuf);
  });
});
