import { EventEmitter } from 'events';
import { type ChildProcess } from 'child_process';
import { mkdirSync, existsSync, appendFileSync, copyFileSync, rmSync } from 'fs';
import { join } from 'path';
import { createInterface } from 'readline';
import { spawnPersona } from '../persona-process.js';
import { resolveAgentProvider, loadConfig, type Config } from '../config.js';
import { loadPrompt } from '../prompt-loader.js';
import { getLogDir } from '../logger.js';
import { localNow } from './task-store.js';

export interface TaskRunnerConfig {
  configPath?: string;
  agents: Config['agents'];
  personaDir: string;
  defaultTimeoutMs: number;
}

export interface RunTaskInput {
  taskId: string;
  role: string;
  agent?: string;
  model?: string;
  prompt: string;
  description?: string;
  projectDir?: string;
  timeoutMs?: number;
}

export interface TaskResult {
  taskId: string;
  success: boolean;
  resultFile?: string;
  error?: string;
  durationMs: number;
  costUsd?: number;
  spawnArgs?: string[];
}

interface RunningTask {
  pid: number;
  timer: NodeJS.Timeout;
  child: ChildProcess;
  rl?: ReturnType<typeof import('readline').createInterface>;
  startedAt: number;
  timedOut: boolean;
  outputPath: string;
  resultFile: string;
  costUsd?: number;
}

const GRACEFUL_KILL_DELAY = 5_000;
const WATCHDOG_INTERVAL_MS = 30_000;
const CODEX_RESULT_STAGING_DIR = '/tmp/persona-task-results';

function isPidRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export class TaskRunner extends EventEmitter {
  private config: TaskRunnerConfig;
  private running = new Map<string, RunningTask>();
  private watchdogTimer: NodeJS.Timeout;

  constructor(config: TaskRunnerConfig) {
    super();
    this.config = config;
    this.watchdogTimer = setInterval(() => this.checkProcessLiveness(), WATCHDOG_INTERVAL_MS);
    this.watchdogTimer.unref();
  }

  runTask(input: RunTaskInput): void {
    if (this.running.has(input.taskId)) {
      console.log(`[task-runner] Task ${input.taskId} already running, skipping`);
      return;
    }

    const timeoutMs = input.timeoutMs ?? this.config.defaultTimeoutMs;
    const startedAt = Date.now();
    const personaDir = this.config.personaDir;

    let agent: ReturnType<typeof resolveAgentProvider>;
    try {
      const agents = this.config.configPath
        ? loadConfig(this.config.configPath).agents
        : this.config.agents;
      agent = resolveAgentProvider(agents, input.role, input.agent);
      if (input.model) agent = { ...agent, model: input.model };
    } catch (err) {
      const result: TaskResult = {
        taskId: input.taskId,
        success: false,
        error: String(err),
        durationMs: 0,
      };
      console.error(`[task-runner] Task ${input.taskId} failed to resolve agent:`, err);
      this.emit('task-failed', result);
      return;
    }

    // 构建产出文件名：只用任务 ID，描述写在报告头部
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
    const outboxDir = join(personaDir, 'outbox', today);
    if (!existsSync(outboxDir)) mkdirSync(outboxDir, { recursive: true });
    const fileName = `${input.taskId}.md`;
    const resultFile = join(outboxDir, fileName);
    const outputPath = agent.type === 'codex'
      ? join(CODEX_RESULT_STAGING_DIR, `${input.taskId}.md`)
      : resultFile;

    if (agent.type === 'codex') {
      if (!existsSync(CODEX_RESULT_STAGING_DIR)) mkdirSync(CODEX_RESULT_STAGING_DIR, { recursive: true });
      rmSync(outputPath, { force: true });
    }

    const descHeader = input.description ? `报告头部请注明任务信息：「${input.taskId} — ${input.description}」。` : '';
    const hardcodedInstruction = `[系统指令] 将输出结果保存到 ${outputPath}。${descHeader}完成后只回复"done"，不要输出总结。`;
    const outputInstruction = loadPrompt(personaDir, 'task-output-instruction', {
      output_path: outputPath,
      task_id: input.taskId,
      description: input.description ?? '',
      desc_header: descHeader,
    }) ?? hardcodedInstruction;
    const fullPrompt = `${input.prompt}\n\n${outputInstruction}`;

    const { child, args } = spawnPersona({
      role: input.role,
      personaDir,
      agent,
      mode: 'background',
      mcpConfigPath: agent.type === 'codex' && agent.mcp_mode !== 'mcp'
        ? undefined
        : join(personaDir, '.mcp.json'),
      prompt: fullPrompt,
      projectDir: input.projectDir,
      stderrPath: join(getLogDir(), `task-${input.taskId}.stderr.log`),
    });

    // 防止未处理的 error 事件导致 Shell 进程崩溃
    child.on('error', () => {});

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

    console.log(`[task-runner] Task ${input.taskId} started (role=${input.role}, agent=${agent.name}, pid=${child.pid}, timeout=${timeoutMs}ms)`);
    this.emit('task-started', input.taskId, args, child.pid);

    // Timeout protection
    const timer = setTimeout(() => {
      this.killWithEscalation(input.taskId, child.pid!);
    }, timeoutMs);

    const entry: RunningTask = { pid: child.pid, timer, child, startedAt, timedOut: false, outputPath, resultFile };
    this.running.set(input.taskId, entry);

    // Parse stream-json stdout and log to file
    const stdoutLogPath = join(getLogDir(), `task-${input.taskId}.stdout.log`);

    const rl = createInterface({ input: child.stdout! });
    entry.rl = rl;
    rl.on('line', (line) => {
      if (!line.trim()) return;
      try { appendFileSync(stdoutLogPath, line + '\n'); } catch { /* best-effort */ }
      try {
        const event = JSON.parse(line);
        if (event.type === 'result') {
          const entry = this.running.get(input.taskId);
          if (entry) {
            if (event.cost_usd != null) entry.costUsd = event.cost_usd;
            if (event.total_cost_usd != null) entry.costUsd = event.total_cost_usd;
          }
        }
      } catch {
        // non-JSON line, ignore
      }
    });

    child.on('exit', (code) => {
      rl.close();
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
          costUsd: entry.costUsd,
        };
        console.log(`[task-runner] Task ${input.taskId} killed after timeout (duration=${durationMs}ms)`);
        this.emit('task-failed', result);
        return;
      }

      let error: string | undefined;
      let finalResultFile: string | undefined;

      if (code === 0) {
        const moved = this.materializeResultFile(entry.outputPath, entry.resultFile);
        if (moved.ok) {
          finalResultFile = entry.resultFile;
        } else {
          error = moved.error;
        }
      } else {
        error = `exit code ${code}`;
      }

      const success = !error;
      const result: TaskResult = {
        taskId: input.taskId,
        success,
        durationMs,
        costUsd: entry.costUsd,
        spawnArgs: args,
        ...(success ? { resultFile: finalResultFile } : { error }),
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
    entry.rl?.close();
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

  private checkProcessLiveness(): void {
    if (this.running.size === 0) return;

    for (const [taskId, entry] of this.running) {
      try {
        process.kill(entry.pid, 0);
      } catch {
        console.log(`[task-runner] Task ${taskId} pid ${entry.pid} is dead but close event was not received, cleaning up`);
        entry.rl?.close();
        clearTimeout(entry.timer);
        this.running.delete(taskId);

        const durationMs = Date.now() - entry.startedAt;
        let resultFile: string | undefined;
        const moved = this.materializeResultFile(entry.outputPath, entry.resultFile);
        if (moved.ok) resultFile = entry.resultFile;

        const success = !!resultFile;
        const result: TaskResult = {
          taskId,
          success,
          durationMs,
          costUsd: entry.costUsd,
          ...(success ? { resultFile } : { error: `process disappeared (pid ${entry.pid})` }),
        };
        this.emit(success ? 'task-completed' : 'task-failed', result);
      }
    }
  }

  private materializeResultFile(outputPath: string, resultFile: string): { ok: true } | { ok: false; error: string } {
    if (!existsSync(outputPath)) {
      return { ok: false, error: 'result file missing' };
    }

    if (outputPath === resultFile) {
      return { ok: true };
    }

    try {
      copyFileSync(outputPath, resultFile);
      rmSync(outputPath, { force: true });
      return { ok: true };
    } catch {
      return { ok: false, error: 'failed to move result file into outbox' };
    }
  }

  /** Startup cleanup: scan DB for tasks stuck in 'running'/'dispatched' and resolve them. */
  cleanupOrphanTasks(
    listTasksFn: (filter: { status: string }) => Array<{ id: string; created_at: string; started_at: string | null; extra: unknown; description: string }>,
    updateTaskFn: (id: string, data: Record<string, unknown>) => void,
  ): Array<{ id: string; status: string; description: string }> {
    const recovered: Array<{ id: string; status: string; description: string }> = [];

    // Phase 1: running tasks — check process liveness, harvest results or kill
    const running = listTasksFn({ status: 'running' });
    if (running.length > 0) {
      console.log(`[task-runner] Found ${running.length} orphan running task(s), cleaning up...`);
    }

    for (const task of running) {
      const extra = task.extra as Record<string, unknown> | null;
      const pid = extra?.pid as number | undefined;

      if (!pid) {
        updateTaskFn(task.id, { status: 'failed', completed_at: localNow(), error: 'orphaned (shell restarted, no PID)' });
        console.log(`[task-runner] Orphan ${task.id}: no PID, marked failed`);
        recovered.push({ id: task.id, status: 'failed', description: task.description });
        continue;
      }

      const alive = isPidRunning(pid);
      const resultFile = this.resolveOrphanResultFile(task);

      if (!alive) {
        if (resultFile) {
          updateTaskFn(task.id, { status: 'completed', completed_at: localNow(), result_file: resultFile, error: null });
          console.log(`[task-runner] Orphan ${task.id}: dead but result exists, marked completed`);
          recovered.push({ id: task.id, status: 'completed', description: task.description });
        } else {
          updateTaskFn(task.id, { status: 'failed', completed_at: localNow(), error: 'orphaned (process dead, no result)' });
          console.log(`[task-runner] Orphan ${task.id}: dead, no result, marked failed`);
          recovered.push({ id: task.id, status: 'failed', description: task.description });
        }
      } else {
        if (resultFile) {
          this.killProcessGroup(pid, 'SIGTERM');
          updateTaskFn(task.id, { status: 'completed', completed_at: localNow(), result_file: resultFile });
          console.log(`[task-runner] Orphan ${task.id}: alive with result, killed and marked completed`);
          recovered.push({ id: task.id, status: 'completed', description: task.description });
        } else {
          this.killProcessGroup(pid, 'SIGTERM');
          updateTaskFn(task.id, { status: 'failed', completed_at: localNow(), error: 'orphaned (killed on shell restart)' });
          console.log(`[task-runner] Orphan ${task.id}: alive without result, killed and marked failed`);
          recovered.push({ id: task.id, status: 'failed', description: task.description });
        }
      }
    }

    // Phase 2: dispatched but never started — mark stale ones as failed
    const dispatched = listTasksFn({ status: 'dispatched' });
    for (const task of dispatched) {
      const age = Date.now() - new Date(task.created_at).getTime();
      if (age > this.config.defaultTimeoutMs) {
        updateTaskFn(task.id, { status: 'failed', completed_at: localNow(), error: 'orphaned (never started, shell restarted)' });
        console.log(`[task-runner] Stale dispatched ${task.id}: age=${Math.round(age / 1000)}s, marked failed`);
        recovered.push({ id: task.id, status: 'failed', description: task.description });
      }
    }

    return recovered;
  }

  private resolveOrphanResultFile(task: { id: string; created_at: string }): string | null {
    const createdDate = new Date(task.created_at).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
    const outboxFile = join(this.config.personaDir, 'outbox', createdDate, `${task.id}.md`);
    if (existsSync(outboxFile)) return outboxFile;

    // Check Codex staging directory
    const stagingFile = join(CODEX_RESULT_STAGING_DIR, `${task.id}.md`);
    if (existsSync(stagingFile)) {
      const outboxDir = join(this.config.personaDir, 'outbox', createdDate);
      if (!existsSync(outboxDir)) mkdirSync(outboxDir, { recursive: true });
      try {
        copyFileSync(stagingFile, outboxFile);
        rmSync(stagingFile, { force: true });
        return outboxFile;
      } catch {
        return null;
      }
    }

    return null;
  }
}
