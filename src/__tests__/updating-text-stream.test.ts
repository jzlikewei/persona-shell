import { describe, expect, test } from 'bun:test';
import { UpdatingTextStreamingReply } from '../messaging/updating-text-stream.js';

function createHarness(opts?: { failUpdates?: boolean }) {
  const updates: Array<{ messageId: string; text: string }> = [];
  const fallbackReplies: Array<{ messageId: string; text: string }> = [];
  const logs: string[] = [];
  const handle = new UpdatingTextStreamingReply({
    sourceMessageId: 'source-msg',
    streamMessageId: 'stream-msg',
    updateText: async (messageId, text) => {
      if (opts?.failUpdates) throw new Error('update failed');
      updates.push({ messageId, text });
    },
    fallbackReply: async (messageId, text) => {
      fallbackReplies.push({ messageId, text });
      return null;
    },
    logDebug: (message) => logs.push(message),
    debounceMs: 10_000,
    minUpdateChars: 5,
    completeText: 'done',
    abortText: 'aborted',
  });
  return { handle, updates, fallbackReplies, logs };
}

describe('UpdatingTextStreamingReply', () => {
  test('updates the stream message when appended text reaches the update threshold', async () => {
    const { handle, updates } = createHarness();

    handle.append('hello');
    await handle.final('hello world');

    expect(updates).toEqual([
      { messageId: 'stream-msg', text: 'hello' },
      { messageId: 'stream-msg', text: 'hello world' },
    ]);
  });

  test('final uses accumulated text when final text is blank', async () => {
    const { handle, updates } = createHarness();

    handle.append('hello');
    await handle.final('   ');

    expect(updates.at(-1)).toEqual({ messageId: 'stream-msg', text: 'hello' });
  });

  test('final falls back to replying to the source message when update fails', async () => {
    const { handle, updates, fallbackReplies, logs } = createHarness({ failUpdates: true });

    handle.append('hello');
    await handle.final('final text');

    expect(updates).toEqual([]);
    expect(fallbackReplies).toEqual([{ messageId: 'source-msg', text: 'final text' }]);
    expect(logs.some((line) => line.includes('update skipped'))).toBe(true);
  });

  test('abort updates the stream message with interruption text and closes the handle', async () => {
    const { handle, updates } = createHarness();

    handle.append('hello');
    await handle.abort('cancelled');
    handle.append(' ignored');
    await handle.final('ignored final');

    expect(updates).toEqual([
      { messageId: 'stream-msg', text: 'hello' },
      { messageId: 'stream-msg', text: 'cancelled' },
    ]);
  });
});
