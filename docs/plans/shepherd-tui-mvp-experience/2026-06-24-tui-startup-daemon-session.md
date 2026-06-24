# TUI Startup, Daemon Autostart, and Session Lifecycle

Date: 2026-06-24

Parent: [Shepherd TUI MVP Experience Plan](../2026-06-24-shepherd-tui-mvp-experience.md)

## Goal

Specify how the `shepherd` command opens a TUI, starts or connects to the daemon, creates or resumes sessions, and binds the current working directory as a working context.

## Current state

Implemented today:

- `shepherd daemon` starts the local daemon.
- `shepherd send --session <id> --text <text>` appends a TUI-originated message.
- `shepherd watch --session <id>` subscribes to a known session.
- `src/tui/client.ts` has a typed daemon socket client for send, subscribe, rename, approval, and logical tools.

Missing today:

- Full-screen TUI command.
- Default `shepherd` command behavior.
- Daemon autostart.
- Session creation/listing over daemon RPC.
- Local cwd to working-context creation from TUI startup.
- Resume/continue flows in the TUI.

## CLI command model

### Default

```bash
shepherd
```

Starts the TUI in the current working directory and creates a new Shepherd session bound to that directory.

### Explicit attach

```bash
shepherd --session <session-id>
shepherd tui --session <session-id>
```

Both forms are acceptable. `shepherd tui` can exist as an explicit alias, but the no-subcommand form should be the normal path.

### Resume

```bash
shepherd -r
shepherd --resume
shepherd tui --resume
```

Shows a session selector. It should prefer sessions for the current working context but allow expanding to all recent sessions.

### Continue

```bash
shepherd -c
shepherd --continue
shepherd tui --continue
```

Attaches to the latest active session for the current working context. If none exists, creates a new one.

### Existing subcommands

Existing subcommands should keep their current behavior. This keeps automation and tests stable.

```bash
shepherd daemon
shepherd send ...
shepherd watch ...
shepherd rename ...
shepherd audit ...
```

## CLI parsing changes

`parseCliArgs([])` should no longer return help. It should return a TUI command.

Proposed command union addition:

```ts
type CliCommand =
  | { command: "tui"; mode: "new"; cwd: string; socketPath: string; dbPath?: string; configPath?: string }
  | { command: "tui"; mode: "attach"; sessionId: string; socketPath: string; dbPath?: string; configPath?: string }
  | { command: "tui"; mode: "resume"; cwd: string; socketPath: string; dbPath?: string; configPath?: string }
  | { command: "tui"; mode: "continue"; cwd: string; socketPath: string; dbPath?: string; configPath?: string }
  | existing commands;
```

The exact type can differ, but the parsed intent should be explicit. Avoid overloading `send/watch` paths with TUI behavior.

## Daemon autostart

### Requirements

- The user should not need to run `shepherd daemon` manually before using the TUI.
- The daemon should outlive the TUI.
- Autostart should use the same config, DB path, and socket path that the TUI client uses.
- Duplicate daemon processes should be avoided.
- Startup failures should be visible in the TUI startup error, with a log path.

### Proposed flow

```text
run shepherd TUI command
  resolve runtime paths
  try ShepherdSessionClient.connect(socket)
  if connected:
    continue
  if connection failed with missing/refused socket:
    spawn detached shepherd daemon with resolved paths
    poll socket until connectable or timeout
  if still failed:
    print startup error and daemon log path
  open TUI
```

### Spawn command

The daemon should be spawned with the same executable entrypoint as the current CLI where possible.

Example shape:

```bash
shepherd daemon --socket <socket> --db <db> --config <config>
```

Implementation should avoid shell interpolation. Use `spawn(process.execPath, [entrypoint, "daemon", ...])` or equivalent argv-based process spawning.

### Logs

The background daemon cannot rely on the TUI stdout/stderr. It needs a log file.

Proposed log path:

```text
<state-or-cache-dir>/logs/daemon.log
```

Open question: exact state/cache directory convention.

### Stale socket behavior

If the socket path exists but no daemon responds:

- A connect attempt should fail quickly.
- Autostart may spawn a daemon.
- The daemon already unlinks an existing socket path in `start()`. That behavior can remain if the socket is stale.
- Avoid unlinking sockets from the TUI client unless daemon startup explicitly owns that cleanup.

## Runtime path defaults

Current defaults:

- socket: `/tmp/shepherd.sock`
- DB: `shepherd.sqlite` relative to cwd

These defaults are weak for `cd && shepherd` because each project directory would get a separate DB unless the user configures `SHEPHERD_DB_PATH`. A shared daemon also needs one stable DB by default.

### Reference behavior

Hermes, Pi, OpenCode, and Herdr use two broad patterns:

- Hermes uses a single app home. On Unix-like systems the default is `~/.hermes`; on native Windows it uses `%LOCALAPPDATA%\hermes`. Config, `.env`, auth, sessions, memories, skills, cron, and logs live under that root. `HERMES_HOME` overrides the root.
- Pi also uses a single app home: `~/.pi/agent`, overridable with `PI_CODING_AGENT_DIR`. Sessions live under `~/.pi/agent/sessions/` and are grouped by encoded cwd. `PI_CODING_AGENT_SESSION_DIR` can override session storage.
- OpenCode uses XDG-style separated roots through `xdg-basedir`: data, cache, config, state, and tmp. Its SQLite DB lives in the data root, config in the config root, locks in the state root, and logs under the data root.
- Herdr uses XDG-style config/state paths: `XDG_CONFIG_HOME/herdr` or `~/.config/herdr`, and `XDG_STATE_HOME/herdr` or `~/.local/state/herdr`. Its named sessions live under the config root at `sessions/<name>/`, with `herdr.sock` and `herdr-client.sock` inside each session directory. It also supports explicit socket env overrides.

Implications for Shepherd:

- A cwd-relative DB should not be the default for the TUI/daemon experience.
- Shepherd needs one per-user DB so Slack, TUI, and daemon restart recovery see the same event stream.
- Shepherd should expose one root override like `SHEPHERD_HOME` for Hermes/Pi-style simplicity.
- The default should be `~/.shepherd`, not split XDG directories. OpenCode and Herdr remain useful references for path separation and socket hygiene, but Shepherd should prioritize a single inspectable gateway home.
- Socket path should be stable per user and protected with owner-only permissions. For MVP it should live under the Shepherd home as `daemon.sock`.

### Decided target defaults

Use a single Shepherd home directory by default, following the Hermes/Pi style rather than splitting files across XDG data/config/state directories.

Default:

```text
SHEPHERD_HOME=${SHEPHERD_HOME:-~/.shepherd}
```

Managed paths:

```text
Config:  $SHEPHERD_HOME/config.yaml
Env:     $SHEPHERD_HOME/.env
DB:      $SHEPHERD_HOME/state.db
Socket:  $SHEPHERD_HOME/daemon.sock
Log:     $SHEPHERD_HOME/logs/daemon.log
```

Example layout:

```text
~/.shepherd/
├── config.yaml
├── .env
├── state.db
├── daemon.sock
└── logs/
    └── daemon.log
```

Rationale:

- Matches Shepherd's personal gateway/agent-home character better than fully separated XDG paths.
- Keeps config, DB, socket, logs, and future auth/session support easy to inspect, back up, and move.
- Avoids cwd-relative state while keeping the path model easy to explain.
- `state.db` and `daemon.sock` avoid the awkward repetition of `~/.shepherd/shepherd.sqlite` and `~/.shepherd/shepherd.sock`.
- `SHEPHERD_HOME` gives tests, sandboxes, and alternate installs one simple override.

Existing explicit overrides still win:

```text
SHEPHERD_CONFIG
SHEPHERD_DB_PATH
SHEPHERD_SOCKET_PATH
```

Security and lifecycle requirements:

- Create `$SHEPHERD_HOME` with owner-only permissions where the platform supports it.
- Create `.env`, `state.db`, and socket files with owner-only access where possible.
- Prepare `daemon.sock` by removing stale sockets and rejecting live sockets, following Herdr's socket behavior.
- Use one shared path resolver for all commands so `daemon`, TUI, `send`, `watch`, `rename`, and `audit` agree by default.

## Working context resolution

### TUI local rule

When the user runs `shepherd` from a shell, cwd is an explicit user choice. It should be accepted as a working context even if no `allowed_roots` are configured.

Rule:

- If `context.allowed_roots` is configured, cwd must be under one allowed root.
- If `context.allowed_roots` is absent, local TUI startup may register cwd directly.
- Slack/gateway-driven discovery still requires allowed roots for scanning.

This distinguishes explicit local intent from remote discovery.

### Store behavior

Needed store methods:

- `WorkingContextStore.findByPath(path)` or upsert-by-path logic.
- `EventStore.listSessions(...)` filtered by working context/status.
- Possibly `EventStore.createSession({ workingContextId })` already exists and can be reused.

Current `WorkingContextStore.upsert()` deduplicates by slug, not path. That can collide for two directories with the same basename. TUI startup should avoid accidentally reusing the wrong working context.

Proposed change:

- Add a unique or lookup path strategy before relying on slug.
- If slug collision occurs for a different path, derive a disambiguated slug.

This may require a DB migration if path uniqueness is enforced.

## Session creation policy

### Default new session

Default `shepherd` creates a new session for cwd.

Rationale:

- Matches a clean new conversation in Claude Code/Codex/Pi.
- Avoids mixing unrelated work into the latest session.
- Continuation remains available through `--continue`.

### Creation timing

Two possible behaviors:

- Create the session immediately on TUI startup.
- Create a draft TUI and persist the session only on first message.

Recommended for MVP: create immediately. It keeps daemon RPC and event subscription simpler. Empty sessions can be cleaned up later if they become noisy.

### Title

Initial title can be null or derived from cwd. Better title can be set later by `/rename` or gateway summarization.

Recommended MVP:

- session title: null
- TUI displays basename(cwd) until title exists

## Session list and resume

### `session.list` output

The selector needs more than raw session ids.

Proposed record:

```ts
type SessionListItem = {
  id: string;
  title: string | null;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
  workingContext?: {
    id: string;
    label: string;
    path: string;
    slug: string;
  };
  latestEventId: number;
  latestEventAt: string | null;
  preview: string | null;
  bindings: Array<{
    platform: string;
    spaceId: string;
    threadId: string;
  }>;
};
```

MVP can omit preview and bindings if expensive, but the RPC should leave room for them.

### Sorting

- Default sort: updated descending.
- In current cwd: list sessions for current working context first.
- Then show other recent sessions if the user chooses all sessions.

## Daemon RPC additions

### `working_context.resolve_local`

Input:

```ts
{
  path: string;
  label?: string;
}
```

Output:

```ts
{ workingContext: WireWorkingContextRecord }
```

Semantics:

- Applies local TUI allowed-root rule.
- Upserts or returns a working context for the path.

### `session.create`

Input:

```ts
{
  title?: string | null;
  workingContextId?: string;
}
```

Output:

```ts
{ session: WireSessionRecord }
```

Semantics:

- Creates an active session.
- Optionally emits `session.created` event if useful for subscribers. Not required for the new session's own stream.

### `session.list`

Input:

```ts
{
  limit?: number;
  status?: "active" | "archived";
  workingContextId?: string;
  workingContextPath?: string;
}
```

Output:

```ts
{ sessions: SessionListItem[] }
```

### `session.get`

Input:

```ts
{ sessionId: string }
```

Output:

```ts
{ session: WireSessionRecord; workingContext?: WireWorkingContextRecord }
```

## Tests

Add tests near existing daemon/client tests:

- `EventStore` lists sessions by updated time and working context.
- `WorkingContextStore` resolves by path without wrong slug reuse.
- Daemon RPC creates a session with working context.
- Daemon RPC lists recent sessions.
- `ShepherdSessionClient` wraps new RPC methods.
- CLI parser treats no args as TUI new session.
- CLI parser supports `--session`, `--resume`, and `--continue`.

Autostart can be tested at a thinner unit level by injecting a fake connector/spawner instead of launching a real detached daemon in unit tests.

## Open questions

1. Should changing DB/socket defaults happen before TUI ships, or should TUI require explicit `SHEPHERD_DB_PATH` during the first implementation?
2. Should empty auto-created sessions be pruned automatically?
3. Should `session.create` emit a session-level event or only create the DB row?
4. Should cwd registration bypass allowed roots only for interactive TUI, or also for `shepherd send` when run locally?
