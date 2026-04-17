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
    expect(readFileSync(join(PERSONA_DIR, 'outbox', new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }), 'T-TEST-001_codex outbox test.md'), 'utf-8')).toContain('written by codex task');
    expect(() => readFileSync('/tmp/persona-task-results/T-TEST-001.md', 'utf-8')).toThrow();
  });
});
