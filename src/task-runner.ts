import { EventEmitter } from 'events';
import { spawn, type ChildProcess } from 'child_process';
import { openSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { createInterface } from 'readline';

export interface TaskRunnerConfig {
  claudePath: string;
  personaDir: string;
  defaultTimeoutMs: number;
}

export interface RunTaskInput {
  taskId: string;
  role: string;
  prompt: string;
  timeoutMs?: number;
}

export interface TaskResult {
  taskId: string;
  success: boolean;
  resultFile?: string;
  error?: string;
  durationMs: number;
  costUsd?: number;
}

interface RunningTask {
  pid: number;
  timer: NodeJS.Timeout;
  child: ChildProcess;
  startedAt: number;
  timedOut: boolean;
}

const LOG_DIR = join(import.meta.dirname, '..', 'logs');
const GRACEFUL_KILL_DELAY = 5_000;

export class TaskRunner extends EventEmitter {
  private config: TaskRunnerConfig;
  private running = new Map<string, RunningTask>();

  constructor(config: TaskRunnerConfig) {
    super();
    this.config = config;
  }

  runTask(input: RunTaskInput): void {
    if (this.running.has(input.taskId)) {
      console.log(`[task-runner] Task ${input.taskId} already running, skipping`);
      return;
    }

    const timeoutMs = input.timeoutMs ?? this.config.defaultTimeoutMs;
    const startedAt = Date.now();

    const cmd = [
      this.config.claudePath,
      '--print',
      '--output-format stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
      '--bare',
      `--add-dir "${this.config.personaDir}"`,
      `-p "${input.prompt.replace(/"/g, '\\"')}"`,
    ].join(' ');

    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
    const stderrPath = join(LOG_DIR, `task-${input.taskId}.stderr.log`);
    const stderrFd = openSync(stderrPath, 'a');

    const child = spawn('sh', ['-c', cmd], {
      detached: true,
      stdio: ['ignore', 'pipe', stderrFd],
      cwd: this.config.personaDir,
    });

    child.unref();

    if (!child.pid) {
      const result: TaskResult = {
        taskId: input.taskId,
        success: false,
        error: 'failed to spawn process',
        durationMs: 0,
      };
      this.emit('task-failed', result);
      return;
    }

    console.log(`[task-runner] Task ${input.taskId} started (role=${input.role}, pid=${child.pid}, timeout=${timeoutMs}ms)`);
    this.emit('task-started', input.taskId);

    // Timeout protection
    const timer = setTimeout(() => {
      this.killWithEscalation(input.taskId, child.pid!);
    }, timeoutMs);

    this.running.set(input.taskId, { pid: child.pid, timer, child, startedAt, timedOut: false });

    // Parse stream-json stdout
    let costUsd: number | undefined;

    const rl = createInterface({ input: child.stdout! });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line);
        if (event.type === 'result' && event.cost_usd != null) {
          costUsd = event.cost_usd;
        }
      } catch {
        // non-JSON line, ignore
      }
    });

    child.on('close', (code) => {
      const entry = this.running.get(input.taskId);
      if (!entry) return; // already cleaned up (e.g. by cancel)

      clearTimeout(entry.timer);
      this.running.delete(input.taskId);

      const durationMs = Date.now() - startedAt;

      if (entry.timedOut) {
        const result: TaskResult = {
          taskId: input.taskId,
          success: false,
          error: 'timeout',
          durationMs,
          costUsd,
        };
        console.log(`[task-runner] Task ${input.taskId} killed after timeout (duration=${durationMs}ms)`);
        this.emit('task-failed', result);
        return;
      }

      const success = code === 0;
      const result: TaskResult = {
        taskId: input.taskId,
        success,
        durationMs,
        costUsd,
        ...(success ? {} : { error: `exit code ${code}` }),
      };

      console.log(`[task-runner] Task ${input.taskId} ${success ? 'completed' : 'failed'} (duration=${durationMs}ms, code=${code})`);
      this.emit(success ? 'task-completed' : 'task-failed', result);
    });
  }

  isRunning(taskId: string): boolean {
    return this.running.has(taskId);
  }

  cancelTask(taskId: string): boolean {
    const entry = this.running.get(taskId);
    if (!entry) return false;

    console.log(`[task-runner] Cancelling task ${taskId} (pid=${entry.pid})`);
    clearTimeout(entry.timer);
    this.running.delete(taskId);

    this.killProcessGroup(entry.pid, 'SIGTERM');

    const result: TaskResult = {
      taskId,
      success: false,
      error: 'cancelled',
      durationMs: Date.now() - entry.startedAt,
    };
    this.emit('task-failed', result);
    return true;
  }

  getRunningTasks(): string[] {
    return [...this.running.keys()];
  }

  /** Kill with SIGTERM → wait → SIGKILL escalation */
  private killWithEscalation(taskId: string, pid: number): void {
    const entry = this.running.get(taskId);
    if (!entry) return;

    entry.timedOut = true;
    console.log(`[task-runner] Task ${taskId} timed out, sending SIGTERM (pid=${pid})`);
    this.killProcessGroup(pid, 'SIGTERM');

    // If still alive after grace period, escalate to SIGKILL
    const killTimer = setTimeout(() => {
      if (this.running.has(taskId)) {
        console.log(`[task-runner] Task ${taskId} still alive after grace period, sending SIGKILL`);
        this.killProcessGroup(pid, 'SIGKILL');
      }
    }, GRACEFUL_KILL_DELAY);
    killTimer.unref();

    // Replace the original timeout timer with the kill escalation timer
    clearTimeout(entry.timer);
    entry.timer = killTimer;
  }

  private killProcessGroup(pid: number, signal: NodeJS.Signals): void {
    try {
      process.kill(-pid, signal);
    } catch {
      // process already dead
    }
  }
}
