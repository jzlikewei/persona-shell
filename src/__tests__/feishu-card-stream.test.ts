import { describe, expect, test } from 'bun:test';
import {
  FeishuCardStreamingReply,
  buildStreamingCard,
  type FeishuCard,
} from '../messaging/feishu-card-stream.js';

function createHarness(opts?: { failUpdates?: boolean }) {
  const updates: Array<{ messageId: string; card: FeishuCard }> = [];
  const fallbackReplies: Array<{ messageId: string; text: string }> = [];
  const logs: string[] = [];
  const handle = new FeishuCardStreamingReply({
    sourceMessageId: 'source-msg',
    cardMessageId: 'card-msg',
    updateCard: async (messageId, card) => {
      if (opts?.failUpdates) throw new Error('update failed');
      updates.push({ messageId, card });
    },
    fallbackReply: async (messageId, text) => {
      fallbackReplies.push({ messageId, text });
      return null;
    },
    logDebug: (message) => logs.push(message),
    debounceMs: 10_000,
    minUpdateChars: 5,
    botName: 'Persona',
    completeText: 'done',
    abortText: 'aborted',
  });
  return { handle, updates, fallbackReplies, logs };
}

async function drainStreamUpdate(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('FeishuCardStreamingReply', () => {
  test('builds Feishu interactive card payloads', () => {
    const card = buildStreamingCard({ botName: 'Persona', status: 'thinking', text: 'hello' });

    expect(card.schema).toBe('2.0');
    expect(card.config.wide_screen_mode).toBe(true);
    expect(card.header.title.content).toBe('Persona');
    expect(card.header.text_tag_list?.[0]?.text.content).toBe('思考中');
    expect(card.body.elements[0]).toEqual({ tag: 'markdown', content: 'hello' });
  });

  test('adds a cancel button only while the stream is active', () => {
    const active = buildStreamingCard({
      botName: 'Persona',
      status: 'streaming',
      text: 'hello',
      actionSourceMessageId: 'source-msg',
      actionCardMessageId: 'card-msg',
    });
    const done = buildStreamingCard({ botName: 'Persona', status: 'done', text: 'hello' });

    expect(JSON.stringify(active.body.elements)).toContain('persona_stream_cancel');
    expect(JSON.stringify(active.body.elements)).toContain('source-msg');
    expect(JSON.stringify(active.body.elements)).toContain('card-msg');
    expect(JSON.stringify(done.body.elements)).not.toContain('persona_stream_cancel');
  });

  test('updates the card message when appended text reaches the update threshold', async () => {
    const { handle, updates } = createHarness();

    handle.append('hello');
    await drainStreamUpdate();
    await handle.final('hello world');

    expect(updates.map((item) => item.messageId)).toEqual(['card-msg', 'card-msg']);
    expect(updates[0]?.card.header.text_tag_list?.[0]?.text.content).toBe('生成中');
    expect(updates[1]?.card.header.text_tag_list?.[0]?.text.content).toBe('完成');
    expect(updates[1]?.card.body.elements[0]).toEqual({ tag: 'markdown', content: 'hello world' });
  });

  test('shows a generic tool call indicator without tool details', async () => {
    const { handle, updates } = createHarness();

    handle.showToolCall();
    await drainStreamUpdate();
    await handle.final('all done');

    expect(updates[0]?.card.body.elements[0]).toEqual({
      tag: 'div',
      icon: { tag: 'standard_icon', token: 'loading_outlined', color: 'blue' },
      text: { tag: 'plain_text', content: '正在调用工具...' },
    });
    expect(JSON.stringify(updates[0]?.card)).not.toContain('bash');
    expect(updates.at(-1)?.card.body.elements).toEqual([{ tag: 'markdown', content: 'all done' }]);
  });

  test('final uses accumulated text when final text is blank', async () => {
    const { handle, updates } = createHarness();

    handle.append('hello');
    await handle.final('   ');

    expect(updates.at(-1)?.card.body.elements[0]).toEqual({ tag: 'markdown', content: 'hello' });
  });

  test('final coalesces pending streaming updates', async () => {
    const { handle, updates, logs } = createHarness();

    handle.append('hello');
    await handle.final('hello world');

    expect(updates.map((item) => item.card.header.text_tag_list?.[0]?.text.content)).toEqual(['完成']);
    expect(updates[0]?.card.body.elements[0]).toEqual({ tag: 'markdown', content: 'hello world' });
    expect(logs.some((line) => line.includes('coalesce drop status=streaming'))).toBe(true);
  });

  test('final falls back to replying to the source message when card update fails', async () => {
    const { handle, updates, fallbackReplies, logs } = createHarness({ failUpdates: true });

    handle.append('hello');
    await handle.final('final text');

    expect(updates).toEqual([]);
    expect(fallbackReplies).toEqual([{ messageId: 'source-msg', text: 'final text' }]);
    expect(logs.some((line) => line.includes('update skipped'))).toBe(true);
  });

  test('abort updates the card with interruption text and closes the handle', async () => {
    const { handle, updates } = createHarness();

    handle.append('hello');
    await drainStreamUpdate();
    await handle.abort('cancelled');
    handle.append(' ignored');
    await handle.final('ignored final');

    expect(updates.map((item) => item.card.header.text_tag_list?.[0]?.text.content)).toEqual([
      '生成中',
      '已中断',
    ]);
    expect(updates.at(-1)?.card.body.elements[0]).toEqual({ tag: 'markdown', content: 'cancelled' });
  });

  test('abort coalesces pending streaming updates', async () => {
    const { handle, updates } = createHarness();

    handle.append('hello');
    await handle.abort('cancelled');

    expect(updates.map((item) => item.card.header.text_tag_list?.[0]?.text.content)).toEqual(['已中断']);
    expect(updates[0]?.card.body.elements[0]).toEqual({ tag: 'markdown', content: 'cancelled' });
  });
});
