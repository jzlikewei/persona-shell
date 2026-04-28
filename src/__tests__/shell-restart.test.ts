import { describe, expect, test } from 'bun:test';
import { buildShellRestartBlockedMessage, parseShellRestartCommand } from '../shell-restart.js';

describe('shell restart helpers', () => {
  test('parses normal shell restart commands', () => {
    expect(parseShellRestartCommand('/shell-restart')).toEqual({ force: false });
    expect(parseShellRestartCommand('/restart-shell')).toEqual({ force: false });
  });

  test('parses forced shell restart commands', () => {
    expect(parseShellRestartCommand('/shell-restart --force')).toEqual({ force: true });
    expect(parseShellRestartCommand('/restart-shell --force')).toEqual({ force: true });
  });

  test('ignores unrelated commands', () => {
    expect(parseShellRestartCommand('/shell-restart now')).toBeNull();
    expect(parseShellRestartCommand('/status')).toBeNull();
  });

  test('formats blocked restart message with task ids', () => {
    expect(buildShellRestartBlockedMessage(['T-1'])).toBe(
      'Shell 重启已拒绝：当前有 1 个后台任务仍在运行：T-1。请等待任务完成，或使用 /shell-restart --force 强制重启。'
    );
    expect(buildShellRestartBlockedMessage(['T-1', 'T-2', 'T-3', 'T-4', 'T-5', 'T-6'])).toBe(
      'Shell 重启已拒绝：当前有 6 个后台任务仍在运行：T-1, T-2, T-3, T-4, T-5 ...。请等待任务完成，或使用 /shell-restart --force 强制重启。'
    );
  });
});
