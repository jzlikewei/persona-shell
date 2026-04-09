# Developer Understanding — persona-shell

## Project Overview

persona-shell is a message bridge service between Feishu (Lark) and Claude Code (called "Director").
It runs as a persistent daemon on macOS via launchd.

## Architecture

```
Feishu WebSocket → Shell (this project) → Named Pipe (FIFO) → Director (Claude Code) → Reply
                                             │
                                             ├─ Message Queue (correlation ID matching)
                                             ├─ Web Console (localhost:3000)
                                             ├─ Task System (SQLite + subprocess runner)
                                             └─ FLUSH mechanism (context window management)
```

## Source Files

| File | Responsibility |
|------|---------------|
| `src/index.ts` | Entry point — wires all components, registers event handlers |
| `src/feishu.ts` | Feishu WebSocket client, message send/reply, connection watchdog |
| `src/director.ts` | Director process lifecycle: spawn, pipes, FLUSH, restart, state |
| `src/queue.ts` | Message queue with correlation IDs, cancel, state persistence |
| `src/config.ts` | YAML config loading with sensible defaults |
| `src/console.ts` | Web management console (Bun.serve HTTP + WebSocket) |
| `src/task-store.ts` | SQLite data layer — tasks table + key-value state store |
| `src/task-runner.ts` | Subprocess lifecycle — spawn Claude Code for background tasks |
| `src/scheduler.ts` | setInterval-driven cron-like task scheduler |
| `src/task-mcp-server.ts` | MCP server (stdio JSON-RPC) proxying to Shell HTTP API |

## Key Patterns

- **EventEmitter** for async communication between components (Director emits `response`, `alert`, `auto-flush-complete`, `system-response`, `close`)
- **Console logging** with `[component]` prefix
- **SQLite** for both task data and general state persistence (replaced file-based state)
- **Named pipes** (mkfifo) for Director IPC — stream-json protocol
- **Process groups** — detached spawn + kill(-pid) for clean subprocess termination
- **Generation counter** — prevents stale close handlers after restart

## Dependencies

- `@larksuiteoapi/node-sdk` — Feishu API + WebSocket client
- `js-yaml` — YAML config parsing
- `bun:sqlite` — SQLite database (Bun built-in)

## Build & Check

```bash
bun install          # Install dependencies
bun run dev          # Development mode
bun run check        # TypeScript type check (tsc --noEmit)
bun run build        # Build to dist/
```
