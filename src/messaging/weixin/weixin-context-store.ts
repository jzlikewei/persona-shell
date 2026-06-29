import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const MAX_PROCESSED_IDS = 1000;

export class WeixinContextStore {
  private stateDir: string;
  private accountsDir: string;
  private contextTokens = new Map<string, string>();
  private processedIds = new Map<string, Set<string>>();
  private syncBufs = new Map<string, unknown>();

  constructor(stateDir: string) {
    this.stateDir = stateDir;
    this.accountsDir = join(stateDir, 'accounts');
  }

  private ensureDirs(): void {
    mkdirSync(this.accountsDir, { recursive: true });
  }

  // ── Context tokens ──

  private ctxKey(accountId: string, userId: string): string {
    return `${accountId}:${userId}`;
  }

  getContextToken(accountId: string, userId: string): string | undefined {
    return this.contextTokens.get(this.ctxKey(accountId, userId));
  }

  setContextToken(accountId: string, userId: string, token: string): void {
    this.contextTokens.set(this.ctxKey(accountId, userId), token);
    this.persistContextTokens(accountId);
  }

  loadContextTokens(accountId: string): void {
    const path = join(this.accountsDir, `${accountId}.context-tokens.json`);
    if (!existsSync(path)) return;
    try {
      const data = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, string>;
      for (const [userId, token] of Object.entries(data)) {
        this.contextTokens.set(this.ctxKey(accountId, userId), token);
      }
    } catch { /* ignore corrupt files */ }
  }

  private persistContextTokens(accountId: string): void {
    this.ensureDirs();
    const prefix = `${accountId}:`;
    const data: Record<string, string> = {};
    for (const [key, val] of this.contextTokens) {
      if (key.startsWith(prefix)) {
        data[key.slice(prefix.length)] = val;
      }
    }
    const path = join(this.accountsDir, `${accountId}.context-tokens.json`);
    writeFileSync(path, JSON.stringify(data, null, 2));
  }

  // ── Sync buffer ──

  getSyncBuf(accountId: string): unknown {
    if (this.syncBufs.has(accountId)) return this.syncBufs.get(accountId);
    const path = join(this.accountsDir, `${accountId}.sync-buf.json`);
    if (!existsSync(path)) return {};
    try {
      const data = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
      this.syncBufs.set(accountId, data);
      return data;
    } catch {
      return {};
    }
  }

  saveSyncBuf(accountId: string, buf: unknown): void {
    this.ensureDirs();
    this.syncBufs.set(accountId, buf);
    const path = join(this.accountsDir, `${accountId}.sync-buf.json`);
    writeFileSync(path, JSON.stringify(buf));
  }

  // ── Processed IDs (at-least-once dedup) ──

  getProcessedIds(accountId: string): Set<string> {
    if (this.processedIds.has(accountId)) return this.processedIds.get(accountId)!;
    const path = join(this.accountsDir, `${accountId}.processed-ids.json`);
    const set = new Set<string>();
    if (existsSync(path)) {
      try {
        const arr = JSON.parse(readFileSync(path, 'utf-8')) as string[];
        for (const id of arr.slice(-MAX_PROCESSED_IDS)) set.add(id);
      } catch { /* ignore */ }
    }
    this.processedIds.set(accountId, set);
    return set;
  }

  markProcessed(accountId: string, messageId: string): void {
    const set = this.getProcessedIds(accountId);
    set.add(messageId);
    if (set.size > MAX_PROCESSED_IDS) {
      const arr = Array.from(set);
      const trimmed = arr.slice(arr.length - MAX_PROCESSED_IDS);
      set.clear();
      for (const id of trimmed) set.add(id);
    }
    this.persistProcessedIds(accountId);
  }

  private persistProcessedIds(accountId: string): void {
    this.ensureDirs();
    const set = this.processedIds.get(accountId);
    if (!set) return;
    const path = join(this.accountsDir, `${accountId}.processed-ids.json`);
    writeFileSync(path, JSON.stringify(Array.from(set)));
  }
}
