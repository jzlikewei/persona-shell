import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { CodexThreadInjector } from '../codex-thread-injector.js';

const TEST_DIR = '/tmp/persona-codex-thread-injector-test';
const PERSONA_DIR = join(TEST_DIR, 'persona');
const BIN_DIR = join(TEST_DIR, 'bin');
const FAKE_CODEX = join(BIN_DIR, 'fake-codex.ts');
const CAPTURE_PATH = join(TEST_DIR, 'requests.jsonl');

describe('CodexThreadInjector', () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(PERSONA_DIR, { recursive: true });
    mkdirSync(BIN_DIR, { recursive: true });
    writeFileSync(
      FAKE_CODEX,
      `#!/usr/bin/env bun
import { appendFileSync } from 'fs';
import { createInterface } from 'readline';

const capture = ${JSON.stringify(CAPTURE_PATH)};
const rl = createInterface({ input: process.stdin });
function send(value) {
  process.stdout.write(JSON.stringify(value) + '\\n');
}
rl.on('line', (line) => {
  if (!line.trim()) return;
  appendFileSync(capture, line + '\\n');
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { ok: true } });
  } else if (msg.method === 'thread/resume') {
    send({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: msg.params.threadId } } });
  } else if (msg.method === 'thread/inject_items') {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
  } else if (msg.method === 'turn/start') {
    send({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: 'turn-1' } } });
    send({ jsonrpc: '2.0', method: 'turn/started', params: { turn: { id: 'turn-1' } } });
    send({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { delta: 'ack' } });
    send({ jsonrpc: '2.0', method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed', items: [{ type: 'agentMessage', text: 'ack' }] } } });
    setTimeout(() => process.exit(0), 10);
  }
});
`,
      { mode: 0o755 },
    );
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test('resumes an existing thread and starts a user turn', async () => {
    const injector = new CodexThreadInjector({
      logDir: join(TEST_DIR, 'logs'),
      directorConfig: {
        persona_dir: PERSONA_DIR,
        pipe_dir: TEST_DIR,
        pid_file: join(TEST_DIR, 'director.pid'),
        time_sync_interval_ms: 999999,
        flush_context_limit: 999999,
        flush_interval_ms: 999999,
        quote_max_length: 32,
      },
      agent: {
        command: FAKE_CODEX,
        approval: 'never',
        sandbox: 'danger-full-access',
      },
    });

    const result = await injector.injectUserMessage({
      threadId: 'thread-existing-1',
      text: 'synthetic callback',
      cwd: PERSONA_DIR,
      timeoutMs: 5000,
      waitForCompletion: true,
    });

    expect(result).toEqual({
      ok: true,
      threadId: 'thread-existing-1',
      turnId: 'turn-1',
      responseText: 'ack',
    });

    const requests = readFileSync(CAPTURE_PATH, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(requests.map((request) => request.method)).toEqual(['initialize', 'thread/resume', 'turn/start']);
    expect(requests[1].params.threadId).toBe('thread-existing-1');
    expect(requests[2].params.input[0].text).toBe('synthetic callback');
  });

  test('injects a user message into an existing thread by default', async () => {
    const injector = new CodexThreadInjector({
      logDir: join(TEST_DIR, 'logs'),
      directorConfig: {
        persona_dir: PERSONA_DIR,
        pipe_dir: TEST_DIR,
        pid_file: join(TEST_DIR, 'director.pid'),
        time_sync_interval_ms: 999999,
        flush_context_limit: 999999,
        flush_interval_ms: 999999,
        quote_max_length: 32,
      },
      agent: {
        command: FAKE_CODEX,
        approval: 'never',
        sandbox: 'danger-full-access',
      },
    });

    const result = await injector.injectUserMessage({
      threadId: 'thread-existing-2',
      text: 'synthetic callback',
      cwd: PERSONA_DIR,
      timeoutMs: 5000,
    });

    expect(result).toEqual({
      ok: true,
      threadId: 'thread-existing-2',
      turnId: null,
      responseText: '',
    });

    const requests = readFileSync(CAPTURE_PATH, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(requests.map((request) => request.method)).toEqual(['initialize', 'thread/resume', 'thread/inject_items']);
    expect(requests[1].params.threadId).toBe('thread-existing-2');
    expect(requests[2].params.items).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'synthetic callback' }],
      },
    ]);
  });
});
