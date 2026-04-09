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
  return db;
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
