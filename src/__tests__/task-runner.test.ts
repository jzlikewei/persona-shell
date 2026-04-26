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
});
