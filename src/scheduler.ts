export interface SchedulerConfig {
  intervalMinutes: number;
  enabled: boolean;
}

export interface ScheduledJob {
  name: string;
  role: string;
  description: string;
  prompt: string;
}

export type CreateTaskFn = (job: ScheduledJob) => Promise<string | null>;
export type IsTaskRunningFn = (role: string, type: 'cron') => boolean;

export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private config: SchedulerConfig;
  private jobs: ScheduledJob[];
  private createTask: CreateTaskFn;
  private isTaskRunning: IsTaskRunningFn;

  constructor(
    config: SchedulerConfig,
    jobs: ScheduledJob[],
    createTask: CreateTaskFn,
    isTaskRunning: IsTaskRunningFn,
  ) {
    this.config = config;
    this.jobs = jobs;
    this.createTask = createTask;
    this.isTaskRunning = isTaskRunning;
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

    const intervalMs = this.config.intervalMinutes * 60 * 1000;
    this.timer = setInterval(() => this.tick(), intervalMs);
    console.log(
      `[scheduler] Started with ${this.jobs.length} job(s), interval=${this.config.intervalMinutes}m`,
    );

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
    for (const job of this.jobs) {
      if (this.isTaskRunning(job.role, 'cron')) {
        console.log(`[scheduler] Skipping ${job.name}: previous run still active`);
        continue;
      }

      try {
        const taskId = await this.createTask(job);
        if (taskId) {
          console.log(`[scheduler] Created task ${taskId} for ${job.name}`);
        }
      } catch (err) {
        console.error(`[scheduler] Failed to create task for ${job.name}:`, err);
      }
    }
  }
}
