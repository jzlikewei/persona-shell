import { createWorkspace, getWorkspace, listWorkspaces, updateWorkspace, setDefaultSession, getState, deleteState, type Workspace } from './task/task-store.js';

interface LegacyWorkspaceConfig {
  cwd?: string;
  agent?: string;
}

export class WorkspaceRegistry {
  getOrCreate(name: string, opts?: { cwd?: string; agent?: string }): Workspace {
    const existing = getWorkspace(name);
    if (existing) {
      if (opts?.cwd && opts.cwd !== existing.cwd) {
        updateWorkspace(name, { cwd: opts.cwd });
      }
      if (opts?.agent && opts.agent !== existing.agent) {
        updateWorkspace(name, { agent: opts.agent });
      }
      return getWorkspace(name)!;
    }
    return createWorkspace(name, opts);
  }

  get(name: string): Workspace | null {
    return getWorkspace(name);
  }

  list(): Workspace[] {
    return listWorkspaces();
  }

  setDefaultSession(workspaceName: string, sessionId: string | null): void {
    setDefaultSession(workspaceName, sessionId);
  }

  resolveDefaultSession(workspaceName: string): string | null {
    const ws = getWorkspace(workspaceName);
    return ws?.default_session_id ?? null;
  }

  /** Migrate legacy workspace:config:{name} KV entries to the workspaces table.
   *  Safe to call multiple times — skips already-migrated workspaces. */
  migrateFromLegacyKV(knownNames: string[]): number {
    let migrated = 0;
    for (const name of knownNames) {
      const key = `workspace:config:${name}`;
      const legacy = getState<LegacyWorkspaceConfig>(key);
      if (!legacy) continue;
      const existing = getWorkspace(name);
      if (!existing) {
        createWorkspace(name, { cwd: legacy.cwd, agent: legacy.agent });
        migrated++;
      } else {
        if (legacy.cwd && !existing.cwd) updateWorkspace(name, { cwd: legacy.cwd });
        if (legacy.agent && !existing.agent) updateWorkspace(name, { agent: legacy.agent });
      }
      deleteState(key);
    }
    return migrated;
  }
}
