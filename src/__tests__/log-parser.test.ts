import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { parseConversationLog, parseSessions, parseTaskLog } from '../log-parser.js';

// ── Temp directories for input/output log tests ──
const TMP_DIR = '/tmp/persona-log-parser-test';

// ── Project logs directory for parseTaskLog tests ──
const PROJECT_LOGS_DIR = join(import.meta.dirname, '..', '..', 'logs');

// Unique prefix to avoid collision with real logs
const TEST_TASK_PREFIX = '_test_lp_';

function inputLine(content: string, director = 'main', ts = '2026-04-15T10:00:00+08:00'): string {
  return JSON.stringify({ type: 'user', message: { content }, director, timestamp: ts });
}

function outputInit(sessionId: string, director?: string): string {
  const obj: Record<string, unknown> = { type: 'system', subtype: 'init', session_id: sessionId };
  if (director) obj._director = director;
  return JSON.stringify(obj);
}

function outputAssistant(text: string, director?: string): string {
  const obj: Record<string, unknown> = {
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
  };
  if (director) obj._director = director;
  return JSON.stringify(obj);
}

function outputResult(sessionId: string, ts = '2026-04-15T10:00:01+08:00', director?: string): string {
  const obj: Record<string, unknown> = { type: 'result', session_id: sessionId, _ts: ts };
  if (director) obj._director = director;
  return JSON.stringify(obj);
}

function codexThreadStarted(threadId: string): string {
  return JSON.stringify({ type: 'thread.started', thread_id: threadId });
}

function codexItemCompleted(text: string): string {
  return JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } });
}

function codexTurnCompleted(ts = '2026-04-15T10:00:01+08:00'): string {
  return JSON.stringify({ type: 'turn.completed', _ts: ts });
}

describe('log-parser', () => {
  beforeEach(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
    mkdirSync(TMP_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  // ── parseConversationLog ──

  describe('parseConversationLog', () => {
    test('empty files → empty array', () => {
      const inLog = join(TMP_DIR, 'input.log');
      const outLog = join(TMP_DIR, 'output.log');
      writeFileSync(inLog, '');
      writeFileSync(outLog, '');
      expect(parseConversationLog(inLog, outLog, 100)).toEqual([]);
    });

    test('non-existent files → empty array', () => {
      expect(parseConversationLog(join(TMP_DIR, 'nope-in.log'), join(TMP_DIR, 'nope-out.log'), 100)).toEqual([]);
    });

    test('only input, no output → only in-direction messages', () => {
      const inLog = join(TMP_DIR, 'input.log');
      const outLog = join(TMP_DIR, 'output.log');
      writeFileSync(inLog, inputLine('hello') + '\n' + inputLine('world', 'main', '2026-04-15T10:01:00+08:00') + '\n');
      writeFileSync(outLog, '');

      const msgs = parseConversationLog(inLog, outLog, 100);
      expect(msgs.length).toBe(2);
      expect(msgs.every((m) => m.direction === 'in')).toBe(true);
    });

    test('input/output one-to-one pairing', () => {
      const inLog = join(TMP_DIR, 'input.log');
      const outLog = join(TMP_DIR, 'output.log');
      writeFileSync(inLog, inputLine('q1', 'main', '2026-04-15T10:00:00+08:00') + '\n');
      writeFileSync(outLog, [
        outputInit('sess-001'),
        outputAssistant('a1'),
        outputResult('sess-001', '2026-04-15T10:00:01+08:00'),
      ].join('\n') + '\n');

      const msgs = parseConversationLog(inLog, outLog, 100);
      // reversed order: newest first
      expect(msgs.length).toBe(2);
      const inMsg = msgs.find((m) => m.direction === 'in');
      const outMsg = msgs.find((m) => m.direction === 'out');
      expect(inMsg?.content).toBe('q1');
      expect(outMsg?.content).toBe('a1');
      expect(outMsg?.sessionId).toBe('sess-001');
    });

    test('orphan outputs (more outputs than inputs)', () => {
      const inLog = join(TMP_DIR, 'input.log');
      const outLog = join(TMP_DIR, 'output.log');
      writeFileSync(inLog, inputLine('q1', 'main', '2026-04-15T10:01:00+08:00') + '\n');
      writeFileSync(outLog, [
        outputInit('sess-001'),
        outputAssistant('orphan-response'),
        outputResult('sess-001', '2026-04-15T10:00:00+08:00'),
        outputAssistant('paired-response'),
        outputResult('sess-001', '2026-04-15T10:01:01+08:00'),
      ].join('\n') + '\n');

      const msgs = parseConversationLog(inLog, outLog, 100);
      // Should have 3 messages: 1 orphan out + 1 in + 1 out
      expect(msgs.length).toBe(3);
      const outMsgs = msgs.filter((m) => m.direction === 'out');
      expect(outMsgs.length).toBe(2);
      expect(outMsgs.some((m) => m.content === 'orphan-response')).toBe(true);
    });

    test('multi-director scenario — messages grouped and paired by director', () => {
      const inLog = join(TMP_DIR, 'input.log');
      const outLog = join(TMP_DIR, 'output.log');

      const inputLines = [
        inputLine('dir-a q1', 'alpha', '2026-04-15T10:00:00+08:00'),
        inputLine('dir-b q1', 'beta', '2026-04-15T10:00:30+08:00'),
        inputLine('dir-a q2', 'alpha', '2026-04-15T10:01:00+08:00'),
      ];
      writeFileSync(inLog, inputLines.join('\n') + '\n');

      const outputLines = [
        outputInit('sess-a1'),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'alpha-r1' }] }, _director: 'alpha' }),
        JSON.stringify({ type: 'result', session_id: 'sess-a1', _ts: '2026-04-15T10:00:10+08:00', _director: 'alpha' }),
        outputInit('sess-b1'),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'beta-r1' }] }, _director: 'beta' }),
        JSON.stringify({ type: 'result', session_id: 'sess-b1', _ts: '2026-04-15T10:00:40+08:00', _director: 'beta' }),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'alpha-r2' }] }, _director: 'alpha' }),
        JSON.stringify({ type: 'result', session_id: 'sess-a1', _ts: '2026-04-15T10:01:10+08:00', _director: 'alpha' }),
      ];
      writeFileSync(outLog, outputLines.join('\n') + '\n');

      const msgs = parseConversationLog(inLog, outLog, 100);
      // 3 inputs + 3 outputs = 6 messages
      expect(msgs.length).toBe(6);
      const contents = msgs.map((m) => m.content);
      expect(contents).toContain('alpha-r1');
      expect(contents).toContain('beta-r1');
      expect(contents).toContain('alpha-r2');
    });

    test('limit parameter truncates result', () => {
      const inLog = join(TMP_DIR, 'input.log');
      const outLog = join(TMP_DIR, 'output.log');

      const lines: string[] = [];
      const outLines: string[] = [outputInit('sess-001')];
      for (let i = 0; i < 10; i++) {
        const ts = `2026-04-15T10:${String(i).padStart(2, '0')}:00+08:00`;
        lines.push(inputLine(`q${i}`, 'main', ts));
        outLines.push(outputAssistant(`a${i}`));
        outLines.push(outputResult('sess-001', `2026-04-15T10:${String(i).padStart(2, '0')}:01+08:00`));
      }
      writeFileSync(inLog, lines.join('\n') + '\n');
      writeFileSync(outLog, outLines.join('\n') + '\n');

      const msgs = parseConversationLog(inLog, outLog, 4);
      expect(msgs.length).toBe(4);
    });

    test('sessionFilter filters by session ID', () => {
      const inLog = join(TMP_DIR, 'input.log');
      const outLog = join(TMP_DIR, 'output.log');

      writeFileSync(inLog, [
        inputLine('q1', 'main', '2026-04-15T10:00:00+08:00'),
        inputLine('q2', 'main', '2026-04-15T10:01:00+08:00'),
      ].join('\n') + '\n');

      writeFileSync(outLog, [
        outputInit('sess-AAA'),
        outputAssistant('a1'),
        outputResult('sess-AAA', '2026-04-15T10:00:01+08:00'),
        outputInit('sess-BBB'),
        outputAssistant('a2'),
        outputResult('sess-BBB', '2026-04-15T10:01:01+08:00'),
      ].join('\n') + '\n');

      const filtered = parseConversationLog(inLog, outLog, 100, 'sess-AAA');
      // Only messages associated with sess-AAA
      for (const m of filtered) {
        if (m.sessionId) expect(m.sessionId).toBe('sess-AAA');
      }
      expect(filtered.some((m) => m.content === 'a1')).toBe(true);
      expect(filtered.some((m) => m.content === 'a2')).toBe(false);
    });

    test('codex format — thread.started + item.completed + turn.completed', () => {
      const inLog = join(TMP_DIR, 'input.log');
      const outLog = join(TMP_DIR, 'output.log');

      writeFileSync(inLog, inputLine('codex-q', 'main', '2026-04-15T10:00:00+08:00') + '\n');
      writeFileSync(outLog, [
        codexThreadStarted('thread-001'),
        codexItemCompleted('codex response'),
        codexTurnCompleted('2026-04-15T10:00:01+08:00'),
      ].join('\n') + '\n');

      const msgs = parseConversationLog(inLog, outLog, 100);
      expect(msgs.length).toBe(2);
      const outMsg = msgs.find((m) => m.direction === 'out');
      expect(outMsg?.content).toBe('codex response');
      expect(outMsg?.sessionId).toBe('thread-001');
    });
  });

  // ── parseSessions ──

  describe('parseSessions', () => {
    test('empty file → empty array', () => {
      const outLog = join(TMP_DIR, 'output.log');
      writeFileSync(outLog, '');
      expect(parseSessions(outLog)).toEqual([]);
    });

    test('non-existent file → empty array', () => {
      expect(parseSessions(join(TMP_DIR, 'nonexistent.log'))).toEqual([]);
    });

    test('multiple session inits → correct extraction', () => {
      const outLog = join(TMP_DIR, 'output.log');
      writeFileSync(outLog, [
        outputInit('sess-001'),
        outputAssistant('r1'),
        outputResult('sess-001', '2026-04-15T10:00:01+08:00'),
        outputInit('sess-002'),
        outputAssistant('r2'),
        outputResult('sess-002', '2026-04-15T11:00:01+08:00'),
      ].join('\n') + '\n');

      const sessions = parseSessions(outLog);
      expect(sessions.length).toBe(2);
      const ids = sessions.map((s) => s.sessionId);
      expect(ids).toContain('sess-001');
      expect(ids).toContain('sess-002');
    });

    test('message count accumulates for same session', () => {
      const outLog = join(TMP_DIR, 'output.log');
      writeFileSync(outLog, [
        outputInit('sess-001'),
        outputAssistant('r1'),
        outputResult('sess-001', '2026-04-15T10:00:01+08:00'),
        outputAssistant('r2'),
        outputResult('sess-001', '2026-04-15T10:01:01+08:00'),
        outputAssistant('r3'),
        outputResult('sess-001', '2026-04-15T10:02:01+08:00'),
      ].join('\n') + '\n');

      const sessions = parseSessions(outLog);
      expect(sessions.length).toBe(1);
      expect(sessions[0].messageCount).toBe(3);
    });

    test('first/last timestamp correct', () => {
      const outLog = join(TMP_DIR, 'output.log');
      writeFileSync(outLog, [
        outputInit('sess-001'),
        outputAssistant('r1'),
        outputResult('sess-001', '2026-04-15T10:00:01+08:00'),
        outputAssistant('r2'),
        outputResult('sess-001', '2026-04-15T10:05:01+08:00'),
      ].join('\n') + '\n');

      const sessions = parseSessions(outLog);
      expect(sessions[0].firstMessageAt).toBe('2026-04-15T10:00:01+08:00');
      expect(sessions[0].lastMessageAt).toBe('2026-04-15T10:05:01+08:00');
    });

    test('codex thread.started + turn.completed counted as session', () => {
      const outLog = join(TMP_DIR, 'output.log');
      writeFileSync(outLog, [
        codexThreadStarted('thread-001'),
        codexItemCompleted('resp'),
        codexTurnCompleted('2026-04-15T10:00:01+08:00'),
      ].join('\n') + '\n');

      const sessions = parseSessions(outLog);
      expect(sessions.length).toBe(1);
      expect(sessions[0].sessionId).toBe('thread-001');
      expect(sessions[0].messageCount).toBe(1);
    });

    test('sessions sorted by lastMessageAt descending', () => {
      const outLog = join(TMP_DIR, 'output.log');
      writeFileSync(outLog, [
        outputInit('sess-old'),
        outputResult('sess-old', '2026-04-15T08:00:00+08:00'),
        outputInit('sess-new'),
        outputResult('sess-new', '2026-04-15T12:00:00+08:00'),
      ].join('\n') + '\n');

      const sessions = parseSessions(outLog);
      expect(sessions[0].sessionId).toBe('sess-new');
      expect(sessions[1].sessionId).toBe('sess-old');
    });
  });

  // ── parseTaskLog ──

  describe('parseTaskLog', () => {
    const testTaskId = (suffix: string) => `${TEST_TASK_PREFIX}${suffix}`;

    afterEach(() => {
      // Clean up any test log files
      try {
        const { readdirSync, unlinkSync } = require('fs');
        for (const f of readdirSync(PROJECT_LOGS_DIR)) {
          if (f.startsWith(`task-${TEST_TASK_PREFIX}`)) {
            unlinkSync(join(PROJECT_LOGS_DIR, f));
          }
        }
      } catch { /* ignore */ }
    });

    function writeTaskLog(taskId: string, lines: string[]): void {
      if (!existsSync(PROJECT_LOGS_DIR)) mkdirSync(PROJECT_LOGS_DIR, { recursive: true });
      writeFileSync(join(PROJECT_LOGS_DIR, `task-${taskId}.stdout.log`), lines.join('\n') + '\n');
    }

    test('non-existent log → empty entries', () => {
      const id = testTaskId('nonexist');
      const result = parseTaskLog(id, 0);
      expect(result.entries).toEqual([]);
      expect(result.totalLines).toBe(0);
    });

    test('system init event parsed', () => {
      const id = testTaskId('init');
      writeTaskLog(id, [
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-test-abcdef123456' }),
      ]);

      const result = parseTaskLog(id, 0);
      expect(result.entries.length).toBe(1);
      expect(result.entries[0].type).toBe('system');
      expect(result.entries[0].content).toContain('sess-test-ab');
      expect(result.entries[0].meta?.session_id).toBe('sess-test-abcdef123456');
    });

    test('assistant text event parsed', () => {
      const id = testTaskId('text');
      writeTaskLog(id, [
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Hello world' }] },
        }),
      ]);

      const result = parseTaskLog(id, 0);
      expect(result.entries.length).toBe(1);
      expect(result.entries[0].type).toBe('text');
      expect(result.entries[0].content).toBe('Hello world');
    });

    test('assistant thinking event parsed', () => {
      const id = testTaskId('think');
      writeTaskLog(id, [
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'thinking', thinking: 'Let me consider...' }] },
        }),
      ]);

      const result = parseTaskLog(id, 0);
      expect(result.entries.length).toBe(1);
      expect(result.entries[0].type).toBe('thinking');
      expect(result.entries[0].content).toBe('Let me consider...');
    });

    test('tool_use event parsed with long input truncated', () => {
      const id = testTaskId('tool');
      const longValue = 'x'.repeat(600);
      writeTaskLog(id, [
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [{
              type: 'tool_use',
              id: 'tool-123',
              name: 'Bash',
              input: { command: longValue, short: 'ok' },
            }],
          },
        }),
      ]);

      const result = parseTaskLog(id, 0);
      expect(result.entries.length).toBe(1);
      expect(result.entries[0].type).toBe('tool_use');
      expect(result.entries[0].content).toBe('Bash');
      const input = result.entries[0].meta?.input as Record<string, unknown>;
      // Long string should be truncated to 500 chars + ellipsis
      expect((input.command as string).length).toBe(501);
      expect((input.command as string).endsWith('…')).toBe(true);
      // Short string stays as-is
      expect(input.short).toBe('ok');
    });

    test('tool_result event parsed', () => {
      const id = testTaskId('toolres');
      writeTaskLog(id, [
        JSON.stringify({
          type: 'user',
          message: {
            content: [{ type: 'tool_result', content: 'file created', is_error: false }],
          },
        }),
      ]);

      const result = parseTaskLog(id, 0);
      expect(result.entries.length).toBe(1);
      expect(result.entries[0].type).toBe('tool_result');
      expect(result.entries[0].content).toBe('file created');
      expect(result.entries[0].meta?.is_error).toBe(false);
    });

    test('tool_result with error flag', () => {
      const id = testTaskId('toolerr');
      writeTaskLog(id, [
        JSON.stringify({
          type: 'user',
          message: {
            content: [{ type: 'tool_result', content: 'permission denied', is_error: true }],
          },
        }),
      ]);

      const result = parseTaskLog(id, 0);
      expect(result.entries[0].meta?.is_error).toBe(true);
    });

    test('result event parsed', () => {
      const id = testTaskId('result');
      writeTaskLog(id, [
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          duration_ms: 5000,
          total_cost_usd: 0.05,
          num_turns: 3,
        }),
      ]);

      const result = parseTaskLog(id, 0);
      expect(result.entries.length).toBe(1);
      expect(result.entries[0].type).toBe('result');
      expect(result.entries[0].content).toBe('Completed');
      expect(result.entries[0].meta?.duration_ms).toBe(5000);
      expect(result.entries[0].meta?.cost_usd).toBe(0.05);
      expect(result.entries[0].meta?.num_turns).toBe(3);
    });

    test('result event with non-success subtype', () => {
      const id = testTaskId('resultfail');
      writeTaskLog(id, [
        JSON.stringify({ type: 'result', subtype: 'error' }),
      ]);

      const result = parseTaskLog(id, 0);
      expect(result.entries[0].content).toBe('error');
    });

    test('afterLine skips earlier lines', () => {
      const id = testTaskId('after');
      writeTaskLog(id, [
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-skip' }),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'line-1' }] } }),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'line-2' }] } }),
      ]);

      const result = parseTaskLog(id, 2);
      // Should only have line-2 (index 2), skipping system init (0) and line-1 (1)
      expect(result.entries.length).toBe(1);
      expect(result.entries[0].content).toBe('line-2');
      expect(result.totalLines).toBe(4); // 3 JSON lines + 1 trailing newline empty line
    });

    test('totalLines reflects all lines in file', () => {
      const id = testTaskId('total');
      writeTaskLog(id, [
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-a' }),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } }),
        JSON.stringify({ type: 'result', subtype: 'success' }),
      ]);

      const result = parseTaskLog(id, 0);
      // 3 data lines + trailing newline splits into 4
      expect(result.totalLines).toBe(4);
    });

    test('malformed JSON lines are skipped', () => {
      const id = testTaskId('malformed');
      writeTaskLog(id, [
        '{ broken json',
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'valid' }] } }),
      ]);

      const result = parseTaskLog(id, 0);
      expect(result.entries.length).toBe(1);
      expect(result.entries[0].content).toBe('valid');
    });
  });
});
