import { describe, expect, test, beforeEach } from 'bun:test';
import { rmSync, mkdirSync } from 'fs';
import {
  initTaskStore,
  createWorkspace,
  getWorkspace,
  listWorkspaces,
  updateWorkspace,
  setDefaultSession,
  deleteWorkspace,
  createSessionRecord,
  getSessionRecord,
  archiveSession,
  listSessionRecords,
} from '../task/task-store.js';
import { WorkspaceRegistry } from '../workspace-registry.js';

const TEST_DIR = '/tmp/persona-workspace-test';

describe('workspace data layer', () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    initTaskStore(TEST_DIR);
  });

  // --- Workspace CRUD ---
  describe('createWorkspace()', () => {
    test('creates workspace with name as PK', () => {
      const ws = createWorkspace('my-project');
      expect(ws.name).toBe('my-project');
      expect(ws.default_session_id).toBeNull();
      expect(ws.cwd).toBeNull();
      expect(ws.agent).toBeNull();
      expect(ws.created_at).toBeTruthy();
    });

    test('creates workspace with options', () => {
      const ws = createWorkspace('project-2', { cwd: '/home/user/code', agent: 'claude' });
      expect(ws.cwd).toBe('/home/user/code');
      expect(ws.agent).toBe('claude');
    });

    test('upsert: creating same name updates cwd/agent', () => {
      createWorkspace('ws1', { cwd: '/old' });
      const ws = createWorkspace('ws1', { cwd: '/new' });
      expect(ws.cwd).toBe('/new');
    });

    test('upsert: null cwd does not overwrite existing', () => {
      createWorkspace('ws1', { cwd: '/keep-this' });
      const ws = createWorkspace('ws1');
      expect(ws.cwd).toBe('/keep-this');
    });
  });

  describe('getWorkspace()', () => {
    test('returns workspace when exists', () => {
      createWorkspace('test-ws');
      const ws = getWorkspace('test-ws');
      expect(ws).not.toBeNull();
      expect(ws!.name).toBe('test-ws');
    });

    test('returns null when not exists', () => {
      expect(getWorkspace('nonexistent')).toBeNull();
    });
  });

  describe('listWorkspaces()', () => {
    test('returns all workspaces', () => {
      createWorkspace('ws-a');
      createWorkspace('ws-b');
      createWorkspace('ws-c');
      expect(listWorkspaces()).toHaveLength(3);
    });

    test('returns empty array when none exist', () => {
      expect(listWorkspaces()).toHaveLength(0);
    });
  });

  describe('updateWorkspace()', () => {
    test('updates cwd', () => {
      createWorkspace('ws1');
      updateWorkspace('ws1', { cwd: '/updated/path' });
      expect(getWorkspace('ws1')!.cwd).toBe('/updated/path');
    });

    test('updates agent', () => {
      createWorkspace('ws1');
      updateWorkspace('ws1', { agent: 'codex' });
      expect(getWorkspace('ws1')!.agent).toBe('codex');
    });

    test('empty update does not error', () => {
      createWorkspace('ws1');
      const result = updateWorkspace('ws1', {});
      expect(result!.name).toBe('ws1');
    });
  });

  describe('setDefaultSession()', () => {
    test('sets default session id', () => {
      createWorkspace('ws1');
      setDefaultSession('ws1', 'session-abc');
      expect(getWorkspace('ws1')!.default_session_id).toBe('session-abc');
    });

    test('clears default session with null', () => {
      createWorkspace('ws1');
      setDefaultSession('ws1', 'session-abc');
      setDefaultSession('ws1', null);
      expect(getWorkspace('ws1')!.default_session_id).toBeNull();
    });
  });

  describe('deleteWorkspace()', () => {
    test('deletes existing workspace', () => {
      createWorkspace('ws1');
      expect(deleteWorkspace('ws1')).toBe(true);
      expect(getWorkspace('ws1')).toBeNull();
    });

    test('returns false for non-existent', () => {
      expect(deleteWorkspace('nope')).toBe(false);
    });
  });

  // --- Session CRUD (new) ---
  describe('createSessionRecord()', () => {
    test('creates session with required fields', () => {
      const s = createSessionRecord({ sessionId: 'sess-1', workspace: 'ws1' });
      expect(s.session_id).toBe('sess-1');
      expect(s.workspace).toBe('ws1');
      expect(s.archived).toBe(0);
      expect(s.role).toBeNull();
      expect(s.cwd).toBeNull();
    });

    test('creates session with role and cwd', () => {
      const s = createSessionRecord({ sessionId: 'sess-2', workspace: 'ws1', role: 'philosopher', cwd: '/code' });
      expect(s.role).toBe('philosopher');
      expect(s.cwd).toBe('/code');
    });
  });

  describe('getSessionRecord()', () => {
    test('returns session when exists', () => {
      createSessionRecord({ sessionId: 'sess-1', workspace: 'ws1' });
      const s = getSessionRecord('sess-1');
      expect(s).not.toBeNull();
      expect(s!.session_id).toBe('sess-1');
    });

    test('returns null when not exists', () => {
      expect(getSessionRecord('nonexistent')).toBeNull();
    });
  });

  describe('archiveSession()', () => {
    test('archives existing session', () => {
      createSessionRecord({ sessionId: 'sess-1', workspace: 'ws1' });
      expect(archiveSession('sess-1')).toBe(true);
      expect(getSessionRecord('sess-1')!.archived).toBe(1);
    });

    test('returns false for non-existent', () => {
      expect(archiveSession('nope')).toBe(false);
    });
  });

  describe('listSessionRecords()', () => {
    test('lists non-archived sessions by default', () => {
      createSessionRecord({ sessionId: 's1', workspace: 'ws1' });
      createSessionRecord({ sessionId: 's2', workspace: 'ws1' });
      createSessionRecord({ sessionId: 's3', workspace: 'ws1' });
      archiveSession('s2');
      const sessions = listSessionRecords('ws1');
      expect(sessions).toHaveLength(2);
      expect(sessions.map(s => s.session_id).sort()).toEqual(['s1', 's3']);
    });

    test('includes archived when requested', () => {
      createSessionRecord({ sessionId: 's1', workspace: 'ws1' });
      createSessionRecord({ sessionId: 's2', workspace: 'ws1' });
      archiveSession('s2');
      const sessions = listSessionRecords('ws1', { includeArchived: true });
      expect(sessions).toHaveLength(2);
    });

    test('filters by workspace', () => {
      createSessionRecord({ sessionId: 's1', workspace: 'ws1' });
      createSessionRecord({ sessionId: 's2', workspace: 'ws2' });
      expect(listSessionRecords('ws1')).toHaveLength(1);
      expect(listSessionRecords('ws2')).toHaveLength(1);
    });
  });
});

describe('WorkspaceRegistry', () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    initTaskStore(TEST_DIR);
  });

  test('getOrCreate creates new workspace', () => {
    const registry = new WorkspaceRegistry();
    const ws = registry.getOrCreate('new-ws');
    expect(ws.name).toBe('new-ws');
    expect(getWorkspace('new-ws')).not.toBeNull();
  });

  test('getOrCreate returns existing workspace', () => {
    const registry = new WorkspaceRegistry();
    registry.getOrCreate('ws1');
    const ws = registry.getOrCreate('ws1');
    expect(ws.name).toBe('ws1');
    expect(listWorkspaces()).toHaveLength(1);
  });

  test('getOrCreate updates cwd if different', () => {
    const registry = new WorkspaceRegistry();
    registry.getOrCreate('ws1', { cwd: '/old' });
    registry.getOrCreate('ws1', { cwd: '/new' });
    expect(getWorkspace('ws1')!.cwd).toBe('/new');
  });

  test('get returns null for non-existent', () => {
    const registry = new WorkspaceRegistry();
    expect(registry.get('nope')).toBeNull();
  });

  test('resolveDefaultSession returns null when no default', () => {
    const registry = new WorkspaceRegistry();
    registry.getOrCreate('ws1');
    expect(registry.resolveDefaultSession('ws1')).toBeNull();
  });

  test('resolveDefaultSession returns session id after set', () => {
    const registry = new WorkspaceRegistry();
    registry.getOrCreate('ws1');
    registry.setDefaultSession('ws1', 'sess-abc');
    expect(registry.resolveDefaultSession('ws1')).toBe('sess-abc');
  });

  test('list returns all workspaces', () => {
    const registry = new WorkspaceRegistry();
    registry.getOrCreate('a');
    registry.getOrCreate('b');
    expect(registry.list()).toHaveLength(2);
  });
});
