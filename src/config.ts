import { readFileSync } from 'fs';
import { load } from 'js-yaml';
import { resolve } from 'path';
import { homedir } from 'os';

export interface Config {
  feishu: {
    app_id: string;
    app_secret: string;
  };
  director: {
    persona_dir: string;
    pipe_dir: string;
    pid_file: string;
    claude_path: string;
    time_sync_interval_ms: number;
    flush_context_limit: number;
    flush_interval_ms: number;
  };
  console: {
    enabled: boolean;
    port: number;
  };
  task: {
    default_timeout_ms: number;
  };
  scheduler: {
    enabled: boolean;
    intervalMinutes: number;
  };
  logging: {
    level: string;
    queue_log: string;
  };
}

function expandHome(p: string): string {
  return p.startsWith('~/') || p === '~' ? homedir() + p.slice(1) : p;
}

export function loadConfig(path?: string): Config {
  const configPath = path ?? resolve(import.meta.dirname, '..', 'config.yaml');
  const raw = readFileSync(configPath, 'utf-8');
  const yaml = load(raw) as Record<string, any>;

  if (!yaml.feishu?.app_id || !yaml.feishu?.app_secret) {
    throw new Error('feishu.app_id and feishu.app_secret are required in config.yaml');
  }

  const dir = yaml.director ?? {};
  const con = yaml.console ?? {};

  return {
    feishu: yaml.feishu,
    director: {
      persona_dir: expandHome(dir.persona_dir ?? '~/.persona'),
      pipe_dir: dir.pipe_dir ?? '/tmp/persona',
      pid_file: dir.pid_file ?? '/tmp/persona/director.pid',
      claude_path: dir.claude_path ?? 'claude',
      time_sync_interval_ms: dir.time_sync_interval_hours
        ? Number(dir.time_sync_interval_hours) * 3600_000
        : 2 * 3600_000,
      flush_context_limit: Number(dir.flush_context_limit ?? 700_000),
      flush_interval_ms: dir.flush_interval_days
        ? Number(dir.flush_interval_days) * 86_400_000
        : 7 * 86_400_000,
    },
    console: {
      enabled: con.enabled !== false,
      port: Number(con.port ?? 3000),
    },
    task: {
      default_timeout_ms: Number(yaml.task?.default_timeout_minutes ?? 10) * 60_000,
    },
    scheduler: {
      enabled: yaml.scheduler?.enabled !== false,
      intervalMinutes: Number(yaml.scheduler?.interval_minutes ?? 30),
    },
    logging: {
      level: yaml.logging?.level ?? 'info',
      queue_log: yaml.logging?.queue_log ?? 'logs/queue.log',
    },
  };
}
