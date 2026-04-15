import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'fs';
import { initTaskStore, getState } from '../task/task-store.js';
import { MessageQueue } from '../queue.js';

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

describe('MessageQueue core operations', () => {
  beforeEach(() => {
    rmSync(PERSONA_DIR, { recursive: true, force: true });
    mkdirSync(LOG_DIR, { recursive: true });
    initTaskStore(PERSONA_DIR);
  });

  test('enqueue + resolve basic flow', () => {
    const queue = new MessageQueue(`${LOG_DIR}/queue.log`);
    const cid = queue.enqueue({ text: 'task-1', messageId: 'm1', chatId: 'c1' });
    expect(queue.length).toBe(1);
    expect(typeof cid).toBe('string');
    expect(cid.startsWith('cid-')).toBe(true);

    const resolved = queue.resolve(cid);
    expect(resolved).toBeDefined();
    expect(resolved!.text).toBe('task-1');
    expect(resolved!.correlationId).toBe(cid);
    expect(queue.length).toBe(0);
  });

  test('resolve returns undefined for unknown cid', () => {
    const queue = new MessageQueue(`${LOG_DIR}/queue.log`);
    expect(queue.resolve('cid-nonexistent')).toBeUndefined();
  });

  test('cancelOldest marks oldest non-cancelled item', () => {
    const queue = new MessageQueue(`${LOG_DIR}/queue.log`);
    const cid1 = queue.enqueue({ text: 'first', messageId: 'm1', chatId: 'c1' });
    const cid2 = queue.enqueue({ text: 'second', messageId: 'm2', chatId: 'c1' });

    const cancelled = queue.cancelOldest();
    expect(cancelled).toBeDefined();
    expect(cancelled!.correlationId).toBe(cid1);
    expect(cancelled!.cancelled).toBe(true);
    // Queue length unchanged — cancel doesn't remove
    expect(queue.length).toBe(2);

    // Cancel again should cancel the next non-cancelled
    const cancelled2 = queue.cancelOldest();
    expect(cancelled2!.correlationId).toBe(cid2);
  });

  test('cancelOldest returns undefined when all cancelled or empty', () => {
    const queue = new MessageQueue(`${LOG_DIR}/queue.log`);
    expect(queue.cancelOldest()).toBeUndefined();
  });

  test('resolveOldest skips cancelled items', () => {
    const queue = new MessageQueue(`${LOG_DIR}/queue.log`);
    const cid1 = queue.enqueue({ text: 'cancelled-one', messageId: 'm1', chatId: 'c1' });
    const cid2 = queue.enqueue({ text: 'active-one', messageId: 'm2', chatId: 'c1' });

    // Cancel the oldest
    queue.cancelOldest();

    // resolveOldest should skip the cancelled one and return the active one
    const resolved = queue.resolveOldest();
    expect(resolved).toBeDefined();
    expect(resolved!.correlationId).toBe(cid2);
    expect(resolved!.text).toBe('active-one');
    expect(queue.length).toBe(0); // both removed
  });

  test('resolveOldest returns undefined when all items cancelled', () => {
    const queue = new MessageQueue(`${LOG_DIR}/queue.log`);
    queue.enqueue({ text: 'a', messageId: 'm1', chatId: 'c1' });
    queue.cancelOldest();

    const resolved = queue.resolveOldest();
    expect(resolved).toBeUndefined();
    expect(queue.length).toBe(0);
  });

  test('clearAll returns all items and empties queue', () => {
    const queue = new MessageQueue(`${LOG_DIR}/queue.log`);
    queue.enqueue({ text: 'a', messageId: 'm1', chatId: 'c1' });
    queue.enqueue({ text: 'b', messageId: 'm2', chatId: 'c1' });
    queue.enqueue({ text: 'c', messageId: 'm3', chatId: 'c1' });

    const cleared = queue.clearAll();
    expect(cleared.length).toBe(3);
    expect(queue.length).toBe(0);
  });

  test('clearAll on empty queue returns empty array', () => {
    const queue = new MessageQueue(`${LOG_DIR}/queue.log`);
    expect(queue.clearAll()).toEqual([]);
  });

  test('getSnapshot returns items with text truncated to 50 chars', () => {
    const queue = new MessageQueue(`${LOG_DIR}/queue.log`);
    const longText = 'a'.repeat(100);
    queue.enqueue({ text: longText, messageId: 'm1', chatId: 'c1' });
    queue.enqueue({ text: 'short', messageId: 'm2', chatId: 'c1' });

    const snapshot = queue.getSnapshot();
    expect(snapshot.length).toBe(2);
    // Long text truncated
    expect(snapshot.find((s) => s.messageId === 'm1')!.text.length).toBe(50);
    // Short text preserved
    expect(snapshot.find((s) => s.messageId === 'm2')!.text).toBe('short');
    // All have cancelled field
    expect(snapshot.every((s) => s.cancelled === false)).toBe(true);
  });

  test('peek returns oldest item without removing it', () => {
    const queue = new MessageQueue(`${LOG_DIR}/queue.log`);
    queue.enqueue({ text: 'first', messageId: 'm1', chatId: 'c1' });
    queue.enqueue({ text: 'second', messageId: 'm2', chatId: 'c1' });

    const peeked = queue.peek();
    expect(peeked).toBeDefined();
    expect(peeked!.text).toBe('first');
    // Item still in queue
    expect(queue.length).toBe(2);

    // Peek again returns same item
    expect(queue.peek()!.correlationId).toBe(peeked!.correlationId);
  });

  test('peek returns undefined on empty queue', () => {
    const queue = new MessageQueue(`${LOG_DIR}/queue.log`);
    expect(queue.peek()).toBeUndefined();
  });

  test('multiple items ordered by timestamp', () => {
    const queue = new MessageQueue(`${LOG_DIR}/queue.log`);
    // Enqueue in rapid succession — timestamps should be ordered
    const cid1 = queue.enqueue({ text: 'first', messageId: 'm1', chatId: 'c1' });
    const cid2 = queue.enqueue({ text: 'second', messageId: 'm2', chatId: 'c1' });
    const cid3 = queue.enqueue({ text: 'third', messageId: 'm3', chatId: 'c1' });

    // peek and resolveOldest should return in order
    expect(queue.peek()!.text).toBe('first');

    const r1 = queue.resolveOldest();
    expect(r1!.text).toBe('first');

    const r2 = queue.resolveOldest();
    expect(r2!.text).toBe('second');

    const r3 = queue.resolveOldest();
    expect(r3!.text).toBe('third');

    expect(queue.length).toBe(0);
  });
});
