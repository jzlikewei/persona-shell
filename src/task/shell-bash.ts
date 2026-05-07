import { exec as execCb } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(execCb);

export interface BashResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Execute a bash command string via the user's shell.
 * Returns stdout/stderr on success; throws on non-zero exit or timeout.
 */
export async function runBashAction(command: string): Promise<BashResult> {
  const { stdout, stderr } = await execAsync(command, {
    shell: process.env.SHELL || '/bin/bash',
    timeout: 5 * 60_000,
    maxBuffer: 1024 * 1024,
  });
  return { exitCode: 0, stdout, stderr };
}

/** Check whether an action_name represents a bash command (starts with `!`) */
export function isBashAction(actionName: string | null | undefined): boolean {
  return typeof actionName === 'string' && actionName.startsWith('!');
}

/** Extract the raw command from a `!`-prefixed action_name */
export function extractBashCommand(actionName: string): string {
  return actionName.slice(1);
}
