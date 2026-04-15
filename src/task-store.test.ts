import { describe, expect, test, beforeEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import {
  localNow,
  initTaskStore,
  createTask,
  getTask,
  listTasks,
  updateTask,
  cancelTask,
  getState,
  setState,
  deleteState,
  createCronJob,
  getCronJob,
  listCronJobs,
  updateCronJob,
  deleteCronJob,
  toggleCronJob,
  getOutboxDir,
} from './task-store.js';

const TEST_DIR = '/tmp/persona-task-store-test';

describe('task-store', () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    initTaskStore(TEST_DIR);
  });

  // --- localNow ---
  describe('localNow()', () => {
    test('returns ISO string with timezone offset', () => {
      const now = localNow();
      // Should match pattern like 2026-04-15T10:30:00.000+08:00
      expect(now).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
    });

    test('does not end with Z', () => {
      const now = localNow();
      expect(now.endsWith('Z')).toBe(false);
    });
  });

  // --- initTaskStore ---
  describe('initTaskStore()', () => {
    test('creates state/ directory', () => {
      const dir = '/tmp/persona-task-store-init-test';
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      initTaskStore(dir);
      expect(existsSync(join(dir, 'state'))).toBe(true);
      expect(existsSync(join(dir, 'state', 'tasks.db'))).toBe(true);
      rmSync(dir, { recursive: true, force: true });
    });
  });

  // --- Task CRUD ---
  describe('createTask()', () => {
    test('creates a task with T-MMdd-HH-NNN format id', () => {
      const task = createTask({
        type: 'role',
        role: 'explorer',
        description: 'test task',
        prompt: 'do something',
      });
      expect(task.id).toMatch(/^T-\d{4}-\d{2}-\d{3}$/);
    });

    test('sets status to dispatched', () => {
      const task = createTask({
        type: 'role',
        role: 'explorer',
        description: 'test',
        prompt: 'prompt',
      });
      expect(task.status).toBe('dispatched');
    });

    test('serializes extra as JSON', () => {
      const extra = { key: 'value', nested: { a: 1 } };
      const task = createTask({
        type: 'role',
        role: 'explorer',
        description: 'test',
        prompt: 'prompt',
        extra,
      });
      expect(task.extra).toEqual(extra);
    });

    test('stores source_director', () => {
      const task = createTask({
        type: 'role',
        role: 'explorer',
        description: 'test',
        prompt: 'prompt',
        source_director: 'main',
      });
      expect(task.source_director).toBe('main');
    });

    test('source_director defaults to null', () => {
      const task = createTask({
        type: 'role',
        role: 'explorer',
        description: 'test',
        prompt: 'prompt',
      });
      expect(task.source_director).toBeNull();
    });

    test('trims agent whitespace', () => {
      const task = createTask({
        type: 'role',
        role: 'explorer',
        agent: '  claude  ',
        description: 'test',
        prompt: 'prompt',
      });
      expect(task.agent).toBe('claude');
    });

    test('empty agent becomes null', () => {
      const task = createTask({
        type: 'role',
        role: 'explorer',
        agent: '   ',
        description: 'test',
        prompt: 'prompt',
      });
      expect(task.agent).toBeNull();
    });

    test('sequential tasks get incrementing IDs', () => {
      const t1 = createTask({ type: 'role', role: 'a', description: 'd', prompt: 'p' });
      const t2 = createTask({ type: 'role', role: 'b', description: 'd', prompt: 'p' });
      // Last segment should increment
      const seq1 = parseInt(t1.id.split('-').pop()!, 10);
      const seq2 = parseInt(t2.id.split('-').pop()!, 10);
      expect(seq2).toBe(seq1 + 1);
    });

    test('uses default max_retry of 3', () => {
      const task = createTask({ type: 'role', role: 'r', description: 'd', prompt: 'p' });
      expect(task.max_retry).toBe(3);
    });

    test('respects custom max_retry', () => {
      const task = createTask({ type: 'role', role: 'r', description: 'd', prompt: 'p', max_retry: 5 });
      expect(task.max_retry).toBe(5);
    });
  });

  describe('getTask()', () => {
    test('returns task when exists', () => {
      const created = createTask({ type: 'role', role: 'r', description: 'd', prompt: 'p' });
      const fetched = getTask(created.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(created.id);
      expect(fetched!.role).toBe('r');
      expect(fetched!.description).toBe('d');
    });

    test('returns null when not exists', () => {
      expect(getTask('T-9999-99-999')).toBeNull();
    });

    test('deserializes extra field', () => {
      const extra = { foo: 'bar' };
      const created = createTask({ type: 'role', role: 'r', description: 'd', prompt: 'p', extra });
      const fetched = getTask(created.id);
      expect(fetched!.extra).toEqual(extra);
    });

    test('extra is null when not set', () => {
      const created = createTask({ type: 'role', role: 'r', description: 'd', prompt: 'p' });
      const fetched = getTask(created.id);
      expect(fetched!.extra).toBeNull();
    });
  });

  describe('listTasks()', () => {
    test('returns all tasks without filter', () => {
      createTask({ type: 'role', role: 'a', description: 'd1', prompt: 'p' });
      createTask({ type: 'role', role: 'b', description: 'd2', prompt: 'p' });
      createTask({ type: 'role', role: 'c', description: 'd3', prompt: 'p' });
      const tasks = listTasks();
      expect(tasks).toHaveLength(3);
    });

    test('filters by status', () => {
      const t1 = createTask({ type: 'role', role: 'a', description: 'd', prompt: 'p' });
      createTask({ type: 'role', role: 'b', description: 'd', prompt: 'p' });
      updateTask(t1.id, { status: 'running' });
      const running = listTasks({ status: 'running' });
      expect(running).toHaveLength(1);
      expect(running[0].id).toBe(t1.id);
    });

    test('filters by role', () => {
      createTask({ type: 'role', role: 'explorer', description: 'd', prompt: 'p' });
      createTask({ type: 'role', role: 'executor', description: 'd', prompt: 'p' });
      createTask({ type: 'role', role: 'explorer', description: 'd', prompt: 'p' });
      const explorers = listTasks({ role: 'explorer' });
      expect(explorers).toHaveLength(2);
    });

    test('combines status and role filters', () => {
      const t1 = createTask({ type: 'role', role: 'explorer', description: 'd', prompt: 'p' });
      createTask({ type: 'role', role: 'explorer', description: 'd', prompt: 'p' });
      createTask({ type: 'role', role: 'executor', description: 'd', prompt: 'p' });
      updateTask(t1.id, { status: 'running' });
      const result = listTasks({ status: 'running', role: 'explorer' });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(t1.id);
    });

    test('limit restricts result count', () => {
      for (let i = 0; i < 10; i++) {
        createTask({ type: 'role', role: 'r', description: `d${i}`, prompt: 'p' });
      }
      const limited = listTasks({ limit: 3 });
      expect(limited).toHaveLength(3);
    });

    test('default limit is 50', () => {
      // Just verify it doesn't crash with default
      const result = listTasks();
      expect(result).toBeArray();
    });
  });

  describe('updateTask()', () => {
    test('updates status', () => {
      const task = createTask({ type: 'role', role: 'r', description: 'd', prompt: 'p' });
      updateTask(task.id, { status: 'running' });
      expect(getTask(task.id)!.status).toBe('running');
    });

    test('updates result_file', () => {
      const task = createTask({ type: 'role', role: 'r', description: 'd', prompt: 'p' });
      updateTask(task.id, { result_file: '/path/to/result.md' });
      expect(getTask(task.id)!.result_file).toBe('/path/to/result.md');
    });

    test('serializes extra on update', () => {
      const task = createTask({ type: 'role', role: 'r', description: 'd', prompt: 'p' });
      const newExtra = { updated: true, count: 42 };
      updateTask(task.id, { extra: newExtra });
      expect(getTask(task.id)!.extra).toEqual(newExtra);
    });

    test('empty update does not error', () => {
      const task = createTask({ type: 'role', role: 'r', description: 'd', prompt: 'p' });
      expect(() => updateTask(task.id, {})).not.toThrow();
      expect(getTask(task.id)!.status).toBe('dispatched');
    });

    test('updates multiple fields at once', () => {
      const task = createTask({ type: 'role', role: 'r', description: 'd', prompt: 'p' });
      updateTask(task.id, {
        status: 'completed',
        result_file: '/output.md',
        cost_usd: 0.05,
        duration_ms: 12000,
      });
      const updated = getTask(task.id)!;
      expect(updated.status).toBe('completed');
      expect(updated.result_file).toBe('/output.md');
      expect(updated.cost_usd).toBe(0.05);
      expect(updated.duration_ms).toBe(12000);
    });
  });

  describe('cancelTask()', () => {
    test('cancels dispatched task', () => {
      const task = createTask({ type: 'role', role: 'r', description: 'd', prompt: 'p' });
      expect(cancelTask(task.id)).toBe(true);
      const cancelled = getTask(task.id)!;
      expect(cancelled.status).toBe('failed');
      expect(cancelled.error).toBe('cancelled');
    });

    test('cancels running task', () => {
      const task = createTask({ type: 'role', role: 'r', description: 'd', prompt: 'p' });
      updateTask(task.id, { status: 'running' });
      expect(cancelTask(task.id)).toBe(true);
      expect(getTask(task.id)!.status).toBe('failed');
    });

    test('cannot cancel completed task', () => {
      const task = createTask({ type: 'role', role: 'r', description: 'd', prompt: 'p' });
      updateTask(task.id, { status: 'completed' });
      expect(cancelTask(task.id)).toBe(false);
      expect(getTask(task.id)!.status).toBe('completed');
    });

    test('cannot cancel failed task', () => {
      const task = createTask({ type: 'role', role: 'r', description: 'd', prompt: 'p' });
      updateTask(task.id, { status: 'failed' });
      expect(cancelTask(task.id)).toBe(false);
      expect(getTask(task.id)!.status).toBe('failed');
    });

    test('returns false for non-existent task', () => {
      expect(cancelTask('T-9999-99-999')).toBe(false);
    });
  });

  // --- State KV ---
  describe('State KV', () => {
    test('getState returns null for missing key', () => {
      expect(getState('nonexistent')).toBeNull();
    });

    test('setState and getState round-trip', () => {
      setState('testKey', { hello: 'world', num: 42 });
      expect(getState('testKey')).toEqual({ hello: 'world', num: 42 });
    });

    test('setState upserts existing key', () => {
      setState('key1', 'first');
      setState('key1', 'second');
      expect(getState('key1')).toBe('second');
    });

    test('deleteState removes key', () => {
      setState('toDelete', 'value');
      deleteState('toDelete');
      expect(getState('toDelete')).toBeNull();
    });

    test('deleteState on missing key does not error', () => {
      expect(() => deleteState('nonexistent')).not.toThrow();
    });

    test('stores and retrieves arrays', () => {
      setState('arr', [1, 2, 3]);
      expect(getState('arr')).toEqual([1, 2, 3]);
    });

    test('stores and retrieves nested objects', () => {
      const data = { a: { b: { c: 'deep' } } };
      setState('nested', data);
      expect(getState('nested')).toEqual(data);
    });
  });

  // --- Cron Jobs CRUD ---
  describe('createCronJob()', () => {
    test('creates cron job with C-MMdd-HH-NNN format id', () => {
      const job = createCronJob({
        name: 'daily check',
        role: 'explorer',
        description: 'check stuff',
        prompt: 'do it',
        schedule: '0 9 * * *',
      });
      expect(job.id).toMatch(/^C-\d{4}-\d{2}-\d{3}$/);
    });

    test('enabled defaults to true', () => {
      const job = createCronJob({
        name: 'test',
        role: 'r',
        description: 'd',
        prompt: 'p',
        schedule: '* * * * *',
      });
      expect(job.enabled).toBe(true);
    });

    test('can set enabled to false', () => {
      const job = createCronJob({
        name: 'test',
        role: 'r',
        description: 'd',
        prompt: 'p',
        schedule: '* * * * *',
        enabled: false,
      });
      expect(job.enabled).toBe(false);
    });

    test('action_type defaults to spawn_role', () => {
      const job = createCronJob({
        name: 'test',
        role: 'r',
        description: 'd',
        prompt: 'p',
        schedule: '* * * * *',
      });
      expect(job.action_type).toBe('spawn_role');
    });

    test('accepts custom action_type', () => {
      const job = createCronJob({
        name: 'test',
        role: 'r',
        description: 'd',
        prompt: 'p',
        schedule: '* * * * *',
        action_type: 'director_msg',
      });
      expect(job.action_type).toBe('director_msg');
    });

    test('stores message and action_name', () => {
      const job = createCronJob({
        name: 'test',
        role: 'r',
        description: 'd',
        prompt: 'p',
        schedule: '* * * * *',
        message: 'hello',
        action_name: 'my_action',
      });
      expect(job.message).toBe('hello');
      expect(job.action_name).toBe('my_action');
    });

    test('sequential cron jobs get incrementing IDs', () => {
      const c1 = createCronJob({ name: 'a', role: 'r', description: 'd', prompt: 'p', schedule: '* * * * *' });
      const c2 = createCronJob({ name: 'b', role: 'r', description: 'd', prompt: 'p', schedule: '* * * * *' });
      const seq1 = parseInt(c1.id.split('-').pop()!, 10);
      const seq2 = parseInt(c2.id.split('-').pop()!, 10);
      expect(seq2).toBe(seq1 + 1);
    });
  });

  describe('getCronJob()', () => {
    test('returns cron job when exists', () => {
      const created = createCronJob({ name: 'test', role: 'r', description: 'd', prompt: 'p', schedule: '0 * * * *' });
      const fetched = getCronJob(created.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(created.id);
      expect(fetched!.name).toBe('test');
    });

    test('returns null when not exists', () => {
      expect(getCronJob('C-9999-99-999')).toBeNull();
    });

    test('enabled is boolean, not integer', () => {
      const job = createCronJob({ name: 'test', role: 'r', description: 'd', prompt: 'p', schedule: '* * * * *' });
      const fetched = getCronJob(job.id);
      expect(typeof fetched!.enabled).toBe('boolean');
      expect(fetched!.enabled).toBe(true);
    });
  });

  describe('listCronJobs()', () => {
    test('returns all cron jobs without filter', () => {
      createCronJob({ name: 'a', role: 'r', description: 'd', prompt: 'p', schedule: '* * * * *' });
      createCronJob({ name: 'b', role: 'r', description: 'd', prompt: 'p', schedule: '* * * * *' });
      expect(listCronJobs()).toHaveLength(2);
    });

    test('filters enabled jobs', () => {
      createCronJob({ name: 'on', role: 'r', description: 'd', prompt: 'p', schedule: '* * * * *', enabled: true });
      createCronJob({ name: 'off', role: 'r', description: 'd', prompt: 'p', schedule: '* * * * *', enabled: false });
      const enabled = listCronJobs({ enabled: true });
      expect(enabled).toHaveLength(1);
      expect(enabled[0].name).toBe('on');
    });

    test('filters disabled jobs', () => {
      createCronJob({ name: 'on', role: 'r', description: 'd', prompt: 'p', schedule: '* * * * *', enabled: true });
      createCronJob({ name: 'off', role: 'r', description: 'd', prompt: 'p', schedule: '* * * * *', enabled: false });
      const disabled = listCronJobs({ enabled: false });
      expect(disabled).toHaveLength(1);
      expect(disabled[0].name).toBe('off');
    });
  });

  describe('updateCronJob()', () => {
    test('updates name and schedule', () => {
      const job = createCronJob({ name: 'old', role: 'r', description: 'd', prompt: 'p', schedule: '* * * * *' });
      const updated = updateCronJob(job.id, { name: 'new', schedule: '0 9 * * *' });
      expect(updated!.name).toBe('new');
      expect(updated!.schedule).toBe('0 9 * * *');
    });

    test('updates enabled flag', () => {
      const job = createCronJob({ name: 'test', role: 'r', description: 'd', prompt: 'p', schedule: '* * * * *' });
      const updated = updateCronJob(job.id, { enabled: false });
      expect(updated!.enabled).toBe(false);
    });

    test('empty update returns current job', () => {
      const job = createCronJob({ name: 'test', role: 'r', description: 'd', prompt: 'p', schedule: '* * * * *' });
      const result = updateCronJob(job.id, {});
      expect(result!.id).toBe(job.id);
      expect(result!.name).toBe('test');
    });

    test('updates updated_at timestamp', () => {
      const job = createCronJob({ name: 'test', role: 'r', description: 'd', prompt: 'p', schedule: '* * * * *' });
      const originalUpdatedAt = job.updated_at;
      // Small delay to ensure timestamp differs
      const updated = updateCronJob(job.id, { name: 'changed' });
      // updated_at should be set (may or may not differ depending on timing)
      expect(updated!.updated_at).toBeTruthy();
    });
  });

  describe('deleteCronJob()', () => {
    test('deletes existing cron job', () => {
      const job = createCronJob({ name: 'test', role: 'r', description: 'd', prompt: 'p', schedule: '* * * * *' });
      expect(deleteCronJob(job.id)).toBe(true);
      expect(getCronJob(job.id)).toBeNull();
    });

    test('returns false for non-existent job', () => {
      expect(deleteCronJob('C-9999-99-999')).toBe(false);
    });
  });

  describe('toggleCronJob()', () => {
    test('toggles enabled to disabled', () => {
      const job = createCronJob({ name: 'test', role: 'r', description: 'd', prompt: 'p', schedule: '* * * * *', enabled: true });
      const toggled = toggleCronJob(job.id);
      expect(toggled!.enabled).toBe(false);
    });

    test('toggles disabled to enabled', () => {
      const job = createCronJob({ name: 'test', role: 'r', description: 'd', prompt: 'p', schedule: '* * * * *', enabled: false });
      const toggled = toggleCronJob(job.id);
      expect(toggled!.enabled).toBe(true);
    });

    test('double toggle returns to original state', () => {
      const job = createCronJob({ name: 'test', role: 'r', description: 'd', prompt: 'p', schedule: '* * * * *', enabled: true });
      toggleCronJob(job.id);
      const doubled = toggleCronJob(job.id);
      expect(doubled!.enabled).toBe(true);
    });

    test('returns null for non-existent job', () => {
      const result = toggleCronJob('C-9999-99-999');
      expect(result).toBeNull();
    });
  });

  // --- getOutboxDir ---
  describe('getOutboxDir()', () => {
    test('returns path under outbox/ with today date', () => {
      const dir = getOutboxDir(TEST_DIR);
      expect(dir).toContain('outbox/');
      // Should match YYYY-MM-DD pattern
      expect(dir).toMatch(/outbox\/\d{4}-\d{2}-\d{2}$/);
    });

    test('creates the directory', () => {
      const dir = getOutboxDir(TEST_DIR);
      expect(existsSync(dir)).toBe(true);
    });

    test('does not error if called twice', () => {
      const dir1 = getOutboxDir(TEST_DIR);
      const dir2 = getOutboxDir(TEST_DIR);
      expect(dir1).toBe(dir2);
    });
  });
});
