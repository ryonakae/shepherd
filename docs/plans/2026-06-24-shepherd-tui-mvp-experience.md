# Shepherd TUI MVP Experience Plan

Date: 2026-06-24

## Goal

Add the missing full-screen local TUI experience to Shepherd's MVP while preserving the existing daemon-centered architecture.

The target user experience is close to Claude Code, Codex, and Pi:

```bash
cd /path/to/work
shepherd
```

That command opens the Shepherd TUI, creates a new Shepherd session, and binds the current working directory as the session's working context. The TUI talks to the local Shepherd daemon. If the daemon is not running, the CLI starts it automatically before opening the TUI.

This plan fills gaps left by the archived Shepherd Herdr orchestration plans. Those plans already specify the shared event stream, daemon JSON Lines RPC, Slack sync, and Herdr mapping, but they do not describe the default `shepherd` TUI startup flow in enough detail.

## Recovered prior decisions

These decisions were made in an earlier Pi session but were only partially captured in the archived plans:

- TUI and messaging platforms are peers over the same Shepherd session event stream.
- Users should be able to switch between TUI and messaging platforms without manual continuation at the event-stream level. A TUI still needs a way to attach to an existing session, but once attached it receives replayed and live events.
- The default TUI experience should match terminal coding agents: `cd` to a directory and run `shepherd`.
- For TUI-created sessions, the current working directory is the working context.
- Shepherd should use a daemon + clients architecture. The TUI is a local client; the daemon owns DB, gateway turns, Slack, Herdr progress subscriptions, and delivery fanout.
- If the daemon is not running, `shepherd` should start it automatically for the local user.
- Hermes Agent is a gateway architecture reference, but Hermes TUI is not the target UX. Pi's TUI package is the preferred implementation reference.
- One working context maps to one Herdr named session.
- One Shepherd session maps to one Herdr workspace inside that named session.
- Herdr resource names should use a `shepherd-` prefix, but should not include platform prefixes such as `slack-` or `tui-`.
- Existing non-Shepherd Herdr resources should only be attached when the user explicitly asks.

## Relationship to existing plans

Archived plans that remain authoritative:

- `docs/plans/archived/2026-06-24-shepherd-herdr-orchestration.md`
- `docs/plans/archived/shepherd-herdr-orchestration/2026-06-24-session-event-stream-and-messaging.md`
- `docs/plans/archived/shepherd-herdr-orchestration/2026-06-24-herdr-control-plane.md`

This plan adds the missing TUI-specific user journey and implementation steps. It should not reopen the completed core MVP unless the TUI requires small RPC/store additions.

## User-facing behavior

### Default command

`shepherd` with no subcommand starts the full-screen TUI.

Expected flow:

1. Resolve local config, DB path, and socket path.
2. Connect to the daemon socket.
3. If connection fails because the daemon is not running, start the daemon in the background.
4. Connect again once the socket is ready.
5. Resolve or create a working context from `process.cwd()`.
6. Create a new Shepherd session bound to that working context.
7. Subscribe to the session event stream with `afterEventId = 0`.
8. Render replayed events and live updates.
9. Submit editor input as `session.user_message` with TUI actor presentation.

### Explicit session attach

`shepherd --session <id>` opens the TUI attached to an existing Shepherd session.

Behavior:

- Replay stored events for that session.
- Continue live subscription from the latest received event id.
- Do not create a new session.
- If the session has a working context binding, show it in the TUI header/footer.

### Resume flow

`shepherd -r` / `shepherd --resume` opens a session selector.

Behavior:

- List recent Shepherd sessions, ideally scoped first to the current working context.
- Allow filtering by title, working context label/path, platform binding, and recent message text if supported by the RPC.
- Selecting a session attaches the TUI to that session.
- New Slack messages, gateway messages, Herdr progress, and approval events appear after replay.

The first implementation can ship the selector after `--session` and default new-session flows, but the RPC should be designed so `/resume` can use the same API.

### Continue latest

`shepherd -c` / `shepherd --continue` attaches to the latest active session for the current working context. If none exists, it creates a new session.

Default `shepherd` should create a new session rather than silently continuing the latest session. This avoids mixing unrelated work. Continuation should be explicit.

### Existing commands

Keep existing subcommands:

- `shepherd daemon`
- `shepherd send`
- `shepherd watch`
- `shepherd rename`
- `shepherd audit`

The default command changes from help/error to TUI startup. `shepherd help` and `shepherd --help` still show CLI help.

## TUI surface

The MVP TUI should use `@earendil-works/pi-tui` unless implementation testing shows a blocker.

Initial layout:

- Header: Shepherd name, session title/id, working context, daemon status.
- Message stream: user messages, gateway messages, tool/progress summaries, approval events.
- Editor: multiline input using Pi TUI `Editor`.
- Footer/status: socket status, gateway running/queued state, last event id, key hints.

Initial key behavior:

- Enter submits.
- Shift+Enter / Alt+Enter inserts newline, following Pi TUI editor behavior.
- Ctrl+C clears editor first; double Ctrl+C or Ctrl+D exits TUI.
- Escape cancels local overlays/selectors. Gateway abort/interrupt can be deferred unless already supported by daemon RPC.

Initial commands inside the editor can be minimal:

- `/resume` opens the session selector when available.
- `/new` creates a new session for the current working context.
- `/rename <title>` renames the current session.
- `/quit` exits the TUI.

Slash commands can be implemented after the base editor and message stream are stable.

## Event rendering requirements

The TUI displays the Shepherd event stream, not direct provider-specific messages.

MVP rendering should cover:

- `user.message`
- `gateway.message`
- `gateway.run.started`
- `gateway.run.completed`
- `gateway.run.failed`
- `gateway.tool.call`
- `gateway.tool.result`
- `herdr.progress`
- `approval.requested`
- `approval.responded`
- `session.renamed`
- recovery/error events already emitted by the daemon

Rendering should be compact by default. Raw JSON should be available later through an inspect command or debug mode, not shown in the main stream.

## Cross-platform sync semantics

Shepherd DB remains the source of truth.

- TUI-originated messages are appended to the event stream first, then delivered to bound messaging platforms through existing delivery fanout.
- Slack-originated messages are appended to the same event stream first, then delivered to attached TUI clients through live subscription.
- The TUI keeps the latest seen event id in memory while running.
- On reconnect after daemon restart, the TUI subscribes with the latest seen event id and receives missed events.

A TUI session does not need a separate platform binding unless future features need durable local client identity. The session itself is enough for replay/live sync.

## Working context behavior

For default `shepherd` startup:

- `process.cwd()` is the working context path.
- The working context label defaults to the basename of the cwd.
- The working context slug should be generated using the existing Herdr-safe naming rules.
- A matching existing working context should be reused when the path is already known.
- A new working context should be inserted when the cwd is new and allowed.
- The new Shepherd session stores `working_context_id`.

Allowed-root policy needs a TUI-friendly rule. The gateway currently rejects working contexts when no allowed roots are configured. The TUI should not make `cd && shepherd` fail unexpectedly in a trusted local shell.

Proposed MVP rule:

- If `context.allowed_roots` is configured, cwd must be inside one of those roots.
- If `context.allowed_roots` is not configured, local TUI startup may create a working context for cwd because the user explicitly ran `shepherd` there.
- Gateway tools that scan arbitrary roots should still require explicit allowed roots.

This distinction preserves safe Slack-driven discovery while keeping local TUI startup ergonomic.

## Daemon autostart

The daemon remains the owner of long-running runtime state.

Autostart flow:

1. TUI command tries to connect to the configured socket.
2. If it fails with socket-not-found or connection-refused, spawn `shepherd daemon` as a detached background process with the same resolved config, DB path, and socket path.
3. Wait for the socket to become connectable with a bounded timeout.
4. If startup fails, show a concise error with the daemon log path.

The daemon must not be tied to the TUI process lifetime. Closing the TUI should leave Slack and Herdr subscriptions running.

The plan should avoid starting duplicate daemons. A stale socket should be handled by the daemon startup path or by connection retry logic.

## State locations

The current CLI defaults `dbPath` to `shepherd.sqlite` and `socketPath` to `/tmp/shepherd.sock`. That is workable for tests but weak for the default TUI experience.

TUI MVP should use a stable per-user Shepherd home directory:

```text
SHEPHERD_HOME=${SHEPHERD_HOME:-~/.shepherd}
```

Default managed paths:

```text
Config:  ~/.shepherd/config.yaml
Env:     ~/.shepherd/.env
DB:      ~/.shepherd/state.db
Socket:  ~/.shepherd/daemon.sock
Log:     ~/.shepherd/logs/daemon.log
```

Explicit overrides still win:

```text
SHEPHERD_CONFIG
SHEPHERD_DB_PATH
SHEPHERD_SOCKET_PATH
```

The first implementation should add a shared path resolver and move all commands toward these defaults so `daemon`, TUI, `send`, `watch`, `rename`, and `audit` agree by default.

## RPC/store additions

The current daemon RPC is enough to send and watch a known session. The TUI MVP needs these additional operations:

- `session.create`
  - input: title optional, working context path/label optional or required for default TUI startup
  - output: session record, working context record if created/resolved
- `session.list`
  - input: limit, workingContextId/path optional, status optional
  - output: recent sessions with title, working context, latest event id/time, optional preview
- `session.get`
  - input: sessionId
  - output: session record with working context
- `working_context.resolve_local`
  - input: path, label optional
  - output: working context record
  - applies the local-TUI cwd policy described above

These can be collapsed into fewer RPC methods if implementation stays simple, but the TUI should not read SQLite directly.

## Implementation order

1. Add tests and store methods for listing sessions and resolving cwd working contexts.
2. Add daemon RPC methods for session create/list/get and local working context resolution.
3. Extend `ShepherdSessionClient` with typed wrappers for those RPC methods.
4. Add `@earendil-works/pi-tui` dependency.
5. Implement a minimal TUI app that attaches to `--session <id>` and renders events.
6. Add editor submission via `sendUserMessage()`.
7. Add default `shepherd` command that creates a cwd-bound session and opens TUI.
8. Add daemon autostart.
9. Add `--resume` and `--continue` flows.
10. Add slash commands and polish.

## Verification

Required checks for implementation changes:

- Unit tests for CLI parsing.
- Integration tests for new daemon RPC methods.
- Integration tests for TUI client wrappers.
- Component-level tests for event formatting where possible.
- Manual TUI smoke test in a real terminal:
  - `shepherd` from a project directory
  - send a message
  - receive gateway response/events
  - close and reopen with `--session`
  - daemon remains running after TUI exit
- `pnpm check`.
- `pnpm build`, because CLI bin and runtime imports change.

## Open questions for dig

These are not blockers for writing the initial plan, but should be resolved before implementation starts:

1. Should default `shepherd` always create a new session, or should it create a new session only when the editor receives the first user message?
2. For TUI-created sessions, should Slack delivery happen only after the session is explicitly bound to a Slack target, or should Shepherd offer a way to select/create a Slack thread from TUI?
3. What is the minimum slash-command set for MVP?
4. Should the TUI show gateway/tool/Herdr progress as compact status lines, collapsible blocks, or full message cards?

## Child plans

- [TUI startup, daemon autostart, and session lifecycle](shepherd-tui-mvp-experience/2026-06-24-tui-startup-daemon-session.md)
- [TUI rendering, input, and event stream UX](shepherd-tui-mvp-experience/2026-06-24-tui-rendering-input-event-stream.md)
