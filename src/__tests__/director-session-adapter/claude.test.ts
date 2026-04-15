import { describe, expect, test } from 'bun:test';
import { ClaudeSessionAdapter } from '../../director-session-adapter/claude.js';
import type {
  DirectorSessionAdapterHooks,
  DirectorSessionAdapterOptions,
  DirectorTurnResult,
} from '../../director-session-adapter/index.js';
import { ClaudeDirectorRuntime } from '../../director-runtime/claude.js';

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
    directorAgent: { type: 'claude', command: 'echo', name: 'fake' },
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

// ────────────────────────────────────────────────────────────────
// Additional tests for uncovered branches
// ────────────────────────────────────────────────────────────────

/**
 * Build capturing hooks that also track persistSession / clearSession calls.
 */
function buildCapturingHooksEx() {
  const base = buildCapturingHooks();

  const persistedSessions: Array<{ sessionId: string; sessionName: string | null }> = [];
  const clearSessionCalls: number[] = [];

  base.hooks.persistSession = (sessionId, sessionName) => {
    persistedSessions.push({ sessionId, sessionName });
  };
  base.hooks.clearSession = () => {
    clearSessionCalls.push(1);
  };

  return { ...base, persistedSessions, clearSessionCalls };
}

describe('ClaudeSessionAdapter.handleLine – system init', () => {
  test('calls persistSession with session_id on system init event', () => {
    const initEvent = JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 'sess-abc-123',
    });

    const { hooks, persistedSessions, turns } = buildCapturingHooksEx();
    // Make getSessionName return a known value so we can assert the second arg
    hooks.getSessionName = () => 'my-session-name';
    const adapter = createTestAdapter(hooks);
    const handleLine = getHandleLine(adapter);

    handleLine(initEvent);

    expect(persistedSessions).toHaveLength(1);
    expect(persistedSessions[0].sessionId).toBe('sess-abc-123');
    expect(persistedSessions[0].sessionName).toBe('my-session-name');
    // system init should NOT trigger onTurnComplete
    expect(turns).toHaveLength(0);
  });

  test('ignores system event without init subtype', () => {
    const otherSystemEvent = JSON.stringify({
      type: 'system',
      subtype: 'other',
      session_id: 'sess-xyz',
    });

    const { hooks, persistedSessions } = buildCapturingHooksEx();
    const adapter = createTestAdapter(hooks);
    const handleLine = getHandleLine(adapter);

    handleLine(otherSystemEvent);

    expect(persistedSessions).toHaveLength(0);
  });

  test('ignores system init event when session_id is not a string', () => {
    const initEventBadId = JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 12345,
    });

    const { hooks, persistedSessions } = buildCapturingHooksEx();
    const adapter = createTestAdapter(hooks);
    const handleLine = getHandleLine(adapter);

    handleLine(initEventBadId);

    expect(persistedSessions).toHaveLength(0);
  });
});

describe('ClaudeSessionAdapter.handleLine – session expired', () => {
  test('calls clearSession and does NOT trigger onTurnComplete when session expired error', () => {
    const expiredEvent = JSON.stringify({
      type: 'result',
      is_error: true,
      errors: ['No conversation found with that ID'],
      duration_ms: 0,
      num_turns: 0,
      usage: {},
    });

    const { hooks, clearSessionCalls, turns, metrics } = buildCapturingHooksEx();
    const adapter = createTestAdapter(hooks);
    const handleLine = getHandleLine(adapter);

    handleLine(expiredEvent);

    expect(clearSessionCalls).toHaveLength(1);
    // Should NOT call onTurnComplete or onMetrics
    expect(turns).toHaveLength(0);
    expect(metrics).toHaveLength(0);
  });

  test('does not trigger clearSession for non-matching error', () => {
    const otherError = JSON.stringify({
      type: 'result',
      is_error: true,
      errors: ['Rate limit exceeded'],
      duration_ms: 0,
      num_turns: 0,
      usage: {},
    });

    const { hooks, clearSessionCalls, turns } = buildCapturingHooksEx();
    const adapter = createTestAdapter(hooks);
    const handleLine = getHandleLine(adapter);

    handleLine(otherError);

    expect(clearSessionCalls).toHaveLength(0);
    // Non-matching is_error still falls through to normal result handling
    expect(turns).toHaveLength(1);
  });
});

describe('ClaudeSessionAdapter.handleLine – stream_event edge cases', () => {
  test('non text_delta stream_event does not trigger onChunk', () => {
    const inputJsonDelta = JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: '{}' },
      },
    });

    const { hooks, chunks } = buildCapturingHooks();
    const adapter = createTestAdapter(hooks);
    const handleLine = getHandleLine(adapter);

    handleLine(inputJsonDelta);

    expect(chunks).toHaveLength(0);
  });

  test('stream_event with non content_block_delta type does not trigger onChunk', () => {
    const otherStream = JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: { id: 'msg_1', type: 'message' },
      },
    });

    const { hooks, chunks } = buildCapturingHooks();
    const adapter = createTestAdapter(hooks);
    const handleLine = getHandleLine(adapter);

    handleLine(otherStream);

    expect(chunks).toHaveLength(0);
  });
});

describe('ClaudeSessionAdapter.handleLine – malformed JSON', () => {
  test('malformed JSON line is ignored and does not throw', () => {
    const { hooks, turns, chunks, metrics } = buildCapturingHooksEx();
    const adapter = createTestAdapter(hooks);
    const handleLine = getHandleLine(adapter);

    // Should not throw
    expect(() => handleLine('this is not json {')).not.toThrow();
    expect(() => handleLine('')).not.toThrow();
    expect(() => handleLine('{broken')).not.toThrow();

    expect(turns).toHaveLength(0);
    expect(chunks).toHaveLength(0);
    expect(metrics).toHaveLength(0);
  });

  test('malformed JSON still calls logOutput', () => {
    const { hooks, loggedLines } = buildCapturingHooks();
    const adapter = createTestAdapter(hooks);
    const handleLine = getHandleLine(adapter);

    handleLine('not json at all');

    expect(loggedLines).toHaveLength(1);
    expect(loggedLines[0]).toBe('not json at all');
  });
});

describe('ClaudeSessionAdapter.handleLine – metrics edge cases', () => {
  test('empty usage object: lastInputTokens not set', () => {
    const resultEvent = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 100,
      num_turns: 1,
      result: 'ok',
      usage: {},
    });

    const { hooks, metrics } = buildCapturingHooks();
    const adapter = createTestAdapter(hooks);
    const handleLine = getHandleLine(adapter);

    handleLine(resultEvent);

    expect(metrics).toHaveLength(1);
    // totalInput = 0, so lastInputTokens should not be set
    expect(metrics[0].lastInputTokens).toBeUndefined();
  });

  test('num_turns 0 with nonzero input: lastInputTokens not set (divide by 0 guard)', () => {
    const resultEvent = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 100,
      num_turns: 0,
      result: 'ok',
      usage: { input_tokens: 500 },
    });

    const { hooks, metrics } = buildCapturingHooks();
    const adapter = createTestAdapter(hooks);
    const handleLine = getHandleLine(adapter);

    handleLine(resultEvent);

    expect(metrics).toHaveLength(1);
    // numTurns is 0, guard should prevent setting lastInputTokens
    expect(metrics[0].lastInputTokens).toBeUndefined();
  });

  test('no modelUsage: contextWindow not set', () => {
    const resultEvent = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 100,
      num_turns: 1,
      result: 'ok',
      usage: { input_tokens: 100 },
    });

    const { hooks, metrics } = buildCapturingHooks();
    const adapter = createTestAdapter(hooks);
    const handleLine = getHandleLine(adapter);

    handleLine(resultEvent);

    expect(metrics).toHaveLength(1);
    expect(metrics[0].contextWindow).toBeUndefined();
  });

  test('no cost_usd: costUsd not set', () => {
    const resultEvent = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 100,
      num_turns: 1,
      result: 'ok',
      usage: {},
    });

    const { hooks, metrics } = buildCapturingHooks();
    const adapter = createTestAdapter(hooks);
    const handleLine = getHandleLine(adapter);

    handleLine(resultEvent);

    expect(metrics).toHaveLength(1);
    expect(metrics[0].costUsd).toBeUndefined();
  });

  test('duration_ms non-number: durationMs is null', () => {
    const resultEvent = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 'not-a-number',
      num_turns: 1,
      result: 'ok',
      usage: {},
    });

    const { hooks, turns } = buildCapturingHooks();
    const adapter = createTestAdapter(hooks);
    const handleLine = getHandleLine(adapter);

    handleLine(resultEvent);

    expect(turns).toHaveLength(1);
    expect(turns[0].durationMs).toBeNull();
  });

  test('modelUsage with contextWindow 0 is skipped', () => {
    const resultEvent = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 100,
      num_turns: 1,
      result: 'ok',
      usage: {},
      modelUsage: { 'some-model': { contextWindow: 0 } },
    });

    const { hooks, metrics } = buildCapturingHooks();
    const adapter = createTestAdapter(hooks);
    const handleLine = getHandleLine(adapter);

    handleLine(resultEvent);

    expect(metrics).toHaveLength(1);
    expect(metrics[0].contextWindow).toBeUndefined();
  });

  test('modelUsage with non-number contextWindow is skipped', () => {
    const resultEvent = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 100,
      num_turns: 1,
      result: 'ok',
      usage: {},
      modelUsage: { 'some-model': { contextWindow: 'big' } },
    });

    const { hooks, metrics } = buildCapturingHooks();
    const adapter = createTestAdapter(hooks);
    const handleLine = getHandleLine(adapter);

    handleLine(resultEvent);

    expect(metrics).toHaveLength(1);
    expect(metrics[0].contextWindow).toBeUndefined();
  });
});

describe('ClaudeSessionAdapter – public methods', () => {
  test('shouldSkipInterruptWhileFlushing() returns true', () => {
    const { hooks } = buildCapturingHooks();
    const adapter = createTestAdapter(hooks);
    expect(adapter.shouldSkipInterruptWhileFlushing()).toBe(true);
  });

  test('shouldTrackRestartBackoff() returns true', () => {
    const { hooks } = buildCapturingHooks();
    const adapter = createTestAdapter(hooks);
    expect(adapter.shouldTrackRestartBackoff()).toBe(true);
  });

  test('describeSessionReady returns formatted string', () => {
    const { hooks } = buildCapturingHooks();
    const adapter = createTestAdapter(hooks);
    expect(adapter.describeSessionReady('myLabel', 'id-1', 'name-1')).toBe(
      '[bridge:myLabel] Pipes connected',
    );
  });

  test('describeInterruptTarget returns null when pid is null', () => {
    const { hooks } = buildCapturingHooks();
    const adapter = createTestAdapter(hooks);
    // dummy runtime has no spawned process, so getPid() returns null
    expect(adapter.describeInterruptTarget()).toBeNull();
  });
});
