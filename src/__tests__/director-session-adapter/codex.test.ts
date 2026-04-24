import { beforeEach, describe, expect, test } from 'bun:test';
import { CodexSessionAdapter } from '../../director-session-adapter/codex.js';
import type {
  DirectorSessionAdapterHooks,
  DirectorSessionAdapterOptions,
  DirectorTurnResult,
  DirectorSessionMetricsUpdate,
} from '../../director-session-adapter/index.js';

// ── Helpers ──────────────────────────────────────────────────────────

function buildCapturingHooks() {
  const turns: DirectorTurnResult[] = [];
  const failures: string[] = [];
  const metrics: DirectorSessionMetricsUpdate[] = [];
  const loggedLines: string[] = [];
  const persistedSessions: Array<{ id: string; name: string | null }> = [];
  let sessionId: string | null = null;
  let sessionName: string | null = null;

  const hooks: DirectorSessionAdapterHooks = {
    restorePersistedSession: () => ({ sessionId, sessionName }),
    persistSession: (id, name) => { sessionId = id; persistedSessions.push({ id, name }); },
    clearSession: () => { sessionId = null; },
    getSessionId: () => sessionId,
    getSessionName: () => sessionName,
    setSessionName: (name) => { sessionName = name; },
    buildSessionName: () => 'test-codex-session',
    logOutput: (line) => loggedLines.push(line),
    onChunk: () => {},
    onMetrics: (update) => metrics.push(update),
    onTurnComplete: (result) => turns.push(result),
    onTurnFailure: (msg) => failures.push(msg),
    onRuntimeClosed: () => {},
  };

  return { hooks, turns, failures, metrics, loggedLines, persistedSessions, setSessionId: (id: string | null) => { sessionId = id; } };
}

function buildOptions(): DirectorSessionAdapterOptions {
  return {
    label: 'test-codex',
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
      providers: { fake: { type: 'codex', command: 'echo' } },
    },
    directorAgent: { type: 'codex', command: 'echo', name: 'fake' },
    logDir: '/tmp/persona-test/logs',
  };
}

/**
 * Access private handleLine / handleClose methods for testing.
 * These are the core parsing logic — we test them directly
 * to avoid needing to spawn real Codex processes.
 */
function getPrivateMethods(adapter: CodexSessionAdapter) {
  const a = adapter as unknown as {
    handleLine(line: string, sessionName: string): void;
    handleClose(event: {
      code: number | null;
      startedAt: number;
      currentResponse: string;
      sawTurnCompleted: boolean;
      lastErrorMessage?: string;
      recentLines?: string[];
      stderrTail?: string[];
    }): void;
  };
  return {
    handleLine: a.handleLine.bind(adapter),
    handleClose: a.handleClose.bind(adapter),
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('CodexSessionAdapter', () => {
  describe('start', () => {
    test('returns true (freshStart) when no existing session', async () => {
      const { hooks } = buildCapturingHooks();
      const adapter = new CodexSessionAdapter(buildOptions(), hooks);
      const freshStart = await adapter.start();
      expect(freshStart).toBe(true);
    });

    test('returns false when resuming existing session', async () => {
      const { hooks, setSessionId } = buildCapturingHooks();
      setSessionId('existing-thread-id');
      const adapter = new CodexSessionAdapter(buildOptions(), hooks);
      const freshStart = await adapter.start();
      expect(freshStart).toBe(false);
    });
  });

  describe('capability methods', () => {
    test('isReady always returns true', () => {
      const { hooks } = buildCapturingHooks();
      const adapter = new CodexSessionAdapter(buildOptions(), hooks);
      expect(adapter.isReady()).toBe(true);
    });

    test('shouldSkipInterruptWhileFlushing returns false', () => {
      const { hooks } = buildCapturingHooks();
      const adapter = new CodexSessionAdapter(buildOptions(), hooks);
      expect(adapter.shouldSkipInterruptWhileFlushing()).toBe(false);
    });

    test('shouldTrackRestartBackoff returns false', () => {
      const { hooks } = buildCapturingHooks();
      const adapter = new CodexSessionAdapter(buildOptions(), hooks);
      expect(adapter.shouldTrackRestartBackoff()).toBe(false);
    });

    test('describeInterruptTarget returns null', () => {
      const { hooks } = buildCapturingHooks();
      const adapter = new CodexSessionAdapter(buildOptions(), hooks);
      expect(adapter.describeInterruptTarget()).toBeNull();
    });
  });

  describe('describeSessionReady', () => {
    test('shows (new) for fresh session', () => {
      const { hooks } = buildCapturingHooks();
      const adapter = new CodexSessionAdapter(buildOptions(), hooks);
      const msg = adapter.describeSessionReady('test', null, null);
      expect(msg).toBe('[bridge:test] Codex session ready (new)');
    });

    test('includes session name when resuming', () => {
      const { hooks } = buildCapturingHooks();
      const adapter = new CodexSessionAdapter(buildOptions(), hooks);
      const msg = adapter.describeSessionReady('test', 'thread-123', 'my-session');
      expect(msg).toBe('[bridge:test] Codex session ready (my-session)');
    });

    test('works with session id but no name', () => {
      const { hooks } = buildCapturingHooks();
      const adapter = new CodexSessionAdapter(buildOptions(), hooks);
      const msg = adapter.describeSessionReady('test', 'thread-123', null);
      expect(msg).toBe('[bridge:test] Codex session ready');
    });
  });

  describe('handleLine', () => {
    test('persists session on thread.started event', () => {
      const { hooks, persistedSessions } = buildCapturingHooks();
      const adapter = new CodexSessionAdapter(buildOptions(), hooks);
      const { handleLine } = getPrivateMethods(adapter);

      handleLine(JSON.stringify({ type: 'thread.started', thread_id: 'thread-abc' }), 'my-session');

      expect(persistedSessions).toHaveLength(1);
      expect(persistedSessions[0]).toEqual({ id: 'thread-abc', name: 'my-session' });
    });

    test('reports metrics on turn.completed event', () => {
      const { hooks, metrics } = buildCapturingHooks();
      const adapter = new CodexSessionAdapter(buildOptions(), hooks);
      const { handleLine } = getPrivateMethods(adapter);

      handleLine(JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 5000 },
      }), 'my-session');

      expect(metrics).toHaveLength(1);
      expect(metrics[0].lastInputTokens).toBe(5000);
    });

    test('skips metrics when input_tokens is 0', () => {
      const { hooks, metrics } = buildCapturingHooks();
      const adapter = new CodexSessionAdapter(buildOptions(), hooks);
      const { handleLine } = getPrivateMethods(adapter);

      handleLine(JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 0 },
      }), 'my-session');

      expect(metrics).toHaveLength(0);
    });

    test('logs every line', () => {
      const { hooks, loggedLines } = buildCapturingHooks();
      const adapter = new CodexSessionAdapter(buildOptions(), hooks);
      const { handleLine } = getPrivateMethods(adapter);

      handleLine('{"type":"unknown"}', 'sess');
      handleLine('not json', 'sess');

      expect(loggedLines).toEqual(['{"type":"unknown"}', 'not json']);
    });

    test('ignores malformed JSON without throwing', () => {
      const { hooks } = buildCapturingHooks();
      const adapter = new CodexSessionAdapter(buildOptions(), hooks);
      const { handleLine } = getPrivateMethods(adapter);

      expect(() => handleLine('not-json', 'sess')).not.toThrow();
    });
  });

  describe('handleClose', () => {
    test('calls onTurnComplete on successful close', () => {
      const { hooks, turns } = buildCapturingHooks();
      const adapter = new CodexSessionAdapter(buildOptions(), hooks);
      const { handleClose } = getPrivateMethods(adapter);

      const startedAt = Date.now() - 1000;
      handleClose({ code: 0, startedAt, currentResponse: '  hello world  ', sawTurnCompleted: true });

      expect(turns).toHaveLength(1);
      expect(turns[0].responseText).toBe('hello world');
      expect(turns[0].durationMs).toBeGreaterThanOrEqual(1000);
    });

    test('calls onTurnFailure on non-zero exit code', () => {
      const { hooks, failures, turns } = buildCapturingHooks();
      const adapter = new CodexSessionAdapter(buildOptions(), hooks);
      const { handleClose } = getPrivateMethods(adapter);

      handleClose({ code: 1, startedAt: Date.now(), currentResponse: '', sawTurnCompleted: false });

      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain('code 1');
      expect(turns).toHaveLength(0);
    });

    test('calls onTurnFailure when sawTurnCompleted is false even with code 0', () => {
      const { hooks, failures, turns } = buildCapturingHooks();
      const adapter = new CodexSessionAdapter(buildOptions(), hooks);
      const { handleClose } = getPrivateMethods(adapter);

      handleClose({ code: 0, startedAt: Date.now(), currentResponse: 'partial', sawTurnCompleted: false });

      expect(failures).toHaveLength(1);
      expect(turns).toHaveLength(0);
    });

    test('calls onTurnFailure on null exit code', () => {
      const { hooks, failures } = buildCapturingHooks();
      const adapter = new CodexSessionAdapter(buildOptions(), hooks);
      const { handleClose } = getPrivateMethods(adapter);

      handleClose({ code: null, startedAt: Date.now(), currentResponse: '', sawTurnCompleted: false });

      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain('null');
    });

    test('includes lastErrorMessage in failure message when present', () => {
      const { hooks, failures } = buildCapturingHooks();
      const adapter = new CodexSessionAdapter(buildOptions(), hooks);
      const { handleClose } = getPrivateMethods(adapter);

      handleClose({
        code: 1,
        startedAt: Date.now(),
        currentResponse: '',
        sawTurnCompleted: false,
        lastErrorMessage: 'unexpected status 402 Payment Required: Insufficient credits',
      });

      expect(failures).toHaveLength(1);
      expect(failures[0]).toBe('codex exited with code 1: unexpected status 402 Payment Required: Insufficient credits');
    });

    test('omits lastErrorMessage from failure message when absent', () => {
      const { hooks, failures } = buildCapturingHooks();
      const adapter = new CodexSessionAdapter(buildOptions(), hooks);
      const { handleClose } = getPrivateMethods(adapter);

      handleClose({ code: 1, startedAt: Date.now(), currentResponse: '', sawTurnCompleted: false });

      expect(failures).toHaveLength(1);
      expect(failures[0]).toBe('codex exited with code 1');
    });

    test('includes stderr tail and recent events when available', () => {
      const { hooks, failures } = buildCapturingHooks();
      const adapter = new CodexSessionAdapter(buildOptions(), hooks);
      const { handleClose } = getPrivateMethods(adapter);

      handleClose({
        code: 0,
        startedAt: Date.now(),
        currentResponse: 'partial',
        sawTurnCompleted: false,
        stderrTail: ['Reading additional input from stdin...', 'tool call failed'],
        recentLines: ['{"type":"item.completed"}', '{"type":"agent_reasoning"}'],
      });

      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain('codex exited with code 0');
      expect(failures[0]).toContain('stderr: Reading additional input from stdin... | tool call failed');
      expect(failures[0]).toContain('recent events: {"type":"item.completed"} | {"type":"agent_reasoning"}');
    });

    test('keeps explicit lastErrorMessage ahead of captured context', () => {
      const { hooks, failures } = buildCapturingHooks();
      const adapter = new CodexSessionAdapter(buildOptions(), hooks);
      const { handleClose } = getPrivateMethods(adapter);

      handleClose({
        code: 1,
        startedAt: Date.now(),
        currentResponse: '',
        sawTurnCompleted: false,
        lastErrorMessage: 'unexpected status 500',
        stderrTail: ['stderr line'],
        recentLines: ['{"type":"turn.failed"}'],
      });

      expect(failures).toHaveLength(1);
      expect(failures[0]).toBe('codex exited with code 1: unexpected status 500 | stderr: stderr line | recent events: {"type":"turn.failed"}');
    });

    test('separates multiple agent_message segments with newlines in response', () => {
      const { hooks, turns } = buildCapturingHooks();
      const adapter = new CodexSessionAdapter(buildOptions(), hooks);
      const { handleClose } = getPrivateMethods(adapter);

      // Simulate what CodexDirectorRuntime would produce:
      // multiple item.completed texts concatenated with \n separators
      const response = 'First paragraph' + '\n' + 'Second paragraph' + '\n' + 'Third paragraph';

      handleClose({ code: 0, startedAt: Date.now() - 500, currentResponse: response, sawTurnCompleted: true });

      expect(turns).toHaveLength(1);
      expect(turns[0].responseText).toContain('First paragraph\nSecond paragraph\nThird paragraph');
    });
  });
});
