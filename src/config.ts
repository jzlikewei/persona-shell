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
  logging: {
    level: string;
    queue_log: string;
  };
}

function expandHome(p: string): string {
  return p.startsWith('~') ? p.replace('~', homedir()) : p;
}

export function loadConfig(path?: string): Config {
  const configPath = path ?? resolve(import.meta.dirname, '..', 'config.yaml');
  const raw = readFileSync(configPath, 'utf-8');
  const config = load(raw) as Config;

  if (!config.feishu?.app_id || !config.feishu?.app_secret) {
    throw new Error('feishu.app_id and feishu.app_secret are required in config.yaml');
  }

  return {
    feishu: config.feishu,
    director: {
      persona_dir: expandHome(config.director?.persona_dir ?? '~/.persona'),
      pipe_dir: config.director?.pipe_dir ?? '/tmp/persona',
      pid_file: config.director?.pid_file ?? '/tmp/persona/director.pid',
      claude_path: config.director?.claude_path ?? 'claude',
      time_sync_interval_ms: (config.director as Record<string, unknown>)?.time_sync_interval_hours
        ? Number((config.director as Record<string, unknown>).time_sync_interval_hours) * 3600_000
        : 2 * 3600_000,
      flush_context_limit: Number((config.director as Record<string, unknown>)?.flush_context_limit ?? 700_000),
      flush_interval_ms: (config.director as Record<string, unknown>)?.flush_interval_days
        ? Number((config.director as Record<string, unknown>).flush_interval_days) * 86_400_000
        : 7 * 86_400_000,
    },
    logging: {
      level: config.logging?.level ?? 'info',
      queue_log: config.logging?.queue_log ?? 'logs/queue.log',
    },
  };
}
