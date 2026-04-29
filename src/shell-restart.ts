export interface ShellRestartCommand {
  force: boolean;
}

export function parseShellRestartCommand(text: string): ShellRestartCommand | null {
  const trimmed = text.trim();
  if (trimmed === '/shell-restart' || trimmed === '/restart-shell') {
    return { force: false };
  }
  if (trimmed === '/shell-restart --force' || trimmed === '/restart-shell --force') {
    return { force: true };
  }
  return null;
}

export function buildShellRestartBlockedMessage(taskIds: string[]): string {
  const preview = taskIds.slice(0, 5);
  const listed = preview.join(', ');
  const overflow = taskIds.length > preview.length ? ' ...' : '';
  return `Shell 重启已拒绝：当前有 ${taskIds.length} 个后台任务仍在运行：${listed}${overflow}。请等待任务完成，或使用 /shell-restart --force 强制重启。`;
}
