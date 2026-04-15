import { describe, expect, test } from 'bun:test';
import { ClaudeSessionAdapter } from './claude.js';
import type {
  DirectorSessionAdapterHooks,
  DirectorSessionAdapterOptions,
  DirectorTurnResult,
} from './index.js';
import { ClaudeDirectorRuntime } from '../director-runtime/claude.js';

/**
 * Build a minimal hooks object that captures onTurnComplete calls.
 * We only need the hooks that handleLine actually invokes.
 */
function buildCapturingHooks() {
  const turns: DirectorTurnResult[] = [];
  const chunks: string[] = [];
  const loggedLines: string[] = [];
  const metrics: Array<Record<string, unknown>> = [];

  const hooks: DirectorSessionAdapterHooks = {
    restorePersistedSession: () => ({ sessionId: null, sessionName: null }),
    persistSession: () => {},
    clearSession: () => {},
    getSessionId: () => null,
    getSessionName: () => null,
    setSessionName: () => {},
    buildSessionName: () => 'test-session',
    logOutput: (line) => loggedLines.push(line),
    onChunk: (text) => chunks.push(text),
    onMetrics: (update) => metrics.push(update as Record<string, unknown>),
    onTurnComplete: (result) => turns.push(result),
    onTurnFailure: () => {},
    onRuntimeClosed: () => {},
  };

  return { hooks, turns, chunks, loggedLines, metrics };
}

/**
 * Access the private handleLine method for direct unit testing.
 * This is the core parsing logic that converts Claude CLI JSON output
 * into hook calls (onTurnComplete, onChunk, onMetrics).
 */
function getHandleLine(adapter: ClaudeSessionAdapter): (line: string) => void {
  // Access private method via prototype for testing
  return (adapter as unknown as { handleLine(line: string): void }).handleLine.bind(adapter);
}

function createTestAdapter(hooks: DirectorSessionAdapterHooks): ClaudeSessionAdapter {
  const options: DirectorSessionAdapterOptions = {
    label: 'test',
    isMain: false,
    config: {
      persona_dir: '/tmp/persona-test',
      pipe_dir: '/tmp/persona-test',
      pid_file: '/tmp/persona-test/test.pid',
      time_sync_interval_ms: 999999,
      flush_context_limit: 999999,
      flush_interval_ms: 999999,
      quote_max_length: 32,
    },
    agents: {
      defaults: { director: 'fake', default: 'fake' },
      providers: { fake: { type: 'claude', command: 'echo' } },
    },
    directorAgent: { type: 'claude', command: 'echo' },
    logDir: '/tmp/persona-test/logs',
  };

  // Construct adapter with a dummy runtime (we won't call start/send, only handleLine)
  const runtime = new ClaudeDirectorRuntime({
    pipeDir: '/tmp/persona-test',
    pidFile: '/tmp/persona-test/test.pid',
    label: 'test',
  });
  return new ClaudeSessionAdapter(runtime, options, hooks);
}

describe('ClaudeSessionAdapter.handleLine', () => {
  test('extracts responseText from result event with "result" field (Claude CLI format)', () => {
    // This is the actual format Claude CLI emits — responseText is in event.result, NOT event.message.content
    const resultEvent = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 2042,
      num_turns: 1,
      result: 'hi！有什么事？',
      session_id: 'test-session-id',
      cost_usd: 0.05,
      usage: { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    });

    const { hooks, turns } = buildCapturingHooks();
    const adapter = createTestAdapter(hooks);
    const handleLine = getHandleLine(adapter);

    handleLine(resultEvent);

    expect(turns).toHaveLength(1);
    expect(turns[0].responseText).toBe('hi！有什么事？');
    expect(turns[0].durationMs).toBe(2042);
  });

  test('extracts responseText from result event with message.content string', () => {
    // Hypothetical format where response is in message.content as a string
    const resultEvent = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 100,
      num_turns: 1,
      message: { content: 'hello from message' },
      usage: {},
    });

    const { hooks, turns } = buildCapturingHooks();
    const adapter = createTestAdapter(hooks);
    const handleLine = getHandleLine(adapter);

    handleLine(resultEvent);

    expect(turns).toHaveLength(1);
    expect(turns[0].responseText).toBe('hello from message');
  });

  test('extracts responseText from result event with message.content blocks', () => {
    // Hypothetical format where response is in message.content as block array
    const resultEvent = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 200,
      num_turns: 1,
      message: {
        content: [
          { type: 'text', text: 'part1 ' },
          { type: 'text', text: 'part2' },
        ],
      },
      usage: {},
    });

    const { hooks, turns } = buildCapturingHooks();
    const adapter = createTestAdapter(hooks);
    const handleLine = getHandleLine(adapter);

    handleLine(resultEvent);

    expect(turns).toHaveLength(1);
    expect(turns[0].responseText).toBe('part1 part2');
  });

  test('returns empty string when result event has no response text at all', () => {
    const resultEvent = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 50,
      num_turns: 1,
      usage: {},
    });

    const { hooks, turns } = buildCapturingHooks();
    const adapter = createTestAdapter(hooks);
    const handleLine = getHandleLine(adapter);

    handleLine(resultEvent);

    expect(turns).toHaveLength(1);
    expect(turns[0].responseText).toBe('');
  });

  test('prefers result field over message.content when both exist', () => {
    const resultEvent = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 100,
      num_turns: 1,
      result: 'from result field',
      message: { content: 'from message field' },
      usage: {},
    });

    const { hooks, turns } = buildCapturingHooks();
    const adapter = createTestAdapter(hooks);
    const handleLine = getHandleLine(adapter);

    handleLine(resultEvent);

    expect(turns).toHaveLength(1);
    expect(turns[0].responseText).toBe('from result field');
  });

  test('dispatches stream_event chunks to onChunk hook', () => {
    const streamEvent = JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'hello' },
      },
    });

    const { hooks, chunks } = buildCapturingHooks();
    const adapter = createTestAdapter(hooks);
    const handleLine = getHandleLine(adapter);

    handleLine(streamEvent);

    expect(chunks).toEqual(['hello']);
  });

  test('extracts metrics from result event', () => {
    const resultEvent = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 500,
      num_turns: 2,
      result: 'response',
      cost_usd: 0.123,
      usage: { input_tokens: 1000, cache_creation_input_tokens: 500, cache_read_input_tokens: 200 },
      modelUsage: {
        'claude-opus-4-6': { contextWindow: 1000000 },
      },
    });

    const { hooks, metrics } = buildCapturingHooks();
    const adapter = createTestAdapter(hooks);
    const handleLine = getHandleLine(adapter);

    handleLine(resultEvent);

    expect(metrics).toHaveLength(1);
    expect(metrics[0].lastInputTokens).toBe(850); // (1000+500+200) / 2
    expect(metrics[0].contextWindow).toBe(1000000);
    expect(metrics[0].costUsd).toBe(0.123);
  });
});
