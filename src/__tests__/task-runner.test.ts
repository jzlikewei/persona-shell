import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { TaskRunner } from '../task/task-runner.js';
import { initLogDir } from '../logger.js';

const TEST_DIR = '/tmp/persona-task-runner-test';
const PERSONA_DIR = join(TEST_DIR, 'persona');
const BIN_DIR = join(TEST_DIR, 'bin');
const FAKE_CODEX = join(BIN_DIR, 'fake-codex.sh');

describe('TaskRunner', () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(join(PERSONA_DIR, 'outbox'), { recursive: true });
    mkdirSync(BIN_DIR, { recursive: true });
    initLogDir(PERSONA_DIR);

    writeFileSync(
      FAKE_CODEX,
      String.raw`#!/bin/sh
path="/tmp/persona-task-results/T-TEST-001.md"
mkdir -p "$(dirname "$path")"
printf '# outbox test\n\nwritten by codex task\n' > "$path"
printf '{"type":"turn.completed"}\n'
`,
      { mode: 0o755 },
    );
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    rmSync('/tmp/persona-task-results', { recursive: true, force: true });
  });

  test('moves codex task output from staging into outbox', async () => {
    const runner = new TaskRunner({
      agents: {
        defaults: { default: 'codex', executor: 'codex' },
        providers: {
          codex: { type: 'codex', command: FAKE_CODEX },
        },
      },
      personaDir: PERSONA_DIR,
      defaultTimeoutMs: 5000,
    });

    const result = await new Promise<{
      success: boolean;
      resultFile?: string;
      error?: string;
    }>((resolve) => {
      runner.once('task-completed', resolve);
      runner.once('task-failed', resolve);
      runner.runTask({
        taskId: 'T-TEST-001',
        role: 'executor',
        agent: 'codex',
        prompt: 'write test file',
        description: 'codex outbox test',
      });
    });

    expect(result.success).toBe(true);
    expect(result.resultFile).toBeDefined();
    expect(readFileSync(result.resultFile!, 'utf-8')).toBe('# outbox test\n\nwritten by codex task\n');
    expect(readFileSync(join(PERSONA_DIR, 'outbox', new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }), 'T-TEST-001.md'), 'utf-8')).toContain('written by codex task');
    expect(() => readFileSync('/tmp/persona-task-results/T-TEST-001.md', 'utf-8')).toThrow();
  });

  test('completes when async process writes stdout over time then exits', async () => {
    const asyncScript = join(BIN_DIR, 'async-codex.sh');
    writeFileSync(
      asyncScript,
      String.raw`#!/bin/sh
path="/tmp/persona-task-results/T-TEST-002.md"
mkdir -p "$(dirname "$path")"
printf '# async test\n' > "$path"
# Simulate a long-running process that writes stdout asynchronously
echo '{"type":"status","message":"working"}'
sleep 0.1
echo '{"type":"status","message":"still working"}'
sleep 0.1
echo '{"type":"result","cost_usd":0.05}'
sleep 0.1
echo '{"type":"turn.completed"}'
# Exit — readline should not block completion
`,
      { mode: 0o755 },
    );

    const runner = new TaskRunner({
      agents: {
        defaults: { default: 'codex', executor: 'codex' },
        providers: {
          codex: { type: 'codex', command: asyncScript },
        },
      },
      personaDir: PERSONA_DIR,
      defaultTimeoutMs: 5000,
    });

    const result = await new Promise<{
      success: boolean;
      resultFile?: string;
      error?: string;
    }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('task completion timed out — exit event likely blocked')), 3000);
      runner.once('task-completed', (r) => { clearTimeout(timeout); resolve(r); });
      runner.once('task-failed', (r) => { clearTimeout(timeout); resolve(r); });
      runner.runTask({
        taskId: 'T-TEST-002',
        role: 'executor',
        agent: 'codex',
        prompt: 'async test',
        description: 'async stdout test',
      });
    });

    expect(result.success).toBe(true);
    expect(result.resultFile).toBeDefined();
  });

  test('does not pass MCP config to codex task in cli mode', async () => {
    const runner = new TaskRunner({
      agents: {
        defaults: { default: 'codex', executor: 'codex' },
        providers: {
          codex: { type: 'codex', command: FAKE_CODEX, mcp_mode: 'cli' },
        },
      },
      personaDir: PERSONA_DIR,
      defaultTimeoutMs: 5000,
    });

    const result = await new Promise<{
      success: boolean;
      spawnArgs?: string[];
    }>((resolve) => {
      runner.once('task-completed', resolve);
      runner.once('task-failed', resolve);
      runner.runTask({
        taskId: 'T-TEST-001',
        role: 'executor',
        agent: 'codex',
        prompt: 'write test file',
        description: 'codex cli mode test',
      });
    });

    expect(result.success).toBe(true);
    expect(result.spawnArgs).toBeDefined();
    expect(result.spawnArgs).not.toContain('-c');
  });

  test('captures codex thread id from task stdout', async () => {
    const script = join(BIN_DIR, 'thread-codex.sh');
    writeFileSync(
      script,
      String.raw`#!/bin/sh
path="/tmp/persona-task-results/T-TEST-003.md"
mkdir -p "$(dirname "$path")"
printf '# thread test\n' > "$path"
printf '{"type":"thread.started","thread_id":"thread-task-003"}\n'
printf '{"type":"turn.completed"}\n'
`,
      { mode: 0o755 },
    );

    const runner = new TaskRunner({
      agents: {
        defaults: { default: 'codex', executor: 'codex' },
        providers: {
          codex: { type: 'codex', command: script },
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
      codexThreadId?: string;
    }>((resolve) => {
      runner.once('task-completed', resolve);
      runner.once('task-failed', resolve);
      runner.runTask({
        taskId: 'T-TEST-003',
        role: 'executor',
        agent: 'codex',
        prompt: 'capture thread',
        description: 'codex thread test',
      });
    });

    expect(result.success).toBe(true);
    expect(result.codexThreadId).toBe('thread-task-003');
    expect(startedThreads).toEqual([{ taskId: 'T-TEST-003', threadId: 'thread-task-003' }]);
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
      out({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: 'thread-app-task-004' } } });
    } else if (msg.method === 'thread/name/set') {
      out({ jsonrpc: '2.0', id: msg.id, result: {} });
    } else if (msg.method === 'turn/start') {
      const text = msg.params.input?.[0]?.text || '';
      const match = text.match(/保存到 ([^。]+)。/);
      const path = match ? match[1] : '/tmp/persona-task-results/T-TEST-004.md';
      await Bun.write(path, '# app-server task\n\nwritten by codex app-server\n');
      out({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: 'turn-task-004' } } });
      out({ jsonrpc: '2.0', method: 'turn/started', params: { turn: { id: 'turn-task-004' } } });
      out({ jsonrpc: '2.0', method: 'turn/completed', params: { turn: { id: 'turn-task-004', status: 'completed', durationMs: 12, items: [{ type: 'agentMessage', text: 'done' }] } } });
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
});
