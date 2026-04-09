# Runtime Expert Understanding — persona-shell

## Domain: Process Lifecycle & IPC

This is the most complex and historically bug-prone part of persona-shell.
The commit history shows multiple phases of resilience improvements:
- Phase 0: Critical bug fixes (null safety, error handling)
- Phase 3: Generation guard, restart backoff, error cleanup, reply retry
- Refactor: State unified to SQLite, Feishu disconnect auto-restart

## Director Process Model

```
Shell (main process)
  │
  ├── Director (Claude Code, detached, process group)
  │     ├── stdin:  /tmp/persona/director-in  (named pipe, Shell writes)
  │     ├── stdout: /tmp/persona/director-out (named pipe, Shell reads)
  │     └── stderr: /tmp/persona/director-stderr.log
  │
  └── Task subprocesses (Claude Code, detached, process groups)
        ├── stdout: pipe (parsed for stream-json events)
        └── stderr: logs/task-{id}.stderr.log
```

## Critical Invariants

1. **Generation counter** — Each `listenOutput()` call increments `this.generation`.
   Close handlers check their captured generation against current. This prevents
   stale handlers from triggering restart after a new pipe reader is already active.

2. **Pending count** — Tracks in-flight messages to Director. Used by FLUSH drain
   and close handler. Must be decremented on `result` event and reset to 0 on pipe close.

3. **FLUSH mutual exclusion** — `this.flushing` flag prevents concurrent flushes and
   blocks user message sends during flush. Interrupt is also blocked during flush.

4. **Restart backoff** — Timestamps of recent restarts are tracked. If >= 3 restarts
   within 5 minutes, Shell exits (letting launchd handle recovery at a higher level).

5. **System reply queue** — Task notification responses go through `systemReplyQueue`
   to route Director's reply back to the correct Feishu message for threading.

## Named Pipe Protocol

- **Format**: JSON lines (newline-delimited JSON)
- **Input**: `{ type: "user", message: { role: "user", content: "..." } }`
- **Output**: stream-json events from Claude Code CLI:
  - `{ type: "system", subtype: "init", session_id: "..." }` — session start
  - `{ type: "assistant", message: { content: "..." } }` — streaming content
  - `{ type: "result", usage: { input_tokens: N }, ... }` — turn complete

## FLUSH Flow (Detailed)

```
flush() called
  ├── Check flushing flag (abort if already flushing)
  ├── Wait for interrupt completion if in progress
  ├── Set flushing = true
  ├── DRAIN: wait for pendingCount → 0 (5min timeout)
  │     └── If timeout → abort flush, reset flag
  ├── CHECKPOINT: send [FLUSH] message → wait for Director response (5min timeout)
  │     └── If timeout → skip checkpoint, set discardNextResponse, continue to reset
  ├── RESET: kill(-pid, SIGTERM) + clearSession()
  ├── restart() → clean pipes → ensurePipes → spawnDirector → open pipes → listenOutput
  ├── BOOTSTRAP: send [FLUSH] restore message → wait for response (5min timeout)
  │     └── If timeout → force finish flush
  └── finishFlush(): reset lastFlushAt, lastInputTokens, flushing flag, persist state
```

## Known Sensitive Areas

- **Pipe open ordering** — Both pipe ends must be opened concurrently (`Promise.all`)
  because FIFO blocks until both reader and writer are connected.
- **discardNextResponse** — Safety valve for late responses after flush timeout.
  Without this, a stale checkpoint response could leak to users.
- **Process group kill** — `kill(-pid)` sends signal to entire process group.
  If PID is already dead, the call throws (caught with empty catch).
