import { describe, expect, test } from 'bun:test';
import { isBashAction, extractBashCommand, runBashAction } from '../task/shell-bash.js';

describe('isBashAction', () => {
  test('returns true for ! prefix', () => {
    expect(isBashAction('!echo hello')).toBe(true);
    expect(isBashAction('!cd /tmp && ls')).toBe(true);
    expect(isBashAction('!')).toBe(true);
  });

  test('returns false for non-! strings', () => {
    expect(isBashAction('flush')).toBe(false);
    expect(isBashAction('check_feishu')).toBe(false);
    expect(isBashAction('')).toBe(false);
  });

  test('returns false for null/undefined', () => {
    expect(isBashAction(null)).toBe(false);
    expect(isBashAction(undefined)).toBe(false);
  });
});

describe('extractBashCommand', () => {
  test('strips ! prefix', () => {
    expect(extractBashCommand('!echo hello')).toBe('echo hello');
    expect(extractBashCommand('!cd /path && ./run.sh')).toBe('cd /path && ./run.sh');
  });

  test('handles bare !', () => {
    expect(extractBashCommand('!')).toBe('');
  });
});

describe('runBashAction', () => {
  test('executes simple command and returns stdout', async () => {
    const result = await runBashAction('echo hello');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello');
  });

  test('captures stderr separately', async () => {
    const result = await runBashAction('echo err >&2');
    expect(result.exitCode).toBe(0);
    expect(result.stderr.trim()).toBe('err');
  });

  test('throws on non-zero exit code', async () => {
    await expect(runBashAction('exit 1')).rejects.toThrow();
  });

  test('thrown error contains exit code', async () => {
    try {
      await runBashAction('exit 42');
      expect(true).toBe(false); // should not reach
    } catch (err: unknown) {
      const e = err as { code?: number };
      expect(e.code).toBe(42);
    }
  });

  test('thrown error contains stderr from failed command', async () => {
    try {
      await runBashAction('echo bad >&2; exit 1');
      expect(true).toBe(false);
    } catch (err: unknown) {
      const e = err as { stderr?: string };
      expect(e.stderr).toContain('bad');
    }
  });

  test('supports multi-command pipelines', async () => {
    const result = await runBashAction('echo "line1\nline2" | wc -l');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('2');
  });

  test('supports custom timeout', async () => {
    try {
      await runBashAction('sleep 1', { timeoutMs: 50 });
      expect(true).toBe(false);
    } catch (err: unknown) {
      const e = err as { code?: string };
      expect(e.code).toBe('ETIMEDOUT');
    }
  });
});
