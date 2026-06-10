import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { encodeProjectPath, parseClaudeTranscript } from '../claude-transcript-reader.js';

const TMP_DIR = '/tmp/persona-claude-transcript-test';
const FAKE_HOME = join(TMP_DIR, 'home');
const SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const CWD = '/Users/test/.persona/workspaces/test-ws';

// encodeProjectPath produces: -Users-test--persona-workspaces-test-ws
const ENCODED = encodeProjectPath(CWD);
const PROJECT_DIR = join(FAKE_HOME, '.claude', 'projects', ENCODED);
const JSONL_PATH = join(PROJECT_DIR, `${SESSION_ID}.jsonl`);

function writeTranscript(lines: object[]): void {
  mkdirSync(PROJECT_DIR, { recursive: true });
  writeFileSync(JSONL_PATH, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
}

// Override homedir for tests
let originalHome: string;
beforeEach(() => {
  originalHome = process.env.HOME ?? '';
  process.env.HOME = FAKE_HOME;
  rmSync(TMP_DIR, { recursive: true, force: true });
});
afterEach(() => {
  process.env.HOME = originalHome;
  rmSync(TMP_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// encodeProjectPath
// ---------------------------------------------------------------------------

describe('encodeProjectPath', () => {
  test('replaces slashes with dashes', () => {
    expect(encodeProjectPath('/Users/ilike')).toBe('-Users-ilike');
  });

  test('replaces dots with dashes', () => {
    expect(encodeProjectPath('/Users/ilike/.persona')).toBe('-Users-ilike--persona');
  });

  test('replaces CJK chars with dashes', () => {
    expect(encodeProjectPath('/Users/ilike/.persona/workspaces/p.sh维修'))
      .toBe('-Users-ilike--persona-workspaces-p-sh--');
  });

  test('preserves alphanumeric, underscore, hyphen', () => {
    expect(encodeProjectPath('abc-def_123')).toBe('abc-def_123');
  });

  test('handles spaces and special chars', () => {
    expect(encodeProjectPath('/path/to/my project (1)')).toBe('-path-to-my-project--1-');
  });
});

// ---------------------------------------------------------------------------
// parseClaudeTranscript
// ---------------------------------------------------------------------------

describe('parseClaudeTranscript', () => {
  test('returns null when file does not exist', () => {
    const result = parseClaudeTranscript(SESSION_ID, CWD, 100);
    expect(result).toBeNull();
  });

  test('returns null for empty file', () => {
    mkdirSync(PROJECT_DIR, { recursive: true });
    writeFileSync(JSONL_PATH, '');
    expect(parseClaudeTranscript(SESSION_ID, CWD, 100)).toBeNull();
  });

  test('parses user text messages as direction=in', () => {
    writeTranscript([
      {
        type: 'user',
        message: { role: 'user', content: 'hello world' },
        sessionId: SESSION_ID,
        timestamp: '2026-06-10T10:00:00Z',
      },
    ]);
    const result = parseClaudeTranscript(SESSION_ID, CWD, 100);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result![0].direction).toBe('in');
    expect(result![0].content).toBe('hello world');
    expect(result![0].sessionId).toBe(SESSION_ID);
    expect(result![0].timestamp).toBe(new Date('2026-06-10T10:00:00Z').getTime());
  });

  test('skips tool_result user messages', () => {
    writeTranscript([
      {
        type: 'user',
        message: { role: 'user', content: 'real prompt' },
        sessionId: SESSION_ID,
        timestamp: '2026-06-10T10:00:00Z',
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tool_1', content: 'some result' },
          ],
        },
        sessionId: SESSION_ID,
        timestamp: '2026-06-10T10:00:05Z',
      },
    ]);
    const result = parseClaudeTranscript(SESSION_ID, CWD, 100)!;
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('real prompt');
  });

  test('parses assistant text messages as direction=out', () => {
    writeTranscript([
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          id: 'msg_001',
          model: 'claude-opus-4-6',
          content: [{ type: 'text', text: 'Hello back!' }],
          usage: { input_tokens: 100, output_tokens: 20 },
        },
        sessionId: SESSION_ID,
        timestamp: '2026-06-10T10:00:01Z',
      },
    ]);
    const result = parseClaudeTranscript(SESSION_ID, CWD, 100)!;
    expect(result).toHaveLength(1);
    expect(result[0].direction).toBe('out');
    expect(result[0].content).toBe('Hello back!');
    expect(result[0].model).toBe('claude-opus-4-6');
    expect(result[0].provider).toBe('claude');
    expect(result[0].inputTokens).toBe(100);
    expect(result[0].outputTokens).toBe(20);
    expect(result[0].tokens).toBe(120);
  });

  test('groups assistant content blocks by message.id', () => {
    writeTranscript([
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          id: 'msg_002',
          model: 'claude-opus-4-6',
          content: [{ type: 'text', text: 'Part one.' }],
          usage: { input_tokens: 50, output_tokens: 10 },
        },
        sessionId: SESSION_ID,
        timestamp: '2026-06-10T10:00:01Z',
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          id: 'msg_002',
          content: [{ type: 'text', text: 'Part two.' }],
        },
        sessionId: SESSION_ID,
        timestamp: '2026-06-10T10:00:02Z',
      },
    ]);
    const result = parseClaudeTranscript(SESSION_ID, CWD, 100)!;
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('Part one.\n\nPart two.');
    expect(result[0].model).toBe('claude-opus-4-6');
  });

  test('extracts tool_use as ConversationToolCall', () => {
    writeTranscript([
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          id: 'msg_003',
          model: 'claude-opus-4-6',
          content: [
            { type: 'text', text: 'Let me check.' },
            { type: 'tool_use', id: 'tool_1', name: 'Bash', input: { command: 'ls' } },
          ],
        },
        sessionId: SESSION_ID,
        timestamp: '2026-06-10T10:00:01Z',
      },
    ]);
    const result = parseClaudeTranscript(SESSION_ID, CWD, 100)!;
    expect(result).toHaveLength(1);
    expect(result[0].tools).toHaveLength(1);
    expect(result[0].tools![0].name).toBe('Bash');
    expect(result[0].tools![0].id).toBe('tool_1');
    expect(result[0].tools![0].input).toContain('ls');
  });

  test('attaches tool_result to matching tool_use', () => {
    writeTranscript([
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          id: 'msg_004',
          content: [
            { type: 'tool_use', id: 'tool_2', name: 'Read', input: { file_path: '/tmp/x' } },
          ],
        },
        sessionId: SESSION_ID,
        timestamp: '2026-06-10T10:00:01Z',
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tool_2', content: 'file contents here', is_error: false },
          ],
        },
        sessionId: SESSION_ID,
        timestamp: '2026-06-10T10:00:02Z',
      },
    ]);
    const result = parseClaudeTranscript(SESSION_ID, CWD, 100)!;
    expect(result).toHaveLength(1);
    expect(result[0].tools![0].result).toBe('file contents here');
    expect(result[0].tools![0].isError).toBe(false);
  });

  test('skips thinking blocks', () => {
    writeTranscript([
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          id: 'msg_005',
          content: [
            { type: 'thinking', thinking: 'internal reasoning...' },
            { type: 'text', text: 'Visible answer.' },
          ],
        },
        sessionId: SESSION_ID,
        timestamp: '2026-06-10T10:00:01Z',
      },
    ]);
    const result = parseClaudeTranscript(SESSION_ID, CWD, 100)!;
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('Visible answer.');
    expect(result[0].content).not.toContain('internal reasoning');
  });

  test('skips non-message types', () => {
    writeTranscript([
      { type: 'custom-title', customTitle: 'test session' },
      { type: 'agent-name', agentName: 'director' },
      { type: 'queue-operation', operation: 'enqueue' },
      { type: 'attachment', content: 'something' },
      {
        type: 'user',
        message: { role: 'user', content: 'the only real message' },
        sessionId: SESSION_ID,
        timestamp: '2026-06-10T10:00:00Z',
      },
    ]);
    const result = parseClaudeTranscript(SESSION_ID, CWD, 100)!;
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('the only real message');
  });

  test('respects limit parameter', () => {
    writeTranscript([
      { type: 'user', message: { role: 'user', content: 'msg1' }, sessionId: SESSION_ID, timestamp: '2026-06-10T10:00:00Z' },
      { type: 'assistant', message: { role: 'assistant', id: 'a1', content: [{ type: 'text', text: 'reply1' }] }, sessionId: SESSION_ID, timestamp: '2026-06-10T10:00:01Z' },
      { type: 'user', message: { role: 'user', content: 'msg2' }, sessionId: SESSION_ID, timestamp: '2026-06-10T10:00:02Z' },
      { type: 'assistant', message: { role: 'assistant', id: 'a2', content: [{ type: 'text', text: 'reply2' }] }, sessionId: SESSION_ID, timestamp: '2026-06-10T10:00:03Z' },
      { type: 'user', message: { role: 'user', content: 'msg3' }, sessionId: SESSION_ID, timestamp: '2026-06-10T10:00:04Z' },
    ]);
    const result = parseClaudeTranscript(SESSION_ID, CWD, 3)!;
    expect(result).toHaveLength(3);
    // newest first
    expect(result[0].content).toBe('msg3');
    expect(result[1].content).toBe('reply2');
    expect(result[2].content).toBe('msg2');
  });

  test('returns newest-first order', () => {
    writeTranscript([
      { type: 'user', message: { role: 'user', content: 'first' }, sessionId: SESSION_ID, timestamp: '2026-06-10T10:00:00Z' },
      { type: 'user', message: { role: 'user', content: 'second' }, sessionId: SESSION_ID, timestamp: '2026-06-10T10:01:00Z' },
    ]);
    const result = parseClaudeTranscript(SESSION_ID, CWD, 100)!;
    expect(result[0].content).toBe('second');
    expect(result[1].content).toBe('first');
  });

  test('handles cache tokens in usage', () => {
    writeTranscript([
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          id: 'msg_006',
          content: [{ type: 'text', text: 'cached response' }],
          usage: {
            input_tokens: 10,
            cache_creation_input_tokens: 5000,
            cache_read_input_tokens: 3000,
            output_tokens: 50,
          },
        },
        sessionId: SESSION_ID,
        timestamp: '2026-06-10T10:00:01Z',
      },
    ]);
    const result = parseClaudeTranscript(SESSION_ID, CWD, 100)!;
    expect(result[0].inputTokens).toBe(8010); // 10 + 5000 + 3000
    expect(result[0].outputTokens).toBe(50);
    expect(result[0].tokens).toBe(8060);
  });

  test('full conversation round-trip', () => {
    writeTranscript([
      { type: 'custom-title', customTitle: 'test' },
      { type: 'user', message: { role: 'user', content: 'What files are here?' }, sessionId: SESSION_ID, timestamp: '2026-06-10T10:00:00Z' },
      {
        type: 'assistant',
        message: {
          role: 'assistant', id: 'msg_rt1', model: 'claude-opus-4-6',
          content: [
            { type: 'text', text: 'Let me check.' },
            { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } },
          ],
          usage: { input_tokens: 100, output_tokens: 30 },
        },
        sessionId: SESSION_ID, timestamp: '2026-06-10T10:00:01Z',
      },
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'file1.txt\nfile2.txt' }] },
        sessionId: SESSION_ID, timestamp: '2026-06-10T10:00:02Z',
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant', id: 'msg_rt2',
          content: [{ type: 'text', text: 'There are 2 files: file1.txt and file2.txt.' }],
          usage: { input_tokens: 200, output_tokens: 20 },
        },
        sessionId: SESSION_ID, timestamp: '2026-06-10T10:00:03Z',
      },
    ]);
    const result = parseClaudeTranscript(SESSION_ID, CWD, 100)!;
    expect(result).toHaveLength(3); // 1 user + 2 assistant
    // newest first
    expect(result[0].direction).toBe('out');
    expect(result[0].content).toContain('2 files');
    expect(result[1].direction).toBe('out');
    expect(result[1].tools).toHaveLength(1);
    expect(result[1].tools![0].result).toContain('file1.txt');
    expect(result[2].direction).toBe('in');
    expect(result[2].content).toBe('What files are here?');
  });
});
