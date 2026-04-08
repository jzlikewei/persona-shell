import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

const STATE_DIR = join(import.meta.dirname, '..', 'state');

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/** Write JSON data to state/{key}.json using atomic write-rename */
export function saveState<T>(key: string, data: T): void {
  ensureDir(STATE_DIR);
  const filePath = join(STATE_DIR, `${key}.json`);
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  renameSync(tmpPath, filePath);
}

/** Read JSON data from state/{key}.json, returns null if missing or corrupt */
export function loadState<T>(key: string): T | null {
  const filePath = join(STATE_DIR, `${key}.json`);
  try {
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
