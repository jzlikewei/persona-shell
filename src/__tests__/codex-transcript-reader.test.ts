import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { parseCodexTranscript, readCodexTranscriptModel } from '../codex-transcript-reader.js';

const TMP_DIR = '/tmp/persona-codex-transcript-test';
const SESSIONS_DIR = join(TMP_DIR, 'sessions');
const SESSION_ID = 'thread-codex-fixture-001';
const TRANSCRIPT_PATH = join(
  SESSIONS_DIR,
  '2026',
  '04',
  '14',
  `rollout-2026-04-14T20-37-01-${SESSION_ID}.jsonl`,
);

function writeTranscript(lines: object[]): void {
  mkdirSync(join(SESSIONS_DIR, '2026', '04', '14'), { recursive: true });
  writeFileSync(TRANSCRIPT_PATH, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
}

beforeEach(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

afterEach(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

describe('parseCodexTranscript', () => {
  test('returns null when transcript file is missing', () => {
    expect(parseCodexTranscript(SESSION_ID, 100, SESSIONS_DIR)).toBeNull();
  });

  test('parses sanitized native Codex transcript by thread id', () => {
    writeTranscript([
      {
        timestamp: '2026-04-14T12:37:02.001Z',
        type: 'session_meta',
        payload: {
          id: SESSION_ID,
          cwd: '/redacted/persona',
          originator: 'codex_exec',
        },
      },
      {
        timestamp: '2026-04-14T12:37:02.002Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-redacted-001' },
      },
      {
        timestamp: '2026-04-14T12:37:02.003Z',
        type: 'turn_context',
        payload: {
          turn_id: 'turn-redacted-001',
          model: 'gpt-5.4',
          collaboration_mode: { settings: { model: 'gpt-5.4' } },
        },
      },
      {
        timestamp: '2026-04-14T12:37:02.002Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '<environment_context>redacted</environment_context>' }],
        },
      },
      {
        timestamp: '2026-04-14T12:37:14.250Z',
        type: 'event_msg',
        payload: {
          type: 'agent_message',
          message: 'State loaded from native transcript.',
          phase: 'commentary',
        },
      },
      {
        timestamp: '2026-04-14T12:37:14.253Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'State loaded from native transcript.' }],
          phase: 'commentary',
        },
      },
      {
        timestamp: '2026-04-14T12:37:14.683Z',
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 'turn-redacted-001' },
      },
      {
        timestamp: '2026-04-14T12:37:44.357Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-redacted-002' },
      },
      {
        timestamp: '2026-04-14T12:37:44.358Z',
        type: 'turn_context',
        payload: {
          turn_id: 'turn-redacted-002',
          model: 'gpt-5.5',
          collaboration_mode: { settings: { model: 'gpt-5.5' } },
        },
      },
      {
        timestamp: '2026-04-14T12:37:44.358Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '[group: redacted] Report your status.' }],
        },
      },
      {
        timestamp: '2026-04-14T12:37:52.148Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Status from native transcript: ready.' }],
          phase: 'final_answer',
        },
      },
      {
        timestamp: '2026-04-14T12:37:52.528Z',
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 'turn-redacted-002' },
      },
    ]);

    const result = parseCodexTranscript(SESSION_ID, 100, SESSIONS_DIR);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(3);
    expect(result!.some((msg) => msg.direction === 'in' && msg.content.includes('Report your status'))).toBe(true);
    expect(result!.some((msg) => msg.direction === 'out' && msg.content.includes('Status from native transcript'))).toBe(true);
    expect(result!.find((msg) => msg.direction === 'out' && msg.content.includes('Status from native transcript'))?.model).toBe('gpt-5.5');
    expect(result!.some((msg) => msg.content.includes('environment_context'))).toBe(false);
    expect(result!.every((msg) => msg.sessionId === SESSION_ID)).toBe(true);
    expect(readCodexTranscriptModel(SESSION_ID, SESSIONS_DIR)).toBe('gpt-5.5');
  });

  test('shows raw user text while preserving agent-facing time-synced input', () => {
    writeTranscript([
      {
        timestamp: '2026-06-18T07:27:58.001Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-001' },
      },
      {
        timestamp: '2026-06-18T07:27:58.002Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '[2026/6/18 15:27:58] 看下这个问题' }],
        },
      },
      {
        timestamp: '2026-06-18T07:28:00.000Z',
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 'turn-001' },
      },
    ]);

    const result = parseCodexTranscript(SESSION_ID, 100, SESSIONS_DIR);
    expect(result).not.toBeNull();
    expect(result![0]).toMatchObject({
      direction: 'in',
      content: '看下这个问题',
      agentContent: '[2026/6/18 15:27:58] 看下这个问题',
    });
  });

  test('falls back to collaboration mode model when top-level model is absent', () => {
    writeTranscript([
      {
        timestamp: '2026-06-18T07:27:58.001Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-001' },
      },
      {
        timestamp: '2026-06-18T07:27:58.002Z',
        type: 'turn_context',
        payload: {
          turn_id: 'turn-001',
          collaboration_mode: { settings: { model: 'gpt-5.6' } },
        },
      },
      {
        timestamp: '2026-06-18T07:27:58.003Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'done' }],
        },
      },
      {
        timestamp: '2026-06-18T07:28:00.000Z',
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 'turn-001' },
      },
    ]);

    const result = parseCodexTranscript(SESSION_ID, 100, SESSIONS_DIR);
    expect(result?.[0]?.model).toBe('gpt-5.6');
    expect(readCodexTranscriptModel(SESSION_ID, SESSIONS_DIR)).toBe('gpt-5.6');
  });
});
