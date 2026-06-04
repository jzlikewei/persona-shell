import { createWorkspace, getWorkspace, listWorkspaces, updateWorkspace, setDefaultSession, type Workspace } from './task/task-store.js';

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
}
