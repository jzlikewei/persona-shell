import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { TaskRunner, type TaskResult } from '../task/task-runner.js';
import { initLogDir } from '../logger.js';

const TEST_DIR = '/tmp/persona-task-runner-test';
const PERSONA_DIR = join(TEST_DIR, 'persona');
const BIN_DIR = join(TEST_DIR, 'bin');

async function waitForFile(path: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await Bun.sleep(10);
  }
}

describe('TaskRunner', () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(join(PERSONA_DIR, 'outbox'), { recursive: true });
    mkdirSync(BIN_DIR, { recursive: true });
    initLogDir(PERSONA_DIR);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    rmSync('/tmp/persona-task-results', { recursive: true, force: true });
  });

  test('runs codex-app-server task through temporary app-server runtime', async () => {
    const appServer = join(BIN_DIR, 'fake-codex-app-server.js');
    writeFileSync(
      appServer,
      String.raw`#!/usr/bin/env bun
const out = (value) => process.stdout.write(JSON.stringify(value) + '\n');
for await (const chunk of Bun.stdin.stream()) {
  const lines = new TextDecoder().decode(chunk).split('\n').filter(Boolean);
  for (const line of lines) {
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      out({ jsonrpc: '2.0', id: msg.id, result: {} });
    } else if (msg.method === 'thread/start') {
      out({ jsonrpc: '2.0', method: 'thread/started', params: { thread: { id: 'thread-app-task-004' } } });
      out({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: 'thread-app-task-004' } } });
    } else if (msg.method === 'thread/name/set') {
      out({ jsonrpc: '2.0', id: msg.id, result: {} });
    } else if (msg.method === 'turn/start') {
      const text = msg.params.input?.[0]?.text || '';
      const match = text.match(/保存到 ([^。]+)。/);
      const path = match ? match[1] : '/tmp/persona-task-results/T-TEST-004.md';
      await Bun.write(path, '# app-server task\n\nwritten by codex app-server\n');
      out({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: 'turn-task-004' } } });
      out({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: 'thread-app-task-004', turn: { id: 'turn-task-004' } } });
      out({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'thread-app-task-004', turn: { id: 'turn-task-004', status: 'completed', durationMs: 12, items: [{ type: 'agentMessage', text: 'done' }] } } });
    }
  }
}
`,
      { mode: 0o755 },
    );

    const runner = new TaskRunner({
      agents: {
        defaults: { default: 'codex', executor: 'codex' },
        providers: {
          codex: { type: 'codex-app-server', command: appServer },
        },
      },
      personaDir: PERSONA_DIR,
      defaultTimeoutMs: 5000,
    });

    const startedThreads: Array<{ taskId: string; threadId: string }> = [];
    runner.on('task-thread-started', (taskId: string, threadId: string) => {
      startedThreads.push({ taskId, threadId });
    });

    const result = await new Promise<{
      success: boolean;
      resultFile?: string;
      codexThreadId?: string;
      spawnArgs?: string[];
    }>((resolve) => {
      runner.once('task-completed', resolve);
      runner.once('task-failed', resolve);
      runner.runTask({
        taskId: 'T-TEST-004',
        role: 'executor',
        agent: 'codex',
        prompt: 'write app-server test file',
        description: 'codex app-server task test',
      });
    });

    expect(result.success).toBe(true);
    expect(result.codexThreadId).toBe('thread-app-task-004');
    expect(result.spawnArgs).toEqual(['app-server', '--listen', 'stdio://']);
    expect(startedThreads).toEqual([{ taskId: 'T-TEST-004', threadId: 'thread-app-task-004' }]);
    expect(readFileSync(result.resultFile!, 'utf-8')).toContain('written by codex app-server');
  });

  test('waits for the root turn before materializing a multi-agent codex task result', async () => {
    const appServer = join(BIN_DIR, 'fake-codex-multi-agent.js');
    const childCompletedMarker = join(TEST_DIR, 'child-completed');
    const releaseRoot = join(TEST_DIR, 'release-root');
    writeFileSync(
      appServer,
      String.raw`#!/usr/bin/env bun
import { existsSync } from 'fs';
const out = (value) => process.stdout.write(JSON.stringify(value) + '\n');
for await (const chunk of Bun.stdin.stream()) {
  const lines = new TextDecoder().decode(chunk).split('\n').filter(Boolean);
  for (const line of lines) {
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      out({ jsonrpc: '2.0', id: msg.id, result: {} });
    } else if (msg.method === 'thread/start') {
      out({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: 'root-thread-multi' } } });
    } else if (msg.method === 'thread/name/set') {
      out({ jsonrpc: '2.0', id: msg.id, result: {} });
    } else if (msg.method === 'turn/start') {
      const text = msg.params.input?.[0]?.text || '';
      const match = text.match(/保存到 ([^。]+)。/);
      const path = match ? match[1] : '/tmp/persona-task-results/T-TEST-MULTI.md';
      out({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: 'root-turn-multi' } } });
      out({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: 'root-thread-multi', turn: { id: 'root-turn-multi', status: 'inProgress' } } });
      out({ jsonrpc: '2.0', method: 'thread/started', params: { thread: { id: 'child-thread-a', parentThreadId: 'root-thread-multi' } } });
      out({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: 'child-thread-a', turn: { id: 'child-turn-a', status: 'inProgress' } } });
      out({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: 'child-thread-b', turn: { id: 'child-turn-b', status: 'inProgress' } } });
      out({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId: 'child-thread-a', turnId: 'child-turn-a', itemId: 'child-message', delta: 'child answer' } });
      out({ jsonrpc: '2.0', method: 'item/started', params: { threadId: 'child-thread-b', turnId: 'child-turn-b', item: { type: 'commandExecution', id: 'child-call', command: 'echo child', status: 'inProgress' } } });
      out({ jsonrpc: '2.0', method: 'turn/plan/updated', params: { threadId: 'child-thread-b', turnId: 'child-turn-b', plan: [{ step: 'child work', status: 'completed' }] } });
      out({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'child-thread-a', turn: { id: 'child-turn-a', status: 'completed', items: [] } } });
      out({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'child-thread-b', turn: { id: 'child-turn-b', status: 'completed', items: [] } } });
      await Bun.sleep(50);
      await Bun.write(${JSON.stringify(childCompletedMarker)}, 'ready');
      const deadline = Date.now() + 2000;
      while (!existsSync(${JSON.stringify(releaseRoot)})) {
        if (Date.now() >= deadline) process.exit(2);
        await Bun.sleep(10);
      }
      await Bun.write(path, '# multi-agent task\n\nwritten only after root release\n');
      out({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId: 'root-thread-multi', turnId: 'root-turn-multi', itemId: 'root-message', delta: 'done' } });
      out({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'root-thread-multi', turn: { id: 'root-turn-multi', status: 'completed', durationMs: 55, items: [] } } });
    }
  }
}
`,
      { mode: 0o755 },
    );

    const runner = new TaskRunner({
      agents: {
        defaults: { default: 'codex', executor: 'codex' },
        providers: {
          codex: { type: 'codex-app-server', command: appServer },
        },
      },
      personaDir: PERSONA_DIR,
      defaultTimeoutMs: 5000,
    });
    const observedResults: TaskResult[] = [];
    const resultPromise = new Promise<TaskResult>((resolve) => {
      const capture = (result: TaskResult) => {
        observedResults.push(result);
        resolve(result);
      };
      runner.once('task-completed', capture);
      runner.once('task-failed', capture);
    });

    runner.runTask({
      taskId: 'T-TEST-MULTI',
      role: 'executor',
      agent: 'codex',
      prompt: 'write multi-agent app-server test file',
      description: 'codex multi-agent task test',
    });

    await waitForFile(childCompletedMarker);
    expect(runner.isRunning('T-TEST-MULTI')).toBe(true);
    expect(observedResults).toEqual([]);
    expect(existsSync('/tmp/persona-task-results/T-TEST-MULTI.md')).toBe(false);

    writeFileSync(releaseRoot, 'continue');
    const result = await resultPromise;

    expect(result.success).toBe(true);
    expect(result.codexThreadId).toBe('root-thread-multi');
    expect(result.resultFile).toBeTruthy();
    expect(readFileSync(result.resultFile!, 'utf-8')).toContain('written only after root release');
    expect(observedResults).toHaveLength(1);
  });

  test('fails clearly when the root turn completes without its result file', async () => {
    const appServer = join(BIN_DIR, 'fake-codex-missing-result.js');
    writeFileSync(
      appServer,
      String.raw`#!/usr/bin/env bun
const out = (value) => process.stdout.write(JSON.stringify(value) + '\n');
for await (const chunk of Bun.stdin.stream()) {
  const lines = new TextDecoder().decode(chunk).split('\n').filter(Boolean);
  for (const line of lines) {
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      out({ jsonrpc: '2.0', id: msg.id, result: {} });
    } else if (msg.method === 'thread/start') {
      out({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: 'root-thread-missing' } } });
    } else if (msg.method === 'thread/name/set') {
      out({ jsonrpc: '2.0', id: msg.id, result: {} });
    } else if (msg.method === 'turn/start') {
      out({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: 'root-turn-missing' } } });
      out({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: 'root-thread-missing', turn: { id: 'root-turn-missing' } } });
      out({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'root-thread-missing', turn: { id: 'root-turn-missing', status: 'completed', durationMs: 7, items: [{ type: 'agentMessage', text: 'done without report' }] } } });
    }
  }
}
`,
      { mode: 0o755 },
    );

    const runner = new TaskRunner({
      agents: {
        defaults: { default: 'codex', executor: 'codex' },
        providers: {
          codex: { type: 'codex-app-server', command: appServer },
        },
      },
      personaDir: PERSONA_DIR,
      defaultTimeoutMs: 5000,
    });
    const resultPromise = new Promise<TaskResult>((resolve) => {
      runner.once('task-completed', resolve);
      runner.once('task-failed', resolve);
    });

    runner.runTask({
      taskId: 'T-TEST-MISSING',
      role: 'executor',
      agent: 'codex',
      prompt: 'finish without writing the required report',
      description: 'codex missing result test',
    });
    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(result.error).toBe('result file missing');
    expect(result.resultFile).toBeUndefined();
    expect(result.codexThreadId).toBe('root-thread-missing');
  });
});
