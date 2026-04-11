import type { CronJob } from './task-store.js';

export interface SchedulerConfig {
  intervalMinutes: number;
  enabled: boolean;
}

export interface SchedulerCallbacks {
  listEnabledJobs: () => CronJob[];
  executeJob: (job: CronJob) => Promise<string | null>;
  isOverlapping: (role: string) => boolean;
  markJobRun: (jobId: string) => void;
}

const TICK_INTERVAL_MS = 60_000; // 60 seconds

export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private config: SchedulerConfig;
  private callbacks: SchedulerCallbacks;

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
    const jobs = this.callbacks.listEnabledJobs();

    for (const job of jobs) {
      if (!shouldRun(job.schedule, job.last_run_at)) continue;

      if (this.callbacks.isOverlapping(job.role)) {
        console.log(`[scheduler] Skipping ${job.name}: previous run still active`);
        continue;
      }

      try {
        const taskId = await this.callbacks.executeJob(job);
        if (taskId) {
          this.callbacks.markJobRun(job.id);
          console.log(`[scheduler] Created task ${taskId} for ${job.name}`);
        }
      } catch (err) {
        console.error(`[scheduler] Failed to create task for ${job.name}:`, err);
      }
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

    // Get current time in Asia/Shanghai
    const shanghaiNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
    const currentHour = shanghaiNow.getHours();
    const currentMinute = shanghaiNow.getMinutes();

    // Haven't reached target time yet today
    if (currentHour < targetHour || (currentHour === targetHour && currentMinute < targetMinute)) {
      return false;
    }

    // Already past target time — check if we already ran today
    if (!lastRunAt) return true;

    // Build today's target timestamp in Asia/Shanghai
    const todayStr = now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
    const todayTarget = new Date(`${todayStr}T${dailyMatch[1]}:${dailyMatch[2]}:00+08:00`);
    return new Date(lastRunAt).getTime() < todayTarget.getTime();
  }

  console.warn(`[scheduler] Unknown schedule format: ${schedule}`);
  return false;
}
