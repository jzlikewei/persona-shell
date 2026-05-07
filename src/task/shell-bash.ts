import { spawn } from 'child_process';

export interface BashResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface BashActionOptions {
  timeoutMs?: number;
  maxBuffer?: number;
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_MAX_BUFFER = 1024 * 1024;
const KILL_GRACE_MS = 5_000;

/**
 * Execute a bash command string via the user's shell.
 * Kills the whole process group on timeout so orphaned child processes do not
 * continue running after the scheduler has already decided the action failed.
 */
export async function runBashAction(command: string, options: BashActionOptions = {}): Promise<BashResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const shell = process.env.SHELL || '/bin/bash';

  return await new Promise<BashResult>((resolve, reject) => {
    const child = spawn(shell, ['-lc', command], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;

    const fail = (error: Error & { code?: number | string; stdout?: string; stderr?: string; killed?: boolean; signal?: NodeJS.Signals | null }) => {
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    };

    const killProcessGroup = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // Process already exited.
        }
      }
    };

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killProcessGroup('SIGTERM');
      killTimer = setTimeout(() => killProcessGroup('SIGKILL'), KILL_GRACE_MS);
    }, timeoutMs);

    const append = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
      if (stream === 'stdout') stdout += chunk.toString();
      else stderr += chunk.toString();

      if (stdout.length + stderr.length > maxBuffer && !settled) {
        settled = true;
        clearTimeout(timeoutTimer);
        if (killTimer) clearTimeout(killTimer);
        killProcessGroup('SIGTERM');
        const error = new Error(`bash command exceeded output buffer (${maxBuffer} bytes)`) as Error & { code?: string };
        error.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
        fail(error);
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => append('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer) => append('stderr', chunk));

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      fail(error);
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);

      if (timedOut) {
        const error = new Error(`bash command timed out after ${timeoutMs}ms`) as Error & { code?: string; killed?: boolean; signal?: NodeJS.Signals | null };
        error.code = 'ETIMEDOUT';
        error.killed = true;
        error.signal = signal;
        fail(error);
        return;
      }

      if (code !== 0) {
        const error = new Error(`bash command failed with exit code ${code}`) as Error & { code?: number | string; signal?: NodeJS.Signals | null };
        error.code = code ?? 'SIGNAL';
        error.signal = signal;
        fail(error);
        return;
      }

      resolve({ exitCode: 0, stdout, stderr });
    });
  });
}

/** Check whether an action_name represents a bash command (starts with `!`) */
export function isBashAction(actionName: string | null | undefined): boolean {
  return typeof actionName === 'string' && actionName.startsWith('!');
}

/** Extract the raw command from a `!`-prefixed action_name */
export function extractBashCommand(actionName: string): string {
  return actionName.slice(1);
}
