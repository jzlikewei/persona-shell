import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'fs';
import { initTaskStore, getState } from './task-store.js';
import { MessageQueue } from './queue.js';

const PERSONA_DIR = '/tmp/persona-queue-test';
const LOG_DIR = '/tmp/persona-queue-test/logs';

describe('MessageQueue restore policy', () => {
  beforeEach(() => {
    rmSync(PERSONA_DIR, { recursive: true, force: true });
    mkdirSync(LOG_DIR, { recursive: true });
    initTaskStore(PERSONA_DIR);
  });

  test('drops persisted items when restore is disabled', () => {
    const queue = new MessageQueue(`${LOG_DIR}/queue.log`, undefined, { restorable: false });
    queue.enqueue({ text: 'hello', messageId: 'm1', chatId: 'c1' });

    const restored = new MessageQueue(`${LOG_DIR}/queue.log`, undefined, { restorable: false });
    expect(restored.restoreFromState()).toBe(0);
    expect(restored.length).toBe(0);
    expect(getState('queue:main')).toBeNull();
  });

  test('restores persisted items when enabled', () => {
    const queue = new MessageQueue(`${LOG_DIR}/queue.log`);
    queue.enqueue({ text: 'hello', messageId: 'm1', chatId: 'c1' });

    const restored = new MessageQueue(`${LOG_DIR}/queue.log`);
    expect(restored.restoreFromState()).toBe(1);
    expect(restored.length).toBe(1);
  });
});
