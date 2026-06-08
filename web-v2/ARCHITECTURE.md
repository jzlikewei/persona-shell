# web-v2 Architecture

## Role

web-v2 is the React workbench for day-to-day persona-shell use and the only supported Web UI:

- supported today: Chat, Tasks, Files.
- not exposed on the Web today: full Runtime management, Automations editing, Persona editors, Logs, Settings, and deep diagnostics.

The backend remains the single source of truth. web-v2 does not read local files, logs, or SQLite directly.

## Runtime Shape

```text
Browser
  |
  | HTTP REST
  | WebSocket events
  v
persona-shell Bun process
  |
  +-- console.ts              HTTP API and WS server
  +-- WorkspaceRegistry       workspace CRUD/default session
  +-- SessionManager          sessionId -> running Agent bridge
  +-- task-store.ts           SQLite state/tasks/cron/workspaces/sessions
  +-- log-parser.ts           message/task log parsing
```

## Frontend Modules

```text
App.tsx
  TokenDialog
  BrowserRouter
    RootLayout
      Header
      Sidebar
      CommandPalette
      SwitchSheet
      NewSessionDialog
      WorkspaceCreateSheet
      Outlet
        ChatPage
        TasksPage
        FilesPage
        NotFoundPage
```

## State Ownership

| State | Owner | Notes |
|------|-------|-------|
| Auth token | `TokenDialog` + localStorage | Used by `useApi` and `useWebSocket` |
| Active workspace | `RootLayout` | Stored in localStorage |
| Active session | `useSessions` | Scoped by workspace |
| Chat messages | `useChat` | Loaded from `/api/messages` |
| Streaming turn state | `useChat` | Derived from WebSocket `turn_event`, `chunk`, `chat_reply` |
| Work context | `useWorkContext` | Loaded from `/api/work-context` |
| Tasks | `TasksPage` | Loaded from `/api/tasks` and task detail endpoints |
| Files | `FilesPage` | Loaded from `/api/files` and preview/download endpoints |

`useChat` must not choose or rewrite the active session. Session selection belongs to `useSessions` and `RootLayout`.

## HTTP APIs

web-v2 uses the backend API surface exposed by `src/console.ts`.

| Area | Endpoints |
|------|-----------|
| Workspaces | `GET /api/work-context`, `POST /api/workspaces`, `PUT /api/workspaces/:name/config` |
| Sessions | `GET /api/sessions`, `POST /api/sessions`, `POST /api/sessions/:id/archive`, `PUT /api/sessions/name` |
| Chat | `GET /api/messages`, `POST /api/send`, `POST /api/send-attachment`, `POST /api/files/upload` |
| Director actions | `POST /api/flush`, `POST /api/esc`, `POST /api/directors/command`, switch agent/persona endpoints |
| Tasks | `GET /api/tasks`, `GET /api/tasks/:id`, `GET /api/tasks/:id/logs`, `GET /api/tasks/:id/output` |
| Files | `GET /api/files`, `GET /api/files/preview`, `GET /api/files/download` |
| Cron summary | `GET /api/cron-jobs` |

web-v2 must use `workspace` and `sessionId` for business routing. Runtime-only endpoints may still expose diagnostic labels, but those labels are not workspace/session facts.

## WebSocket Events

`useWebSocket` owns connection lifecycle and dispatches events to hooks/pages.

Important events:

- `status`: runtime snapshot, pool status, queue, context, tasks.
- `context_update`: refresh workspace/session context.
- `turn_event`: structured turn lifecycle, including tool events.
- `chunk`: streaming text delta.
- `chat_reply`: final web chat response.
- `stream-abort`: clear in-progress streaming UI.
- `file_attachment`: show web-delivered file/image payloads.
- `task_callback`: desktop notification for task completion.

## Design Rules

- Do not add placeholder actions. Every visible control must call a real API or be removed.
- Keep cards for repeated items or dialogs only; page layout should stay workbench-like and dense.
- Prefer icons for tool actions and keep button labels short.
- Do not add old v1-only features unless a feature has a real current workflow and lands as a wired v2 feature.

## Verification

Minimum checks before considering a v2 change complete:

```bash
cd web-v2
bun run build
```

Project-level checks from the repo root:

```bash
bun run check
bun test
bun run smoke:web
```

Manual browser smoke should cover auth, workspace/session selection, send/stop chat, tool display, task detail, file preview, refresh, and reconnect.
