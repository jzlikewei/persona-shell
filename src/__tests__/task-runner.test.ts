import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { TaskRunner } from '../task/task-runner.js';
import { initLogDir } from '../logger.js';

const TEST_DIR = '/tmp/persona-task-runner-test';
const PERSONA_DIR = join(TEST_DIR, 'persona');
const BIN_DIR = join(TEST_DIR, 'bin');

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
