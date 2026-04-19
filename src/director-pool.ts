import { createHash } from 'crypto';
import { EventEmitter } from 'events';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { SessionBridge, type SessionBridgeOptions } from './session-bridge.js';
import { MessageQueue, type QueueItem } from './queue.js';
import { ClaudeProcess } from './claude-process.js';
import type { Config } from './config.js';
import type { MessagingClient } from './messaging/messaging.js';
import { getState, setState } from './task/task-store.js';
import type { AttachmentBuffer } from './console.js';
import { log, getLogDir } from './logger.js';

/** Pool entry data persisted to SQLite for crash recovery */
interface PersistedPoolEntry {
  routingKey: string;
  feishuChatId: string;
  groupName: string;
  label: string;
  lastActiveAt: number;
  directorAgentName?: string;
}

export interface PoolConfig {
  max_directors: number;
  idle_timeout_minutes: number;
  small_group_threshold: number;
}

export interface PoolEntry {
  bridge: SessionBridge;
  queue: MessageQueue;
  routingKey: string;       // Map key（chatId 或 threadId）
  feishuChatId: string;     // 实际的飞书 chatId（oc_xxx），用于 sendMessage
  groupName: string;
  lastActiveAt: number;
  directorAgentName?: string;
}

/** Metadata for closed pool sessions (kept for UI display) */
interface ClosedPoolEntry {
  routingKey: string;
  feishuChatId: string;
  groupName: string;
  label: string;
  lastActiveAt: number;
  closedAt: number;
  directorAgentName?: string;
}

/** 管理多个 Director 会话实例的生命周期。
 *
 *  命名说明："DirectorPool" 是领域概念（管理多个 Director 角色的会话），
 *  底层实现使用 SessionBridge。保留 "Director" 命名以对齐架构文档和用户心智模型。 */
export class DirectorPool extends EventEmitter {
  private entries: Map<string, PoolEntry> = new Map();
  private closedEntries: Map<string, ClosedPoolEntry> = new Map();
  private creating: Map<string, Promise<PoolEntry>> = new Map();
  private mainBridge: SessionBridge;
  private poolConfig: PoolConfig;
  private agentsConfig: Config['agents'];
  private directorConfig: Config['director'];
  private messaging: MessagingClient;
  private attachmentBuffer?: AttachmentBuffer;
  private idleTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    mainBridge: SessionBridge,
    poolConfig: PoolConfig,
    agentsConfig: Config['agents'],
    directorConfig: Config['director'],
    messaging: MessagingClient,
    attachmentBuffer?: AttachmentBuffer,
  ) {
    super();
    this.mainBridge = mainBridge;
    this.poolConfig = poolConfig;
    this.agentsConfig = agentsConfig;
    this.directorConfig = directorConfig;
    this.messaging = messaging;
    this.attachmentBuffer = attachmentBuffer;

    // Restore closed entries from SQLite
    const savedClosed = getState<ClosedPoolEntry[]>('pool:closed');
    if (savedClosed) {
      for (const entry of savedClosed) {
        this.closedEntries.set(entry.routingKey, entry);
      }
    }

    // Start idle Director reaper — check every minute, shutdown Directors
    // that have been idle longer than idle_timeout_minutes
    if (poolConfig.idle_timeout_minutes > 0) {
      this.idleTimer = setInterval(() => this.reapIdle(), 60_000);
    }
  }

  /** Get the main (p2p) SessionBridge */
  getMain(): SessionBridge {
    return this.mainBridge;
  }

  /** Get a group Director if it exists (by routingKey) */
  get(routingKey: string): PoolEntry | undefined {
    return this.entries.get(routingKey);
  }

  /** Find a pool entry by Director label (for task callback routing) */
  findByLabel(label: string): PoolEntry | undefined {
    for (const entry of this.entries.values()) {
      if (entry.bridge.label === label) return entry;
    }
    return undefined;
  }

  /** Number of active group Directors */
  get size(): number {
    return this.entries.size;
  }

  /** Set attachment buffer (called after pool construction to avoid circular dependency) */
  setAttachmentBuffer(buffer: AttachmentBuffer): void {
    this.attachmentBuffer = buffer;
  }

  /** Get or create a Director for a group chat.
   *  @param routingKey — Map key (chatId for regular groups, threadId for topic groups)
   *  @param opts — group metadata for creation */
  async getOrCreate(routingKey: string, opts: { groupName?: string; feishuChatId: string; directorAgentName?: string }): Promise<PoolEntry> {
    const existing = this.entries.get(routingKey);
    if (existing) {
      existing.lastActiveAt = Date.now();
      if (opts.groupName && opts.groupName !== existing.groupName) {
        existing.groupName = opts.groupName;
      }
      existing.directorAgentName = existing.bridge.getDirectorAgentName();
      this.persistEntries();
      return existing;
    }

    // 防止并发创建同一个 routingKey 的 Director（竞态锁）
    const inflight = this.creating.get(routingKey);
    if (inflight) return inflight;

    const promise = this._doCreate(routingKey, opts);
    this.creating.set(routingKey, promise);
    try {
      return await promise;
    } finally {
      this.creating.delete(routingKey);
    }
  }

  private async _doCreate(routingKey: string, opts: { groupName?: string; feishuChatId: string; directorAgentName?: string }): Promise<PoolEntry> {
    // Evict LRU if at capacity
    if (this.entries.size >= this.poolConfig.max_directors) {
      await this.evictLRU();
    }

    const label = routingKeyToLabel(routingKey);
    const name = opts.groupName ?? routingKey.slice(0, 8);
    console.log(`[pool] Creating session bridge for group "${name}" (label=${label})`);

    const bridge = new SessionBridge({
      agents: this.agentsConfig,
      config: this.directorConfig,
      directorAgentName: opts.directorAgentName,
      label,
      isMain: false,
      groupName: name,
    } satisfies SessionBridgeOptions);

    const queue = new MessageQueue(join(getLogDir(), `queue-${label}.log`));

    await bridge.start();
    const activeDirectorAgentName = bridge.getDirectorAgentName();

    // Wire events BEFORE bootstrap so response handler is ready
    this.wireEvents(bridge, queue, routingKey, opts.feishuChatId, name);

    const entry: PoolEntry = {
      bridge,
      queue,
      routingKey,
      feishuChatId: opts.feishuChatId,
      groupName: name,
      lastActiveAt: Date.now(),
      directorAgentName: activeDirectorAgentName,
    };
    this.entries.set(routingKey, entry);
    this.closedEntries.delete(routingKey); // re-activated
    this.persistEntries();

    // Skip bootstrap if resuming an existing session (e.g. after shell restart).
    // The Director already has context from the previous session.
    if (!bridge.hasRestoredSession) {
      // Pass session state file so the Director can restore group context if available.
      const statePath = bridge.getSessionStatePath();
      await bridge.bootstrap(statePath);
    } else {
      console.log(`[pool] Skipping bootstrap for "${name}" — resumed existing session`);
    }

    return entry;
  }

  /** Send a message to a group Director, managing queue correlation */
  async send(routingKey: string, text: string, messageId: string): Promise<void> {
    const entry = this.entries.get(routingKey);
    if (!entry) throw new Error(`No Director for routingKey ${routingKey}`);

    entry.lastActiveAt = Date.now();
    const correlationId = entry.queue.enqueue({ text, messageId, chatId: entry.feishuChatId });
    entry.queue.logAction('SEND_TO_DIRECTOR', messageId, `cid=${correlationId} ${text.slice(0, 100)}`);

    try {
      await entry.bridge.send(text);
    } catch (err) {
      entry.queue.resolve(correlationId);
      throw err;
    }
  }

  /** Notify a specific pool Director that a task has completed.
   *  If the Director is dead, revive it first.
   *  @returns the feishuChatId for sending the notification message */
  async notifyTaskDone(label: string, taskId: string, success: boolean, notifyMsgId?: string): Promise<void> {
    let entry = this.findByLabel(label);

    if (!entry) {
      console.warn(`[pool] Director ${label} not found for task callback, cannot revive (routing context lost)`);
      // Fallback: notify main Director
      await this.mainBridge.notifyTaskDone(taskId, success, notifyMsgId);
      return;
    }

    // Check if Director is alive, revive if dead
    if (!entry.bridge.getStatus().alive) {
      console.log(`[pool] Reviving dead Director "${entry.groupName}" (label=${label}) for task callback`);
      // Re-create the Director
      const routingKey = entry.routingKey;
      const groupName = entry.groupName;
      const feishuChatId = entry.feishuChatId;
      // Remove stale entry
      this.entries.delete(routingKey);
      // Create new one
      const newEntry = await this.getOrCreate(routingKey, {
        groupName,
        feishuChatId,
        directorAgentName: entry.directorAgentName,
      });
      entry = newEntry;
    }

    await entry.bridge.notifyTaskDone(taskId, success, notifyMsgId);
  }

  /** Get the feishuChatId for a Director by label (for sending notification messages) */
  getChatIdByLabel(label: string): string | null {
    const entry = this.findByLabel(label);
    return entry?.feishuChatId ?? null;
  }

  getDirectorAgentName(routingKey: string): string | undefined {
    return this.entries.get(routingKey)?.directorAgentName ?? this.closedEntries.get(routingKey)?.directorAgentName;
  }

  async setDirectorAgent(routingKey: string, opts: { groupName?: string; feishuChatId: string; directorAgentName: string }): Promise<PoolEntry> {
    const existing = this.entries.get(routingKey);
    if (existing) {
      if (opts.groupName && opts.groupName !== existing.groupName) {
        existing.groupName = opts.groupName;
      }
      existing.feishuChatId = opts.feishuChatId;
      existing.lastActiveAt = Date.now();
      const currentAgentName = existing.bridge.getDirectorAgentName();
      if (currentAgentName === opts.directorAgentName) {
        existing.directorAgentName = currentAgentName;
        this.persistEntries();
        return existing;
      }
      const switched = await existing.bridge.switchAgent(opts.directorAgentName);
      if (!switched) {
        throw new Error(`failed to switch Director for ${routingKey} to ${opts.directorAgentName}`);
      }
      existing.directorAgentName = existing.bridge.getDirectorAgentName();
      existing.lastActiveAt = Date.now();
      this.closedEntries.delete(routingKey);
      this.persistEntries();
      return existing;
    }

    const closed = this.closedEntries.get(routingKey);
    if (closed) {
      if (opts.groupName) closed.groupName = opts.groupName;
      closed.feishuChatId = opts.feishuChatId;
      closed.lastActiveAt = Date.now();
      closed.directorAgentName = opts.directorAgentName;
      setState('pool:closed', [...this.closedEntries.values()]);
    }

    return this.getOrCreate(routingKey, opts);
  }

  /** Shutdown a specific group Director */
  async shutdown(routingKey: string): Promise<void> {
    const entry = this.entries.get(routingKey);
    if (!entry) return;

    console.log(`[pool] Shutting down Director for group "${entry.groupName}"`);
    this.moveToClosedEntries(routingKey, entry);
    this.entries.delete(routingKey);
    this.persistEntries();
    await entry.bridge.shutdown();
  }

  /** Shutdown all non-main Directors */
  async shutdownAll(): Promise<void> {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    const keys = [...this.entries.keys()];
    for (const key of keys) {
      await this.shutdown(key);
    }
    console.log(`[pool] All ${keys.length} group Director(s) shut down`);
  }

  /** Detach from all pool Directors without killing them (for shell restart).
   *  Processes become orphans; restoreEntries() will reconnect on next startup. */
  async detachAll(): Promise<void> {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    const keys = [...this.entries.keys()];
    for (const key of keys) {
      const entry = this.entries.get(key);
      if (entry) {
        console.log(`[pool] Detaching Director for group "${entry.groupName}" (keeping alive for reconnect)`);
        await entry.bridge.detach();
      }
    }
    // Keep entries in persisted state so restoreEntries() can reconnect
    console.log(`[pool] Detached ${keys.length} group Director(s) — orphans preserved for reconnect`);
  }

  /** Get status of all pool entries (active + closed) for dashboard */
  getPoolStatus(): Array<{
    routingKey: string;
    groupName: string;
    label: string;
    lastActiveAt: number;
    directorStatus: ReturnType<SessionBridge['getStatus']> | null;
    queueLength: number;
    closed?: boolean;
    closedAt?: number;
  }> {
    const active = [...this.entries.values()].map((entry) => ({
      routingKey: entry.routingKey,
      groupName: entry.groupName,
      label: entry.bridge.label,
      lastActiveAt: entry.lastActiveAt,
      directorStatus: entry.bridge.getStatus(),
      queueLength: entry.queue.length,
      directorAgentName: entry.directorAgentName,
    }));
    const closed = [...this.closedEntries.values()].map((entry) => ({
      routingKey: entry.routingKey,
      groupName: entry.groupName,
      label: entry.label,
      lastActiveAt: entry.lastActiveAt,
      directorStatus: null,
      queueLength: 0,
      closed: true as const,
      closedAt: entry.closedAt,
      directorAgentName: entry.directorAgentName,
    }));
    return [...active, ...closed];
  }

  /** Move an active entry to the closed list (max 50, evict oldest) */
  private moveToClosedEntries(routingKey: string, entry: PoolEntry): void {
    this.closedEntries.set(routingKey, {
      routingKey,
      feishuChatId: entry.feishuChatId,
      groupName: entry.groupName,
      label: entry.bridge.label,
      lastActiveAt: entry.lastActiveAt,
      closedAt: Date.now(),
      directorAgentName: entry.directorAgentName,
    });
    // Evict oldest if over limit
    while (this.closedEntries.size > 50) {
      const oldest = this.closedEntries.keys().next().value!;
      this.closedEntries.delete(oldest);
    }
    setState('pool:closed', [...this.closedEntries.values()]);
  }

  /** Persist pool entries to SQLite for crash recovery */
  private persistEntries(): void {
    const data: PersistedPoolEntry[] = [...this.entries.values()].map(e => ({
      routingKey: e.routingKey,
      feishuChatId: e.feishuChatId,
      groupName: e.groupName,
      label: e.bridge.label,
      lastActiveAt: e.lastActiveAt,
      directorAgentName: e.directorAgentName,
    }));
    setState('pool:entries', data);
  }

  /** Restore pool entries from SQLite after Shell restart.
   *  For each persisted entry, check if the Director process is still alive:
   *  - alive → reconnect (reuse process + session)
   *  - dead → clean up pipe directory */
  async restoreEntries(): Promise<void> {
    const saved = getState<PersistedPoolEntry[]>('pool:entries');
    if (!saved || saved.length === 0) return;

    const pipeBaseDir = this.directorConfig.pipe_dir;
    let restored = 0;

    for (const item of saved) {
      const bridge = new SessionBridge({
        agents: this.agentsConfig,
        config: this.directorConfig,
        directorAgentName: item.directorAgentName,
        label: item.label,
        isMain: false,
        groupName: item.groupName,
      } satisfies SessionBridgeOptions);

      const queue = new MessageQueue(`logs/queue-${item.label}.log`);

      if (bridge.getDirectorAgentType() !== 'codex') {
        const pipeDir = join(pipeBaseDir, item.label);
        const pidFile = join(pipeDir, 'director.pid');

        // Claude-backed Directors are long-lived processes, so we only reconnect if the orphan is still alive.
        const proc = new ClaudeProcess({ pipeDir, pidFile, label: item.label });
        if (!proc.isAlive()) {
          console.log(`[pool] Orphan "${item.groupName}" (label=${item.label}) is dead, cleaning up`);
          proc.cleanPipes();
          continue;
        }

        console.log(`[pool] Reconnecting to orphan "${item.groupName}" (label=${item.label}, pid=${proc.getPid()})`);

        try {
          await bridge.start(); // start() detects alive process → reconnect path
        } catch (err) {
          console.error(`[pool] Failed to reconnect "${item.groupName}":`, err);
          // Kill the orphan — we can't talk to it
          proc.kill('SIGTERM');
          proc.cleanPipes();
          continue;
        }
      } else {
        // Codex-backed Directors are turn-based transports, not long-lived OS daemons.
        // Restoring the persisted session metadata is enough; the next turn will spawn `codex exec` again.
        console.log(`[pool] Restoring Codex Director for "${item.groupName}" (label=${item.label})`);
        try {
          await bridge.start();
        } catch (err) {
          console.error(`[pool] Failed to restore Codex Director "${item.groupName}":`, err);
          continue;
        }
      }

      this.wireEvents(bridge, queue, item.routingKey, item.feishuChatId, item.groupName);

      const entry: PoolEntry = {
        bridge,
        queue,
        routingKey: item.routingKey,
        feishuChatId: item.feishuChatId,
        groupName: item.groupName,
        lastActiveAt: item.lastActiveAt,
        directorAgentName: bridge.getDirectorAgentName(),
      };
      this.entries.set(item.routingKey, entry);
      this.closedEntries.delete(item.routingKey); // re-activated, remove stale closed entry
      restored++;
    }

    // Update persisted state (remove dead entries)
    this.persistEntries();
    console.log(`[pool] Restored ${restored}/${saved.length} pool Director(s)`);
  }

  /** Kill orphan Director processes not tracked in the pool.
   *  Scans pipe directories for alive processes that aren't in `entries`. */
  async killUnknownOrphans(): Promise<void> {
    const pipeBaseDir = this.directorConfig.pipe_dir;
    const knownLabels = new Set([...this.entries.values()].map(e => e.bridge.label));
    // Also exclude main Director's pipe dir
    knownLabels.add('');  // pipeBaseDir itself has director.pid

    let dirNames: string[];
    try {
      dirNames = readdirSync(pipeBaseDir)
        .map(String)
        .filter(name => {
          try { return existsSync(join(pipeBaseDir, name, 'director.pid')); } catch { return false; }
        });
    } catch {
      return; // pipe dir doesn't exist yet
    }

    for (const name of dirNames) {
      if (knownLabels.has(name)) continue;

      const pipeDir = join(pipeBaseDir, name);
      const pidFile = join(pipeDir, 'director.pid');

      const proc = new ClaudeProcess({ pipeDir, pidFile, label: name });
      if (proc.isAlive()) {
        console.log(`[pool] Killing unknown orphan ${name} (pid=${proc.getPid()})`);
        proc.kill('SIGTERM');
      }
      proc.cleanPipes();
    }
  }

  /** Reap idle Directors that have exceeded idle_timeout_minutes.
   *  Keeps at least 3 Directors alive regardless of idle time. */
  private reapIdle(): void {
    if (this.entries.size <= 3) return;

    const timeoutMs = this.poolConfig.idle_timeout_minutes * 60_000;
    const now = Date.now();

    for (const [routingKey, entry] of this.entries) {
      if (this.entries.size <= 3) break;
      // Skip Directors with pending messages
      if (entry.queue.length > 0) continue;

      if (now - entry.lastActiveAt > timeoutMs) {
        console.log(`[pool] Reaping idle Director for group "${entry.groupName}" (idle ${Math.floor((now - entry.lastActiveAt) / 1000)}s)`);
        this.shutdown(routingKey).catch((err) => {
          console.error(`[pool] Failed to reap idle Director "${entry.groupName}":`, err);
        });
      }
    }
  }

  /** Wire SessionBridge events for a group chat */
  private wireEvents(bridge: SessionBridge, queue: MessageQueue, routingKey: string, feishuChatId: string, groupName: string): void {
    const isWeb = routingKey.startsWith('web-');

    // response → resolve oldest queue item → reply to feishu (or web)
    bridge.on('response', async (reply: string, durationMs?: number) => {
      const item = queue.resolveOldest();
      if (!item) {
        console.warn(`[pool:${groupName}] Got response but queue is empty`);
        return;
      }

      const elapsedMs = (typeof durationMs === 'number' && durationMs > 0)
        ? durationMs
        : Date.now() - item.timestamp;
      const elapsedSec = (elapsedMs / 1000).toFixed(1);
      const replyWithTiming = `${reply}\n\n(耗时 ${elapsedSec}s)`;

      if (isWeb) {
        this.emit('web-reply', bridge.label, item.messageId, replyWithTiming);
        queue.logAction('WEB_REPLY_SENT', item.messageId, `cid=${item.correlationId} elapsed=${elapsedSec}s`);
        console.log(`[pool:${groupName}] Web replied to ${item.messageId} (${elapsedSec}s)`);
        return;
      }

      try {
        await this.messaging.reply(item.messageId, replyWithTiming);
        queue.logAction('REPLY_SENT', item.messageId, `cid=${item.correlationId} elapsed=${elapsedSec}s`);
        console.log(`[pool:${groupName}] Replied to ${item.messageId} (${elapsedSec}s)`);

        // Compositor: drain buffered attachments for this pool Director
        const attachments = this.attachmentBuffer?.drain(bridge.label) ?? [];
        for (const filePath of attachments) {
          try {
            const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
            const imageExts = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.ico']);
            if (imageExts.has(ext)) {
              await this.messaging.uploadAndReplyImage(item.messageId, filePath);
            } else {
              await this.messaging.uploadAndReplyFile(item.messageId, filePath);
            }
            log.debug(`[pool:${groupName}] Compositor: sent attachment ${filePath}`);
          } catch (attErr) {
            console.error(`[pool:${groupName}] Compositor: failed to send attachment ${filePath}:`, attErr);
          }
        }
      } catch (err) {
        queue.logAction('ERROR', item.messageId, `cid=${item.correlationId} ${String(err)}`);
        console.error(`[pool:${groupName}] reply failed, trying sendMessage as fallback:`, err);
        await this.messaging.sendMessage(feishuChatId, replyWithTiming).catch((e) => {
          console.error(`[pool:${groupName}] sendMessage fallback also failed:`, e);
        });
      }
    });

    // system-response → reply to task notification message (web sessions: forward via WebSocket)
    bridge.on('system-response', async (reply: string, replyToMessageId: string) => {
      if (isWeb) {
        this.emit('web-reply', bridge.label, replyToMessageId, reply);
        return;
      }
      try {
        await this.messaging.reply(replyToMessageId, reply);
        log.debug(`[pool:${groupName}] System response replied to ${replyToMessageId}`);
      } catch (err) {
        console.warn(`[pool:${groupName}] Failed to reply system response:`, err);
      }
    });

    // close → remove from pool
    bridge.on('close', () => {
      console.log(`[pool] Session bridge for group "${groupName}" closed, removing from pool`);
      const entry = this.entries.get(routingKey);
      if (entry) this.moveToClosedEntries(routingKey, entry);
      this.entries.delete(routingKey);
      this.persistEntries();
    });

    // alert → forward to group chat or web
    bridge.on('alert', (message: string) => {
      if (isWeb) {
        this.emit('web-alert', bridge.label, message);
        return;
      }
      this.messaging.sendMessage(feishuChatId, message).catch((err) => {
        console.warn(`[pool:${groupName}] Failed to send alert:`, err);
      });
    });

    // cron-response → forward Director's cron message response to the group chat (or web)
    bridge.on('cron-response', (reply: string) => {
      if (isWeb) {
        this.emit('web-alert', bridge.label, reply);
        return;
      }
      this.messaging.sendMessage(feishuChatId, reply).catch((err) => {
        console.warn(`[pool:${groupName}] Failed to forward cron response:`, err);
      });
    });

    // auto-flush-complete → notify group chat or web
    bridge.on('auto-flush-complete', () => {
      if (isWeb) {
        this.emit('web-alert', bridge.label, '🔄 上下文已自动刷新');
        return;
      }
      this.messaging.sendMessage(feishuChatId, '🔄 上下文已自动刷新').catch((err) => {
        console.warn(`[pool:${groupName}] Failed to send flush notification:`, err);
      });
    });

    // flush-drain-complete → clear orphaned queue items
    bridge.on('flush-drain-complete', () => {
      const orphaned = queue.clearAll();
      if (orphaned.length > 0) {
        console.log(`[pool:${groupName}] Cleared ${orphaned.length} orphaned queue items after flush drain`);
      }
    });

    // queue-desync → clear orphaned queue items after Director crash
    bridge.on('queue-desync', () => {
      const orphans = queue.clearAll();
      if (orphans.length > 0) {
        console.warn(`[pool:${groupName}] Cleared ${orphans.length} orphaned queue items after crash`);
      }
    });

    // chunk / stream-abort → re-emit on pool level for console broadcast
    bridge.on('chunk', (text: string) => {
      this.emit('chunk', bridge.label, text);
    });
    bridge.on('stream-abort', () => {
      this.emit('stream-abort', bridge.label);
    });
  }

  /** Evict the least recently used group Director (skip Directors with pending messages) */
  private async evictLRU(): Promise<void> {
    let lruKey: string | null = null;
    let lruTime = Infinity;

    for (const [routingKey, entry] of this.entries) {
      // Skip Directors that are still processing messages
      if (entry.queue.length > 0) continue;
      if (entry.lastActiveAt < lruTime) {
        lruTime = entry.lastActiveAt;
        lruKey = routingKey;
      }
    }

    if (lruKey) {
      const entry = this.entries.get(lruKey)!;
      console.log(`[pool] Evicting LRU Director for group "${entry.groupName}" (idle ${Math.floor((Date.now() - lruTime) / 1000)}s)`);
      await this.shutdown(lruKey);
    } else {
      // All Directors have pending messages — cannot evict safely
      console.warn(`[pool] All ${this.entries.size} Directors are busy, cannot evict`);
      throw new Error('所有会话都在忙碌中，系统繁忙，请稍后重试');
    }
  }
}

/** Convert routingKey to a short, filesystem-safe label */
function routingKeyToLabel(routingKey: string): string {
  return createHash('sha256').update(routingKey).digest('hex').slice(0, 8);
}
