/**
 * Outbox Watcher — Monitor outbox/ for sub-role results, notify Director via pipe.
 * 
 * When a sub-role (Explorer, Critic, etc.) completes a task, it writes its result
 * to outbox/. This watcher detects new files and injects a system message into
 * Director's pipe so it knows a result has arrived.
 */
import { watch, existsSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';
import type { Director } from './director.js';

/** Files present at startup — don't notify for these */
let knownFiles = new Set<string>();

export function startOutboxWatcher(personaDir: string, director: Director): void {
  const outboxDir = join(personaDir, 'outbox');

  if (!existsSync(outboxDir)) {
    mkdirSync(outboxDir, { recursive: true });
  }

  // Snapshot existing files so we don't notify on startup
  try {
    for (const f of readdirSync(outboxDir)) {
      knownFiles.add(f);
    }
  } catch { /* empty dir is fine */ }

  console.log(`[outbox] Watching ${outboxDir} (${knownFiles.size} existing files)`);

  watch(outboxDir, (eventType, filename) => {
    if (!filename || eventType !== 'rename') return;
    if (filename.startsWith('.')) return; // ignore hidden files
    if (knownFiles.has(filename)) return;

    // Check file actually exists (rename fires on both create and delete)
    const filePath = join(outboxDir, filename);
    if (!existsSync(filePath)) return;

    knownFiles.add(filename);
    console.log(`[outbox] New result: ${filename}`);

    // Notify Director via pipe (non-blocking, best-effort)
    director.notifyOutbox(filename).catch((err) => {
      console.warn(`[outbox] Failed to notify Director:`, err);
    });
  });
}

/**
 * 6.2: Scan outbox for unprocessed files. Called before flush to warn about
 * potential context loss.
 */
export function countOutboxFiles(personaDir: string): number {
  const outboxDir = join(personaDir, 'outbox');
  try {
    return readdirSync(outboxDir).filter(f => !f.startsWith('.')).length;
  } catch {
    return 0;
  }
}
