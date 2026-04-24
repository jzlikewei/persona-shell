import type { CronJob } from './task-store.js';

export interface SchedulerConfig {
  intervalMinutes: number;
  enabled: boolean;
}

export interface SchedulerCallbacks {
  listEnabledJobs: () => CronJob[];
  // spawn_role: 创建子角色进程（原 executeJob）
  executeSpawnRole: (job: CronJob) => Promise<string | null>;
  isOverlapping: (jobId: string, role: string) => boolean;
  markJobRun: (jobId: string) => void;
  // director_msg: 给 Director 发系统消息
  executeDirectorMsg: (job: CronJob) => Promise<void>;
  // shell_action: 执行 Shell 内部动作
  executeShellAction: (job: CronJob) => Promise<void>;
  // 通知：cron job 被触发时通知用户（可选）
  notifyCronFired?: (job: CronJob) => void;
}

const TICK_INTERVAL_MS = 60_000; // 60 seconds
// If the gap between ticks exceeds this threshold, we assume the machine was asleep
const SLEEP_THRESHOLD_MS = TICK_INTERVAL_MS * 3; // 3 minutes

export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private config: SchedulerConfig;
  private callbacks: SchedulerCallbacks;
  private lastTickTime: number = 0;
  private ticking: boolean = false;
  /** Track consecutive spawn failures per job to apply backoff */
  private failCount = new Map<string, number>();
  private static readonly MAX_FAIL_BACKOFF_TICKS = 30; // max ~30 minutes between retries

  constructor(config: SchedulerConfig, callbacks: SchedulerCallbacks) {
    this.config = config;
    this.callbacks = callbacks;
  }

  start(): void {
    if (!this.config.enabled) {
      console.log('[scheduler] Disabled, skipping start');
      return;
    }
    if (this.timer) {
      console.log('[scheduler] Already running');
      return;
    }

    this.timer = setInterval(() => this.tick(), TICK_INTERVAL_MS);
    console.log('[scheduler] Started, tick interval=60s');

    setTimeout(() => this.tick(), 0);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log('[scheduler] Stopped');
    }
  }

  private async tick(): Promise<void> {
    // Mutex: prevent concurrent ticks (e.g. setInterval fires while previous tick is still running)
    if (this.ticking) return;
    this.ticking = true;

    try {
      const now = Date.now();

      // Log sleep/wake detection for observability, but don't skip any jobs.
      // shouldRun() already prevents pile-up: interval jobs check elapsed time
      // since last_run_at, daily jobs check if already ran today.
      if (this.lastTickTime > 0) {
        const gap = now - this.lastTickTime;
        if (gap > SLEEP_THRESHOLD_MS) {
          console.log(`[scheduler] Sleep detected (gap=${Math.round(gap / 1000)}s), resuming normal execution`);
        }
      }
      this.lastTickTime = now;

      const jobs = this.callbacks.listEnabledJobs();

      for (const job of jobs) {
        if (!shouldRun(job.schedule, job.last_run_at)) continue;

        const actionType = job.action_type ?? 'spawn_role';

        // Universal overlap check: skip if previous run of this job is still active.
        // Don't markJobRun here — let shouldRun() re-evaluate on the next tick.
        // This ensures daily jobs aren't silently swallowed when overlapping.
        if (this.callbacks.isOverlapping(job.id, job.role)) {
          console.log(`[scheduler] Skipping ${job.name}: previous run still active`);
          continue;
        }

        try {
          switch (actionType) {
            case 'spawn_role': {
              // Exponential backoff on consecutive spawn failures:
              // skip ticks based on 2^failCount (capped at MAX_FAIL_BACKOFF_TICKS).
              const fails = this.failCount.get(job.id) ?? 0;
              if (fails > 0) {
                const backoffTicks = Math.min(2 ** fails, Scheduler.MAX_FAIL_BACKOFF_TICKS);
                // Use lastTickTime modulo to decide whether to skip this tick
                const ticksSinceEpoch = Math.floor(Date.now() / TICK_INTERVAL_MS);
                if (ticksSinceEpoch % backoffTicks !== 0) {
                  continue; // skip this tick, retry later
                }
              }

              this.callbacks.notifyCronFired?.(job);
              const taskId = await this.callbacks.executeSpawnRole(job);
              if (taskId) {
                this.callbacks.markJobRun(job.id);
                this.failCount.delete(job.id);
                console.log(`[scheduler] Created task ${taskId} for ${job.name}`);
              } else {
                const newFails = fails + 1;
                this.failCount.set(job.id, newFails);
                const nextRetryMin = Math.min(2 ** newFails, Scheduler.MAX_FAIL_BACKOFF_TICKS);
                console.warn(`[scheduler] Spawn failed for ${job.name} (${newFails}x), next retry in ~${nextRetryMin}min`);
              }
              break;
            }

            case 'director_msg': {
              this.callbacks.notifyCronFired?.(job);
              await this.callbacks.executeDirectorMsg(job);
              this.callbacks.markJobRun(job.id);
              console.log(`[scheduler] Sent director message for ${job.name}`);
              break;
            }

            case 'shell_action': {
              this.callbacks.notifyCronFired?.(job);
              await this.callbacks.executeShellAction(job);
              this.callbacks.markJobRun(job.id);
              console.log(`[scheduler] Executed shell action for ${job.name}`);
              break;
            }

            default:
              console.warn(`[scheduler] Unknown action_type '${actionType}' for ${job.name}`);
          }
        } catch (err) {
          console.error(`[scheduler] Failed to execute ${job.name} (${actionType}):`, err);
        }
      }
    } finally {
      this.ticking = false;
    }
  }
}

/**
 * Determine whether a job should run now, based on its schedule string and last run time.
 *
 * Supported formats:
 *   "every Nm"    — run if >= N minutes since last run (or first run)
 *   "every Nh"    — run if >= N hours since last run (or first run)
 *   "daily HH:MM" — run once per day at or after HH:MM (Asia/Shanghai)
 */
export function shouldRun(schedule: string, lastRunAt: string | null): boolean {
  const now = new Date();

  // "every Nm" or "every Nh"
  const everyMatch = schedule.match(/^every\s+(\d+)([mh])$/i);
  if (everyMatch) {
    if (!lastRunAt) return true; // first run
    const n = parseInt(everyMatch[1], 10);
    const unit = everyMatch[2].toLowerCase();
    const intervalMs = unit === 'h' ? n * 3600_000 : n * 60_000;
    const elapsed = now.getTime() - new Date(lastRunAt).getTime();
    return elapsed >= intervalMs;
  }

  // "daily HH:MM"
  const dailyMatch = schedule.match(/^daily\s+(\d{2}):(\d{2})$/);
  if (dailyMatch) {
    const targetHour = parseInt(dailyMatch[1], 10);
    const targetMinute = parseInt(dailyMatch[2], 10);

    // Get current time in Asia/Shanghai (用 Intl.DateTimeFormat 安全提取，避免 re-parse toLocaleString)
    const hourFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', hour: 'numeric', hour12: false });
    const minuteFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', minute: 'numeric' });
    const currentHour = parseInt(hourFmt.format(now), 10);
    const currentMinute = parseInt(minuteFmt.format(now), 10);

    // Haven't reached target time yet today
    if (currentHour < targetHour || (currentHour === targetHour && currentMinute < targetMinute)) {
      return false;
    }

    // Already past target time — check if we already ran today
    if (!lastRunAt) return true;

    // Build today's target timestamp in Asia/Shanghai
    const todayStr = now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
    // +08:00 is safe here — China does not observe DST, so Asia/Shanghai is always UTC+8.
    const todayTarget = new Date(`${todayStr}T${dailyMatch[1]}:${dailyMatch[2]}:00+08:00`);
    return new Date(lastRunAt).getTime() < todayTarget.getTime();
  }

  console.warn(`[scheduler] Unknown schedule format: ${schedule}`);
  return false;
}

/** Check if a schedule string is a daily schedule (e.g. "daily 03:00") */
export function isDailySchedule(schedule: string): boolean {
  return /^daily\s+\d{2}:\d{2}$/.test(schedule);
}
