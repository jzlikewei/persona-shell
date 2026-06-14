import { spawn } from 'child_process';
import { createWriteStream, mkdirSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

export interface BashResult {
  exitCode: number;
  /** Path to the combined stdout+stderr log file. */
  logFile: string;
  /** Tail snippet of stdout (for backward compat / quick logging). */
  stdout: string;
  /** Tail snippet of stderr (for backward compat / quick logging). */
  stderr: string;
}

export interface BashActionOptions {
  timeoutMs?: number;
  /** Directory to write log files. Defaults to os.tmpdir()/persona-shell-action/. */
  logDir?: string;
  /** Keep the log file after completion (default true). Set false for transient actions. */
  keepLog?: boolean;
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const KILL_GRACE_MS = 5_000;
/** How many bytes to read from the tail of stdout/stderr for the result snippet. */
const TAIL_BYTES = 4096;

/**
 * Execute a bash command string via the user's shell.
 *
 * stdout and stderr are streamed directly to a log file on disk — no in-memory
 * buffering, no maxBuffer limit. The process can produce unlimited output
 * without being killed. Only a tail snippet is read back after the process exits
 * for quick log lines.
 *
 * Kills the whole process group on timeout so orphaned child processes do not
 * continue running after the scheduler has already decided the action failed.
 */
export async function runBashAction(command: string, options: BashActionOptions = {}): Promise<BashResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const logDir = options.logDir ?? join(tmpdir(), 'persona-shell-action');
  const keepLog = options.keepLog ?? true;

  mkdirSync(logDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const logFile = join(logDir, `shell-action-${ts}-${process.pid}.log`);
  const stdoutLog = join(logDir, `shell-action-${ts}-${process.pid}.stdout.log`);
  const stderrLog = join(logDir, `shell-action-${ts}-${process.pid}.stderr.log`);

  const outStream = createWriteStream(stdoutLog);
  const errStream = createWriteStream(stderrLog);
  // Combined log for easy tailing
  const combinedStream = createWriteStream(logFile);

  const shell = process.env.SHELL || '/bin/bash';

  return await new Promise<BashResult>((resolve, reject) => {
    const child = spawn(shell, ['-lc', command], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let settled = false;
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;

    const fail = (error: Error & { code?: number | string; stdout?: string; stderr?: string; killed?: boolean; signal?: NodeJS.Signals | null; logFile?: string }) => {
      error.stdout = readTail(stdoutLog);
      error.stderr = readTail(stderrLog);
      error.logFile = logFile;
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

    // Stream to files — no memory accumulation
    child.stdout?.on('data', (chunk: Buffer) => {
      outStream.write(chunk);
      combinedStream.write(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      errStream.write(chunk);
      combinedStream.write(chunk);
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      closeStreams();
      fail(error);
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      closeStreams();

      if (timedOut) {
        const error = new Error(`bash command timed out after ${timeoutMs}ms`) as Error & { code?: string; killed?: boolean; signal?: NodeJS.Signals | null };
        error.code = 'ETIMEDOUT';
        error.killed = true;
        error.signal = signal;
        fail(error);
        return;
      }

      const stdoutTail = readTail(stdoutLog);
      const stderrTail = readTail(stderrLog);

      if (code !== 0) {
        const error = new Error(`bash command failed with exit code ${code}`) as Error & { code?: number | string; signal?: NodeJS.Signals | null; logFile?: string };
        error.code = code ?? 'SIGNAL';
        error.signal = signal;
        error.logFile = logFile;
        (error as any).stdout = stdoutTail;
        (error as any).stderr = stderrTail;
        reject(error);
        return;
      }

      if (!keepLog) {
        try { unlinkSync(stdoutLog); } catch {}
        try { unlinkSync(stderrLog); } catch {}
        try { unlinkSync(logFile); } catch {}
      }

      resolve({ exitCode: 0, logFile, stdout: stdoutTail, stderr: stderrTail });
    });

    function closeStreams() {
      outStream.end();
      errStream.end();
      combinedStream.end();
    }
  });
}

/** Read the tail of a file for log snippets. Returns empty string on error. */
function readTail(filePath: string, bytes = TAIL_BYTES): string {
  try {
    const buf = readFileSync(filePath);
    if (buf.length <= bytes) return buf.toString('utf-8');
    return '...' + buf.subarray(buf.length - bytes).toString('utf-8');
  } catch {
    return '';
  }
}

/** Check whether an action_name represents a bash command (starts with `!`) */
export function isBashAction(actionName: string | null | undefined): boolean {
  return typeof actionName === 'string' && actionName.startsWith('!');
}

/** Extract the raw command from a `!`-prefixed action_name */
export function extractBashCommand(actionName: string): string {
  return actionName.slice(1);
}
