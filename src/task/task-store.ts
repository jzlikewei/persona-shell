/** SQLite data layer for the task system */
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { mkdirSync, existsSync } from 'fs';
import { join } from 'path';

/** Return current time as ISO string in local timezone (e.g. "2026-04-14T15:00:00.000+08:00").
 *  Uses the system/process timezone (process.env.TZ).
 *  In Docker containers where TZ is unset, this defaults to UTC. */
export function localNow(): string {
  const now = new Date();
  const offsetMin = now.getTimezoneOffset(); // minutes, negative for east of UTC
  const sign = offsetMin <= 0 ? '+' : '-';
  const absMin = Math.abs(offsetMin);
  const hh = String(Math.floor(absMin / 60)).padStart(2, '0');
  const mm = String(absMin % 60).padStart(2, '0');
  const local = new Date(now.getTime() - offsetMin * 60_000);
  return local.toISOString().replace('Z', `${sign}${hh}:${mm}`);
}

// ---------------------------------------------------------------------------
// TaskExtra — typed shape for the JSON `extra` column
// ---------------------------------------------------------------------------

export interface CodexCallback {
  type: 'codex_thread';
  thread_id: string;
  cwd?: string;
}

export interface TaskExtra {
  // --- spawn / process ---
  spawnArgs?: string[];
  pid?: number;

  // --- model / project ---
  model?: string;
  project_dir?: string;

  // --- codex integration ---
  codex_thread_id?: string;
  codex_callback?: CodexCallback;

  // --- parent session metadata (set by buildTaskParentMetadata) ---
  parent_workspace?: string | null;
  parent_session_id?: string | null;
  parent_runtime_label?: string | null;
  parent_session_status?: string | null;
  parent_session_name?: string | null;
  parent_agent?: string;
  parent_agent_type?: string;
  parent_persona_role?: string;
  parent_pid?: number | null;
  parent_codex_thread_id?: string;

  // --- persona / delegate ---
  persona_role?: string;
  persona_session_id?: string;

  // --- channel routing ---
  channel?: string;
  external_id?: string;

  // --- cron ---
  cronJobId?: string;
  manualRun?: boolean;

  // --- retry ---
  retried_from?: string;

  // --- extensible: legacy or ad-hoc fields ---
  [key: string]: unknown;
}

export interface CreateTaskInput {
  type: 'role' | 'cron';
  role: string;
  agent?: string;
  model?: string;
  description: string;
  prompt: string;
  max_retry?: number;
  project_dir?: string;
  extra?: TaskExtra;
  /** 任务超时时间（毫秒）；为空时使用 config 默认值 */
  timeout_ms?: number;
  /** 发起方 sessionId，用于任务回调路由 */
  source_session_id?: string;
  /** 发起方 workspace，用于 source session 归档后的 default session 回退 */
  workspace?: string;
  /** 旧发起方 Director 标识；仅作为历史迁移输入，不再作为运行时回调路由 */
  source_director?: string;
}

export interface Task {
  id: string;
  type: string;
  role: string;
  agent: string | null;
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
  extra: TaskExtra | null;
  /** 任务超时时间（毫秒）；null 表示使用 config 默认值 */
  timeout_ms: number | null;
  /** 发起方 sessionId，用于任务回调路由 */
  source_session_id: string | null;
  /** 发起方 workspace，用于 source session 归档后的 default session 回退 */
  workspace: string | null;
  /** 旧发起方 Director 标识；仅作为历史迁移输入/展示残留 */
  source_director: string | null;
}

export type TaskCleanupStatus = 'terminal' | 'completed' | 'failed' | 'cancelled';

export interface TaskCleanupOptions {
  olderThanDays: number;
  status: TaskCleanupStatus;
}

export interface TaskCleanupPreview {
  olderThanDays: number;
  cutoff: string;
  status: TaskCleanupStatus;
  eligibleCount: number;
  oldestCreatedAt: string | null;
  newestCreatedAt: string | null;
  samples: Task[];
}

let DB_DIR: string;
let DB_PATH: string;

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS tasks (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  role         TEXT NOT NULL,
  agent        TEXT,
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

const CREATE_SESSIONS_TABLE = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id       TEXT PRIMARY KEY,
  workspace        TEXT NOT NULL,
  session_name     TEXT,
  archived         INTEGER NOT NULL DEFAULT 0,
  role             TEXT,
  cwd              TEXT,
  agent_name       TEXT,
  agent_type       TEXT,
  model            TEXT,
  created_at       TEXT,
  first_message_at TEXT,
  last_message_at  TEXT,
  alive            INTEGER NOT NULL DEFAULT 0
)`;

const CREATE_SESSIONS_INDEX = `
CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace)`;

const CREATE_WORKSPACES_TABLE = `
CREATE TABLE IF NOT EXISTS workspaces (
  name               TEXT PRIMARY KEY,
  default_session_id  TEXT,
  cwd                TEXT,
  agent              TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
)`;

const CREATE_CRON_JOBS_TABLE = `
CREATE TABLE IF NOT EXISTS cron_jobs (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL,
  agent       TEXT,
  description TEXT NOT NULL,
  prompt      TEXT NOT NULL,
  schedule    TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  action_type TEXT NOT NULL DEFAULT 'spawn_role',
  message     TEXT,
  action_name TEXT,
  timeout_ms  INTEGER,
  max_retry   INTEGER NOT NULL DEFAULT 3
)`;

/** 生成语义化 Task ID: T-MMdd-HH-NNN */
function generateTaskId(db: Database): string {
  const now = new Date();
  const dateStr = now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(5).replace('-', '');
  const hour = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', hour: '2-digit', hour12: false }).format(now).padStart(2, '0');
  const prefix = `T-${dateStr}-${hour}`;

  const row = db.query("SELECT id FROM tasks WHERE id LIKE ? ORDER BY id DESC LIMIT 1").get(`${prefix}-%`) as { id: string } | null;
  let seq = 1;
  if (row) {
    const lastSeq = parseInt(row.id.split('-').pop() ?? '0', 10);
    seq = lastSeq + 1;
  }
  return `${prefix}-${String(seq).padStart(3, '0')}`;
}

/** 生成语义化 Cron Job ID: C-MMdd-HH-NNN */
function generateCronId(db: Database): string {
  const now = new Date();
  const dateStr = now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(5).replace('-', '');
  const hour = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', hour: '2-digit', hour12: false }).format(now).padStart(2, '0');
  const prefix = `C-${dateStr}-${hour}`;

  const row = db.query("SELECT id FROM cron_jobs WHERE id LIKE ? ORDER BY id DESC LIMIT 1").get(`${prefix}-%`) as { id: string } | null;
  let seq = 1;
  if (row) {
    const lastSeq = parseInt(row.id.split('-').pop() ?? '0', 10);
    seq = lastSeq + 1;
  }
  return `${prefix}-${String(seq).padStart(3, '0')}`;
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
  db.run(CREATE_WORKSPACES_TABLE);
  db.run(CREATE_SESSIONS_TABLE);
  db.run(CREATE_SESSIONS_INDEX);
  db.run(CREATE_CRON_JOBS_TABLE);
  // Schema 迁移
  migrateCronJobsTable(db);
  migrateTasksTable(db);
  migrateSessionsTable(db);
  return db;
}

/** 安全地为 cron_jobs 表添加新列，已存在则跳过 */
function migrateCronJobsTable(db: Database): void {
  const columns = db.query("PRAGMA table_info(cron_jobs)").all() as Array<{ name: string }>;
  const existing = new Set(columns.map((c) => c.name));

  if (!existing.has('action_type')) {
    db.run("ALTER TABLE cron_jobs ADD COLUMN action_type TEXT NOT NULL DEFAULT 'spawn_role'");
  }
  if (!existing.has('agent')) {
    db.run('ALTER TABLE cron_jobs ADD COLUMN agent TEXT');
  }
  if (!existing.has('message')) {
    db.run("ALTER TABLE cron_jobs ADD COLUMN message TEXT");
  }
  if (!existing.has('action_name')) {
    db.run("ALTER TABLE cron_jobs ADD COLUMN action_name TEXT");
  }
  if (!existing.has('source_director')) {
    db.run("ALTER TABLE cron_jobs ADD COLUMN source_director TEXT");
  }
  if (!existing.has('timeout_ms')) {
    db.run("ALTER TABLE cron_jobs ADD COLUMN timeout_ms INTEGER");
  }
  if (!existing.has('max_retry')) {
    db.run("ALTER TABLE cron_jobs ADD COLUMN max_retry INTEGER NOT NULL DEFAULT 3");
  }
  if (!existing.has('workspace')) {
    db.run('ALTER TABLE cron_jobs ADD COLUMN workspace TEXT');
  }
  db.run(`
    UPDATE cron_jobs
    SET workspace = COALESCE(NULLIF(workspace, ''), CASE WHEN source_director IS NULL OR source_director = '' THEN 'main' ELSE source_director END),
        source_director = NULL
    WHERE source_director IS NOT NULL
  `);
}

/** 安全地为 tasks 表添加新列 */
function migrateTasksTable(db: Database): void {
  const columns = db.query("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
  const existing = new Set(columns.map((c) => c.name));

  if (!existing.has('source_director')) {
    db.run("ALTER TABLE tasks ADD COLUMN source_director TEXT");
  }
  if (!existing.has('agent')) {
    db.run('ALTER TABLE tasks ADD COLUMN agent TEXT');
  }
  if (!existing.has('timeout_ms')) {
    db.run('ALTER TABLE tasks ADD COLUMN timeout_ms INTEGER');
  }
  if (!existing.has('source_session_id')) {
    db.run('ALTER TABLE tasks ADD COLUMN source_session_id TEXT');
  }
  if (!existing.has('workspace')) {
    db.run('ALTER TABLE tasks ADD COLUMN workspace TEXT');
  }
  db.run(`
    UPDATE tasks
    SET workspace = COALESCE(NULLIF(workspace, ''), CASE WHEN source_director IS NULL OR source_director = '' THEN 'main' ELSE source_director END),
        source_director = NULL
    WHERE source_director IS NOT NULL
  `);
}

/** 安全地为 sessions 表添加新列 */
function migrateSessionsTable(db: Database): void {
  const columns = db.query("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
  const existing = new Set(columns.map((c) => c.name));

  if (!existing.has('archived')) {
    db.run("ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0");
  }
  if (!existing.has('role')) {
    db.run("ALTER TABLE sessions ADD COLUMN role TEXT");
  }
  if (!existing.has('cwd')) {
    db.run("ALTER TABLE sessions ADD COLUMN cwd TEXT");
  }
  if (!existing.has('created_at')) {
    db.run("ALTER TABLE sessions ADD COLUMN created_at TEXT");
  }
  if (!existing.has('agent_name')) {
    db.run("ALTER TABLE sessions ADD COLUMN agent_name TEXT");
  }
  if (!existing.has('agent_type')) {
    db.run("ALTER TABLE sessions ADD COLUMN agent_type TEXT");
  }
  if (!existing.has('model')) {
    db.run("ALTER TABLE sessions ADD COLUMN model TEXT");
  }
}

function rowToTask(row: Record<string, unknown>): Task {
  return {
    ...row,
    extra: row.extra ? JSON.parse(row.extra as string) as TaskExtra : null,
  } as Task;
}

let db: Database;

/** Initialize the task store with the persona directory path.
 *  Must be called once before any other task-store function. */
export function initTaskStore(personaDir: string): void {
  DB_DIR = join(personaDir, 'state');
  DB_PATH = join(DB_DIR, 'tasks.db');
  db = openDb();
}

/** Get the DB instance, throwing if initTaskStore() was not called. */
function getDb(): Database {
  if (!db) throw new Error('task-store not initialized — call initTaskStore(personaDir) first');
  return db;
}

export function createTask(input: CreateTaskInput): Task {
  const d = getDb();
  const id = generateTaskId(d);
  const now = localNow();
  const extraObj: TaskExtra = { ...input.extra };
  if (input.project_dir) extraObj.project_dir = input.project_dir;
  if (input.model) extraObj.model = input.model;
  const extra = Object.keys(extraObj).length > 0 ? JSON.stringify(extraObj) : null;
  const sourceSessionId = input.source_session_id?.trim() || null;
  const workspace = input.workspace?.trim() || null;
  const agent = input.agent?.trim() || null;
  const timeoutMs = input.timeout_ms ?? null;

  d.run(
    `INSERT INTO tasks (id, type, role, agent, description, prompt, status, created_at, retry_count, max_retry, extra, source_director, timeout_ms, source_session_id, workspace)
     VALUES (?, ?, ?, ?, ?, ?, 'dispatched', ?, 0, ?, ?, ?, ?, ?, ?)`,
    [id, input.type, input.role, agent, input.description, input.prompt, now, input.max_retry ?? 3, extra, null, timeoutMs, sourceSessionId, workspace],
  );

  return getTask(id)!;
}

export function getTask(id: string): Task | null {
  const row = getDb().query('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | null;
  return row ? rowToTask(row) : null;
}

/** Batch-read timeout_ms for a list of task IDs. Returns a Map of id → timeout_ms (null if not set). */
export function getTaskTimeouts(ids: string[]): Map<string, number | null> {
  const result = new Map<string, number | null>();
  if (ids.length === 0) return result;
  const placeholders = ids.map(() => '?').join(',');
  const rows = getDb().query(`SELECT id, timeout_ms FROM tasks WHERE id IN (${placeholders})`).all(...ids) as Array<{ id: string; timeout_ms: number | null }>;
  for (const row of rows) {
    result.set(row.id, row.timeout_ms ?? null);
  }
  return result;
}

export function listTasks(filter?: { status?: string; role?: string; workspace?: string; limit?: number }): Task[] {
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
  if (filter?.workspace) {
    conditions.push('workspace = ?');
    params.push(filter.workspace);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = filter?.limit ?? 50;
  params.push(limit);
  const rows = getDb().query(`SELECT * FROM tasks ${where} ORDER BY created_at DESC LIMIT ?`).all(...params) as Record<string, unknown>[];
  return rows.map(rowToTask);
}

export function updateTask(id: string, update: Partial<Omit<Task, 'id'>>): void {
  const allowed = [
    'type', 'role', 'agent', 'description', 'prompt', 'status',
    'started_at', 'completed_at', 'result_file', 'error',
    'retry_count', 'max_retry', 'cost_usd', 'duration_ms', 'extra',
    'timeout_ms', 'source_session_id', 'workspace',
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
  getDb().run(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`, params);
}

export function cancelTask(id: string): boolean {
  const result = getDb().run(
    `UPDATE tasks SET status = 'failed', error = 'cancelled' WHERE id = ? AND status IN ('dispatched', 'running')`,
    [id],
  );
  return result.changes > 0;
}

function localIsoFor(date: Date): string {
  const offsetMin = date.getTimezoneOffset();
  const sign = offsetMin <= 0 ? '+' : '-';
  const absMin = Math.abs(offsetMin);
  const hh = String(Math.floor(absMin / 60)).padStart(2, '0');
  const mm = String(absMin % 60).padStart(2, '0');
  const local = new Date(date.getTime() - offsetMin * 60_000);
  return local.toISOString().replace('Z', `${sign}${hh}:${mm}`);
}

function normalizeCleanupOptions(input: Partial<TaskCleanupOptions>): TaskCleanupOptions {
  const rawDays = Number(input.olderThanDays ?? 30);
  const olderThanDays = Math.max(1, Math.min(3650, Math.floor(Number.isFinite(rawDays) ? rawDays : 30)));
  const status = input.status === 'completed' || input.status === 'failed' || input.status === 'cancelled' ? input.status : 'terminal';
  return { olderThanDays, status };
}

function taskCleanupWhere(options: TaskCleanupOptions): { where: string; params: SQLQueryBindings[]; cutoff: string } {
  const cutoff = localIsoFor(new Date(Date.now() - options.olderThanDays * 86_400_000));
  const conditions = ['created_at < ?'];
  const params: SQLQueryBindings[] = [cutoff];

  if (options.status === 'completed') {
    conditions.push("status = 'completed'");
  } else if (options.status === 'failed') {
    conditions.push("status = 'failed'");
    conditions.push("COALESCE(error, '') != 'cancelled'");
  } else if (options.status === 'cancelled') {
    conditions.push("status = 'failed'");
    conditions.push("error = 'cancelled'");
  } else {
    conditions.push("status IN ('completed', 'failed')");
  }

  return { where: conditions.join(' AND '), params, cutoff };
}

export function previewTaskCleanup(input: Partial<TaskCleanupOptions>): TaskCleanupPreview {
  const options = normalizeCleanupOptions(input);
  const { where, params, cutoff } = taskCleanupWhere(options);
  const countRow = getDb().query(`SELECT COUNT(*) AS count FROM tasks WHERE ${where}`).get(...params) as { count: number } | null;
  const rangeRow = getDb().query(`SELECT MIN(created_at) AS oldestCreatedAt, MAX(created_at) AS newestCreatedAt FROM tasks WHERE ${where}`).get(...params) as { oldestCreatedAt: string | null; newestCreatedAt: string | null } | null;
  const rows = getDb().query(`SELECT * FROM tasks WHERE ${where} ORDER BY created_at ASC LIMIT 8`).all(...params) as Record<string, unknown>[];
  return {
    ...options,
    cutoff,
    eligibleCount: Number(countRow?.count ?? 0),
    oldestCreatedAt: rangeRow?.oldestCreatedAt ?? null,
    newestCreatedAt: rangeRow?.newestCreatedAt ?? null,
    samples: rows.map(rowToTask),
  };
}

export function cleanupTaskHistory(input: Partial<TaskCleanupOptions>): TaskCleanupPreview & { deletedCount: number } {
  const preview = previewTaskCleanup(input);
  if (preview.eligibleCount === 0) return { ...preview, deletedCount: 0 };

  const { where, params } = taskCleanupWhere(preview);
  const idRows = getDb().query(`SELECT id FROM tasks WHERE ${where}`).all(...params) as Array<{ id: string }>;
  if (idRows.length === 0) return { ...preview, deletedCount: 0 };

  const ids = idRows.map((row) => row.id);
  const placeholders = ids.map(() => '?').join(',');
  const result = getDb().run(`DELETE FROM tasks WHERE id IN (${placeholders})`, ids);
  return { ...preview, deletedCount: result.changes };
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
  const row = getDb().query('SELECT value FROM state WHERE key = ?').get(key) as { value: string } | null;
  if (!row) return null;
  try { return JSON.parse(row.value) as T; } catch { return null; }
}

export function setState<T>(key: string, data: T): void {
  getDb().run(
    'INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?',
    [key, JSON.stringify(data), JSON.stringify(data)],
  );
}

export function deleteState(key: string): void {
  getDb().run('DELETE FROM state WHERE key = ?', [key]);
}

// --- Cron Jobs CRUD ---

export type CronActionType = 'spawn_role' | 'director_msg' | 'shell_action';

export interface CronJob {
  id: string;
  name: string;
  role: string;
  agent: string | null;
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
  /** shell_action 的超时时间；为空时使用默认值 */
  timeout_ms: number | null;
  /** shell_action 失败后的最大重试次数；默认 3 */
  max_retry: number;
  /** Cron 所属 workspace,用于调度到 workspace default session */
  workspace: string | null;
  /** 旧 Director 标识；仅作为历史迁移输入/展示残留 */
  source_director: string | null;
}

export interface CreateCronJobInput {
  name: string;
  role: string;
  agent?: string;
  description: string;
  prompt: string;
  schedule: string;
  enabled?: boolean;
  action_type?: CronActionType;
  message?: string;
  action_name?: string;
  timeout_ms?: number;
  max_retry?: number;
  /** Cron 所属 workspace,用于调度到 workspace default session */
  workspace?: string;
  /** 旧发起方 Director 标识；仅作为历史迁移输入 */
  source_director?: string;
}

function rowToCronJob(row: Record<string, unknown>): CronJob {
  return {
    ...row,
    enabled: row.enabled === 1,
    action_type: (row.action_type as CronActionType) ?? 'spawn_role',
    message: (row.message as string) ?? null,
    action_name: (row.action_name as string) ?? null,
    timeout_ms: row.timeout_ms === null || row.timeout_ms === undefined ? null : Number(row.timeout_ms),
    max_retry: row.max_retry === null || row.max_retry === undefined ? 3 : Number(row.max_retry),
    workspace: (row.workspace as string) ?? null,
    source_director: (row.source_director as string) ?? null,
  } as CronJob;
}

export function createCronJob(input: CreateCronJobInput): CronJob {
  const d = getDb();
  const id = generateCronId(d);
  const now = localNow();
  const enabled = input.enabled !== false ? 1 : 0;
  const lastRunAt = enabled && isDailySchedule(input.schedule) ? now : null;
  const actionType = input.action_type ?? 'spawn_role';
  const message = input.message ?? null;
  const actionName = input.action_name ?? null;
  const timeoutMs = input.timeout_ms ?? null;
  const maxRetry = input.max_retry ?? 3;
  const workspace = input.workspace?.trim() || null;

  d.run(
    `INSERT INTO cron_jobs (id, name, role, agent, description, prompt, schedule, enabled, last_run_at, created_at, updated_at, action_type, message, action_name, timeout_ms, max_retry, source_director, workspace)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.name, input.role, input.agent?.trim() || null, input.description, input.prompt, input.schedule, enabled, lastRunAt, now, now, actionType, message, actionName, timeoutMs, maxRetry, null, workspace],
  );

  return getCronJob(id)!;
}

function isDailySchedule(schedule: string): boolean {
  return /^daily\s+\d{2}:\d{2}$/.test(schedule);
}

export function getCronJob(id: string): CronJob | null {
  const row = getDb().query('SELECT * FROM cron_jobs WHERE id = ?').get(id) as Record<string, unknown> | null;
  return row ? rowToCronJob(row) : null;
}

export function listCronJobs(filter?: { enabled?: boolean }): CronJob[] {
  if (filter?.enabled !== undefined) {
    const rows = getDb().query('SELECT * FROM cron_jobs WHERE enabled = ? ORDER BY created_at DESC').all(filter.enabled ? 1 : 0) as Record<string, unknown>[];
    return rows.map(rowToCronJob);
  }
  const rows = getDb().query('SELECT * FROM cron_jobs ORDER BY created_at DESC').all() as Record<string, unknown>[];
  return rows.map(rowToCronJob);
}

export function updateCronJob(id: string, update: Partial<Omit<CronJob, 'id' | 'created_at'>>): CronJob | null {
  const allowed = ['name', 'role', 'agent', 'description', 'prompt', 'schedule', 'enabled', 'last_run_at', 'action_type', 'message', 'action_name', 'timeout_ms', 'max_retry', 'workspace'] as const;
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
  params.push(localNow());
  params.push(id);
  getDb().run(`UPDATE cron_jobs SET ${sets.join(', ')} WHERE id = ?`, params);
  return getCronJob(id);
}

export function deleteCronJob(id: string): boolean {
  const result = getDb().run('DELETE FROM cron_jobs WHERE id = ?', [id]);
  return result.changes > 0;
}

export function toggleCronJob(id: string): CronJob | null {
  const job = getCronJob(id);
  if (!job) return null;

  const now = localNow();
  const enabled = !job.enabled;
  const lastRunAt = enabled && isDailySchedule(job.schedule) ? now : job.last_run_at;
  getDb().run('UPDATE cron_jobs SET enabled = ?, last_run_at = ?, updated_at = ? WHERE id = ?', [enabled ? 1 : 0, lastRunAt, now, id]);
  return getCronJob(id);
}

// --- Sessions CRUD ---

export interface SessionRow {
  session_id: string;
  workspace: string;
  session_name: string | null;
  archived: number;
  role: string | null;
  cwd: string | null;
  agent_name: string | null;
  agent_type: string | null;
  model: string | null;
  created_at: string | null;
  first_message_at: string | null;
  last_message_at: string | null;
  alive: number;
}

export interface SessionPatch {
  sessionName?: string | null;
  firstMessageAt?: string;
  lastMessageAt?: string;
  agentName?: string | null;
  agentType?: string | null;
  model?: string | null;
}

export function upsertSession(workspace: string, sessionId: string, patch: SessionPatch): void {
  const now = localNow();
  const firstAt = patch.firstMessageAt ?? now;
  const lastAt = patch.lastMessageAt ?? now;
  getDb().run(
    `INSERT INTO sessions (session_id, workspace, session_name, first_message_at, last_message_at, alive, agent_name, agent_type, model)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       last_message_at = ?,
       alive = 1,
       agent_name = COALESCE(?, agent_name),
       agent_type = COALESCE(?, agent_type),
       model = COALESCE(?, model)`,
    [
      sessionId, workspace, patch.sessionName ?? null, firstAt, lastAt,
      patch.agentName ?? null, patch.agentType ?? null, patch.model ?? null,
      lastAt,
      patch.agentName ?? null, patch.agentType ?? null, patch.model ?? null,
    ],
  );
}

export function markSessionAlive(sessionId: string, alive: boolean): void {
  getDb().run('UPDATE sessions SET alive = ? WHERE session_id = ?', [alive ? 1 : 0, sessionId]);
}

export function setSessionNameInDb(sessionId: string, name: string | null): void {
  getDb().run('UPDATE sessions SET session_name = ? WHERE session_id = ?', [name, sessionId]);
}

export function listSessionsFromDb(workspace: string, opts?: { includeArchived?: boolean }): SessionRow[] {
  // 与 listSessionRecords 行为对齐:默认隐藏 archived=1,供 UI 默认列表使用;
  // 显式 includeArchived=true 时返回全部(管理面板/审计场景)。
  if (opts?.includeArchived) {
    return getDb().query(
      'SELECT * FROM sessions WHERE workspace = ? ORDER BY last_message_at DESC',
    ).all(workspace) as SessionRow[];
  }
  return getDb().query(
    'SELECT * FROM sessions WHERE workspace = ? AND archived = 0 ORDER BY last_message_at DESC',
  ).all(workspace) as SessionRow[];
}

export interface WorkspaceSessionStats {
  sessionCount: number;
  lastMessageAt: string | null;
}

export function getWorkspaceSessionStats(workspace: string): WorkspaceSessionStats {
  const row = getDb().query(
    `SELECT COUNT(*) AS sessionCount,
            MAX(last_message_at) AS lastMessageAt
     FROM sessions WHERE workspace = ? AND archived = 0`,
  ).get(workspace) as { sessionCount: number; lastMessageAt: string | null } | null;
  return {
    sessionCount: Number(row?.sessionCount ?? 0),
    lastMessageAt: row?.lastMessageAt ?? null,
  };
}

export function hasAnySessionHistory(workspace: string): boolean {
  const row = getDb().query(
    'SELECT COUNT(*) AS cnt FROM sessions WHERE workspace = ?',
  ).get(workspace) as { cnt: number } | null;
  return (row?.cnt ?? 0) > 0;
}

export function deleteSessionsByWorkspace(workspace: string): number {
  const result = getDb().run('DELETE FROM sessions WHERE workspace = ?', [workspace]);
  return result.changes;
}

// --- Workspaces CRUD ---

export interface Workspace {
  name: string;
  default_session_id: string | null;
  cwd: string | null;
  agent: string | null;
  created_at: string;
  updated_at: string;
}

export function createWorkspace(name: string, opts?: { cwd?: string; agent?: string; defaultSessionId?: string }): Workspace {
  const now = localNow();
  getDb().run(
    `INSERT INTO workspaces (name, default_session_id, cwd, agent, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       cwd = COALESCE(?, cwd),
       agent = COALESCE(?, agent),
       updated_at = ?`,
    [name, opts?.defaultSessionId ?? null, opts?.cwd ?? null, opts?.agent ?? null, now, now,
     opts?.cwd ?? null, opts?.agent ?? null, now],
  );
  return getWorkspace(name)!;
}

export function getWorkspace(name: string): Workspace | null {
  return getDb().query('SELECT * FROM workspaces WHERE name = ?').get(name) as Workspace | null;
}

export function listWorkspaces(): Workspace[] {
  return getDb().query('SELECT * FROM workspaces ORDER BY updated_at DESC').all() as Workspace[];
}

export function updateWorkspace(name: string, patch: Partial<Omit<Workspace, 'name' | 'created_at'>>): Workspace | null {
  const allowed = ['default_session_id', 'cwd', 'agent'] as const;
  const sets: string[] = [];
  const params: SQLQueryBindings[] = [];

  for (const key of allowed) {
    if (key in patch) {
      sets.push(`${key} = ?`);
      params.push((patch as Record<string, unknown>)[key] as SQLQueryBindings);
    }
  }

  if (sets.length === 0) return getWorkspace(name);

  sets.push('updated_at = ?');
  params.push(localNow());
  params.push(name);
  getDb().run(`UPDATE workspaces SET ${sets.join(', ')} WHERE name = ?`, params);
  return getWorkspace(name);
}

export function renameWorkspace(oldName: string, newName: string): Workspace | null {
  const now = localNow();
  const d = getDb();
  const tx = d.transaction(() => {
    d.run('UPDATE workspaces SET name = ?, updated_at = ? WHERE name = ?', [newName, now, oldName]);
    d.run('UPDATE sessions SET workspace = ? WHERE workspace = ?', [newName, oldName]);
    d.run('UPDATE cron_jobs SET workspace = ? WHERE workspace = ?', [newName, oldName]);
  });
  tx();
  return getWorkspace(newName);
}

export function setDefaultSession(workspaceName: string, sessionId: string | null): void {
  getDb().run(
    'UPDATE workspaces SET default_session_id = ?, updated_at = ? WHERE name = ?',
    [sessionId, localNow(), workspaceName],
  );
}

export function deleteWorkspace(name: string): boolean {
  const result = getDb().run('DELETE FROM workspaces WHERE name = ?', [name]);
  return result.changes > 0;
}

// --- New Session CRUD (workspace-centric) ---

export interface CreateSessionInput {
  workspace: string;
  sessionId: string;
  sessionName?: string;
  role?: string;
  cwd?: string;
  agentName?: string;
  agentType?: string;
  model?: string;
}

export function createSessionRecord(input: CreateSessionInput): SessionRow {
  const now = localNow();
  getDb().run(
    `INSERT INTO sessions (session_id, workspace, session_name, archived, role, cwd, agent_name, agent_type, model, created_at, first_message_at, last_message_at, alive)
     VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    [
      input.sessionId, input.workspace, input.sessionName ?? null,
      input.role ?? null, input.cwd ?? null,
      input.agentName ?? null, input.agentType ?? null, input.model ?? null,
      now, now, now,
    ],
  );
  return getSessionRecord(input.sessionId)!;
}

export function getSessionRecord(sessionId: string): SessionRow | null {
  return getDb().query('SELECT * FROM sessions WHERE session_id = ?').get(sessionId) as SessionRow | null;
}

export function archiveSession(sessionId: string): boolean {
  const result = getDb().run('UPDATE sessions SET archived = 1 WHERE session_id = ?', [sessionId]);
  return result.changes > 0;
}

export function listSessionRecords(workspace: string, opts?: { includeArchived?: boolean }): SessionRow[] {
  if (opts?.includeArchived) {
    return getDb().query(
      'SELECT * FROM sessions WHERE workspace = ? ORDER BY created_at DESC',
    ).all(workspace) as SessionRow[];
  }
  return getDb().query(
    'SELECT * FROM sessions WHERE workspace = ? AND archived = 0 ORDER BY created_at DESC',
  ).all(workspace) as SessionRow[];
}

// ---------------------------------------------------------------------------
// Shared helper: build parent-director metadata for task records
// ---------------------------------------------------------------------------

export interface TaskParentStatusInput {
  alive: boolean;
  sessionId: string | null;
  sessionName: string | null;
  agentName?: string;
  agentType?: string;
  personaRole?: string;
  pid?: number | null;
}

export interface TaskParentSourceInput {
  workspace?: string | null;
  sourceSessionId?: string | null;
  /** Runtime label is diagnostic-only; do not use it for callback routing. */
  runtimeLabel?: string | null;
}

/**
 * Build parent session metadata to attach to a task's `extra` field.
 * Pure function — callers resolve the session status before calling.
 */
export function buildTaskParentMetadata(
  source: TaskParentSourceInput,
  status: TaskParentStatusInput | null | undefined,
): TaskExtra {
  const meta: TaskExtra = {
    parent_workspace: source.workspace ?? null,
    parent_session_id: source.sourceSessionId ?? status?.sessionId ?? null,
    parent_runtime_label: source.runtimeLabel ?? null,
    parent_session_status: status ? (status.alive ? 'alive' : 'offline') : 'not-found',
  };
  if (!status) return meta;
  meta.parent_session_name = status.sessionName;
  meta.parent_agent = status.agentName;
  meta.parent_agent_type = status.agentType;
  meta.parent_persona_role = status.personaRole;
  meta.parent_pid = status.pid;
  if (status.agentType === 'codex-app-server') {
    meta.parent_codex_thread_id = status.sessionId ?? undefined;
  }
  return meta;
}
