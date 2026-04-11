/** SQLite data layer for the task system */
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { randomBytes } from 'crypto';
import { mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export interface CreateTaskInput {
  type: 'role' | 'cron';
  role: string;
  description: string;
  prompt: string;
  max_retry?: number;
  extra?: Record<string, unknown>;
}

export interface Task {
  id: string;
  type: string;
  role: string;
  description: string;
  prompt: string;
  status: 'dispatched' | 'running' | 'completed' | 'failed';
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  result_file: string | null;
  error: string | null;
  retry_count: number;
  max_retry: number;
  cost_usd: number | null;
  duration_ms: number | null;
  extra: Record<string, unknown> | null;
}

const DB_DIR = join(homedir(), '.persona', 'state');
const DB_PATH = join(DB_DIR, 'tasks.db');

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS tasks (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  role         TEXT NOT NULL,
  description  TEXT NOT NULL,
  prompt       TEXT NOT NULL,
  status       TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  started_at   TEXT,
  completed_at TEXT,
  result_file  TEXT,
  error        TEXT,
  retry_count  INTEGER DEFAULT 0,
  max_retry    INTEGER DEFAULT 3,
  cost_usd     REAL,
  duration_ms  INTEGER,
  extra        TEXT
)`;

const CREATE_STATE_TABLE = `
CREATE TABLE IF NOT EXISTS state (
  key   TEXT PRIMARY KEY,
  value TEXT
)`;

const CREATE_CRON_JOBS_TABLE = `
CREATE TABLE IF NOT EXISTS cron_jobs (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL,
  description TEXT NOT NULL,
  prompt      TEXT NOT NULL,
  schedule    TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  action_type TEXT NOT NULL DEFAULT 'spawn_role',
  message     TEXT,
  action_name TEXT
)`;

function generateId(): string {
  return randomBytes(8).toString('hex');
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function openDb(): Database {
  ensureDir(DB_DIR);
  const db = new Database(DB_PATH);
  db.run('PRAGMA journal_mode = WAL');
  db.run(CREATE_TABLE);
  db.run(CREATE_STATE_TABLE);
  db.run(CREATE_CRON_JOBS_TABLE);
  // Schema 迁移：为已有 cron_jobs 表添加新列（action_type, message, action_name）
  migrateCronJobsTable(db);
  return db;
}

/** 安全地为 cron_jobs 表添加新列，已存在则跳过 */
function migrateCronJobsTable(db: Database): void {
  const columns = db.query("PRAGMA table_info(cron_jobs)").all() as Array<{ name: string }>;
  const existing = new Set(columns.map((c) => c.name));

  if (!existing.has('action_type')) {
    db.run("ALTER TABLE cron_jobs ADD COLUMN action_type TEXT NOT NULL DEFAULT 'spawn_role'");
  }
  if (!existing.has('message')) {
    db.run("ALTER TABLE cron_jobs ADD COLUMN message TEXT");
  }
  if (!existing.has('action_name')) {
    db.run("ALTER TABLE cron_jobs ADD COLUMN action_name TEXT");
  }
}

function rowToTask(row: Record<string, unknown>): Task {
  return {
    ...row,
    extra: row.extra ? JSON.parse(row.extra as string) : null,
  } as Task;
}

const db = openDb();

export function createTask(input: CreateTaskInput): Task {
  const id = generateId();
  const now = new Date().toISOString();
  const extra = input.extra ? JSON.stringify(input.extra) : null;

  db.run(
    `INSERT INTO tasks (id, type, role, description, prompt, status, created_at, retry_count, max_retry, extra)
     VALUES (?, ?, ?, ?, ?, 'dispatched', ?, 0, ?, ?)`,
    [id, input.type, input.role, input.description, input.prompt, now, input.max_retry ?? 3, extra],
  );

  return getTask(id)!;
}

export function getTask(id: string): Task | null {
  const row = db.query('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | null;
  return row ? rowToTask(row) : null;
}

export function listTasks(filter?: { status?: string; role?: string; limit?: number }): Task[] {
  const conditions: string[] = [];
  const params: SQLQueryBindings[] = [];

  if (filter?.status) {
    conditions.push('status = ?');
    params.push(filter.status);
  }
  if (filter?.role) {
    conditions.push('role = ?');
    params.push(filter.role);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = filter?.limit ?? 50;
  params.push(limit);
  const rows = db.query(`SELECT * FROM tasks ${where} ORDER BY created_at DESC LIMIT ?`).all(...params) as Record<string, unknown>[];
  return rows.map(rowToTask);
}

export function updateTask(id: string, update: Partial<Omit<Task, 'id'>>): void {
  const allowed = [
    'type', 'role', 'description', 'prompt', 'status',
    'started_at', 'completed_at', 'result_file', 'error',
    'retry_count', 'max_retry', 'cost_usd', 'duration_ms', 'extra',
  ] as const;

  const sets: string[] = [];
  const params: SQLQueryBindings[] = [];

  for (const key of allowed) {
    if (key in update) {
      sets.push(`${key} = ?`);
      const val = (update as Record<string, unknown>)[key];
      params.push((key === 'extra' && val != null ? JSON.stringify(val) : val) as SQLQueryBindings);
    }
  }

  if (sets.length === 0) return;

  params.push(id as SQLQueryBindings);
  db.run(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`, params);
}

export function cancelTask(id: string): boolean {
  const result = db.run(
    `UPDATE tasks SET status = 'failed', error = 'cancelled' WHERE id = ? AND status IN ('dispatched', 'running')`,
    [id],
  );
  return result.changes > 0;
}

/** Returns today's outbox directory (e.g. outbox/2026-04-08/), auto-creates it */
export function getOutboxDir(personaDir: string): string {
  const date = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  const dir = join(personaDir, 'outbox', date);
  ensureDir(dir);
  return dir;
}

// --- State key-value store (replaces state-store.ts + file-based state) ---

export function getState<T>(key: string): T | null {
  const row = db.query('SELECT value FROM state WHERE key = ?').get(key) as { value: string } | null;
  if (!row) return null;
  try { return JSON.parse(row.value) as T; } catch { return null; }
}

export function setState<T>(key: string, data: T): void {
  db.run(
    'INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?',
    [key, JSON.stringify(data), JSON.stringify(data)],
  );
}

export function deleteState(key: string): void {
  db.run('DELETE FROM state WHERE key = ?', [key]);
}

// --- Cron Jobs CRUD ---

export type CronActionType = 'spawn_role' | 'director_msg' | 'shell_action';

export interface CronJob {
  id: string;
  name: string;
  role: string;
  description: string;
  prompt: string;
  schedule: string;
  enabled: boolean;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
  action_type: CronActionType;
  message: string | null;
  action_name: string | null;
}

export interface CreateCronJobInput {
  name: string;
  role: string;
  description: string;
  prompt: string;
  schedule: string;
  enabled?: boolean;
  action_type?: CronActionType;
  message?: string;
  action_name?: string;
}

function rowToCronJob(row: Record<string, unknown>): CronJob {
  return {
    ...row,
    enabled: row.enabled === 1,
    action_type: (row.action_type as CronActionType) ?? 'spawn_role',
    message: (row.message as string) ?? null,
    action_name: (row.action_name as string) ?? null,
  } as CronJob;
}

export function createCronJob(input: CreateCronJobInput): CronJob {
  const id = generateId();
  const now = new Date().toISOString();
  const enabled = input.enabled !== false ? 1 : 0;
  const actionType = input.action_type ?? 'spawn_role';
  const message = input.message ?? null;
  const actionName = input.action_name ?? null;

  db.run(
    `INSERT INTO cron_jobs (id, name, role, description, prompt, schedule, enabled, created_at, updated_at, action_type, message, action_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.name, input.role, input.description, input.prompt, input.schedule, enabled, now, now, actionType, message, actionName],
  );

  return getCronJob(id)!;
}

export function getCronJob(id: string): CronJob | null {
  const row = db.query('SELECT * FROM cron_jobs WHERE id = ?').get(id) as Record<string, unknown> | null;
  return row ? rowToCronJob(row) : null;
}

export function listCronJobs(filter?: { enabled?: boolean }): CronJob[] {
  if (filter?.enabled !== undefined) {
    const rows = db.query('SELECT * FROM cron_jobs WHERE enabled = ? ORDER BY created_at DESC').all(filter.enabled ? 1 : 0) as Record<string, unknown>[];
    return rows.map(rowToCronJob);
  }
  const rows = db.query('SELECT * FROM cron_jobs ORDER BY created_at DESC').all() as Record<string, unknown>[];
  return rows.map(rowToCronJob);
}

export function updateCronJob(id: string, update: Partial<Omit<CronJob, 'id' | 'created_at'>>): CronJob | null {
  const allowed = ['name', 'role', 'description', 'prompt', 'schedule', 'enabled', 'last_run_at', 'action_type', 'message', 'action_name'] as const;
  const sets: string[] = [];
  const params: SQLQueryBindings[] = [];

  for (const key of allowed) {
    if (key in update) {
      sets.push(`${key} = ?`);
      const val = (update as Record<string, unknown>)[key];
      params.push((key === 'enabled' ? (val ? 1 : 0) : val) as SQLQueryBindings);
    }
  }

  if (sets.length === 0) return getCronJob(id);

  sets.push('updated_at = ?');
  params.push(new Date().toISOString());
  params.push(id);
  db.run(`UPDATE cron_jobs SET ${sets.join(', ')} WHERE id = ?`, params);
  return getCronJob(id);
}

export function deleteCronJob(id: string): boolean {
  const result = db.run('DELETE FROM cron_jobs WHERE id = ?', [id]);
  return result.changes > 0;
}

export function toggleCronJob(id: string): CronJob | null {
  db.run('UPDATE cron_jobs SET enabled = 1 - enabled, updated_at = ? WHERE id = ?', [new Date().toISOString(), id]);
  return getCronJob(id);
}
