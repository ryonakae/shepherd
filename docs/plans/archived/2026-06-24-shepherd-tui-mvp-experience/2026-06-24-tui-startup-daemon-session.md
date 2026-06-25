# TUI Startup, Daemon Autostart, and Session Lifecycle

Date: 2026-06-24

Parent: [Shepherd TUI MVP Experience Plan](../2026-06-24-shepherd-tui-mvp-experience.md)

## Status

Archived. Superseded. Use [Shepherd Pi Runtime Gateway Plan](../../2026-06-25-pi-runtime-gateway.md) for active implementation.

## Progress

- **Done** — Historical startup, daemon autostart, and local session lifecycle requirements were captured.
- **Superseded** — Custom Shepherd TUI startup should be replaced by Pi runtime and `shepherd open` behavior.

## Next steps

- Reuse relevant daemon path, session, and working-context requirements as reference for Pi runtime gateway implementation.

## Goal

Specify how the `shepherd` command opens a TUI, starts or connects to the daemon, creates or resumes sessions, and binds the current working directory as a working context.

## Current state

Implemented today:

- `shepherd daemon` starts the local daemon.
- `shepherd send --session <id> --text <text>` appends a TUI-originated message.
- `shepherd watch --session <id>` subscribes to a known session.
- `src/tui/client.ts` has a typed daemon socket client for creating sessions, send, subscribe, rename, approval, and logical tools.

Missing today:

- Full-screen TUI command.
- Default `shepherd` command behavior.
- Daemon autostart.
- Session listing over daemon RPC.
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

## Slack auto-bind for TUI-created sessions

### Config

Slack config adds one optional field:

```yaml
platforms:
  slack:
    app_token_env: SLACK_APP_TOKEN
    bot_token_env: SLACK_BOT_TOKEN
    allowed_users:
      - U1234567890
    allowed_channels:
      - C1234567890
    tui_default_channel: C1234567890
```

Rules:

- `allowed_users` is required whenever `platforms.slack` is configured. This follows the Hermes-style rule that messaging users who can drive the agent must be explicitly allowed.
- `tui_default_channel` is optional. If absent, default TUI-created sessions remain TUI-only unless explicitly bound by a future command.
- `tui_default_channel` is a Slack channel ID only, for example `C1234567890`. Do not resolve `#channel-name` in the MVP.
- If `allowed_channels` is configured, `tui_default_channel` must be included in it. Treat mismatch as config validation failure.
- If `allowed_teams` has exactly one entry, store it as Slack binding metadata `{ teamId }` for TUI-created bindings. If it has zero or multiple entries, omit `teamId` metadata.

### Eligibility

Only newly created sessions from default TUI startup are eligible for automatic Slack binding:

- `shepherd` with no subcommand: eligible if `tui_default_channel` is configured.
- `shepherd --continue`: eligible only when it does not find an existing session and creates a new one.
- `shepherd --session <id>` and `--resume`: not eligible unless the selected session already has a Slack binding.
- Existing TUI-only sessions should not become Slack-published just because they are later attached.

Persist eligibility in session metadata so daemon restarts and reconnects do not change behavior. Add a session metadata field, for example:

```ts
type SessionMetadata = {
  slackAutoBind?: {
    attemptedAt?: string;
    bindingId?: string;
    channelId: string;
    failureReason?: string;
    status: "pending" | "bound" | "failed";
  };
};
```

Only `status: "pending"` is processed automatically. Success changes it to `bound`; failure changes it to `failed`. A failed session is not retried automatically.

This requires a `sessions.metadata_json` migration or an equivalent session-state table. Prefer `sessions.metadata_json` for MVP so the session record carries the decision.

### First user message flow

When an eligible session receives its first TUI user message:

1. Store the `user.message` event with a TUI-provided idempotency key.
2. Before publishing the event or waking the gateway, post that same message text to Slack `tui_default_channel` as a parent message.
3. If Slack returns `ts`, create a Slack binding with:
   - `platform = "slack"`
   - `spaceId = tui_default_channel`
   - `threadId = returned ts`
   - `messageId = returned ts`
   - optional metadata `{ teamId }` when unambiguous from `allowed_teams`
4. Mark the delivery receipt for the stored event as sent using target id `<channelId>:<returnedTs>`. This matches normal fanout target ids and prevents duplicate thread replies for the parent event.
5. Mark session metadata `slackAutoBind.status = "bound"` and store `bindingId` / `attemptedAt`.
6. Send the RPC response, publish the user event to TUI subscribers, then wake the gateway.

The Slack parent message body is exactly the user message text. Do not append working context path, session id, or a TUI footer by default.

Display customization follows the existing Slack delivery rule: use TUI actor `presentation.displayName` / `avatarUrl` only when `allow_customize` is true. Otherwise post as the Slack bot.

The first message may wait for Slack parent post success/failure before the RPC response. The TUI should show a sending/binding status instead of clearing the editor optimistically.

### Failure behavior

If Slack parent posting fails:

- Keep the `user.message` event and continue the TUI/gateway flow.
- Do not create a Slack binding.
- Mark session metadata `slackAutoBind.status = "failed"`, with `attemptedAt` and `failureReason`.
- Append a persistent `platform.binding_failed` event for TUI/audit visibility.
- Do not include `platform.binding_failed` in gateway context.
- Do not retry automatic binding for that session on later user messages.

A future `/retry-bind slack` command can explicitly reset or retry failed binding, but it is out of MVP scope.

### Idempotency and ordering

- TUI user messages should include idempotency keys. This is required for retry-safe first-message binding.
- If a repeated idempotency key returns an existing event, daemon logic must not post another Slack parent for the same event.
- The user event, Slack parent post, binding creation, delivery receipt, metadata update, and optional failure event must be ordered so subscribers and gateway see a consistent stream.
- Do not wrap the external Slack API call in a long DB transaction. Use persisted metadata, binding records, and delivery receipts to make retry behavior safe.

### Inbound behavior for auto-created threads

After automatic binding succeeds, the Slack thread is a normal bidirectional Shepherd surface:

- Human replies in the thread are accepted only if they pass `allowed_users`, `allowed_channels`, and `allowed_teams`.
- Accepted replies append `user.message` events to the same Shepherd session.
- Accepted replies wake the gateway just like other Slack-originated user messages.
- Bot messages and Shepherd's own Slack posts remain ignored by the existing Slack inbound filters.

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
  slackAutoBind?: {
    channelId: string;
  };
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
- If `slackAutoBind` is present, stores session metadata with `slackAutoBind.status = "pending"` and the target channel id.
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

- Config schema requires Slack `allowed_users` and validates `tui_default_channel` against `allowed_channels` when both are configured.
- `EventStore` creates sessions with metadata and updates Slack auto-bind state.
- `EventStore` lists sessions by updated time and working context.
- `WorkingContextStore` resolves by path without wrong slug reuse.
- Daemon RPC creates a session with working context and optional Slack auto-bind metadata.
- Daemon RPC lists recent sessions.
- First TUI user message for an eligible session posts a Slack parent, creates a binding, and records a sent receipt with target `<channelId>:<ts>`.
- Slack parent post failure records `platform.binding_failed`, marks metadata failed, and still runs the TUI/gateway flow.
- Repeated idempotency keys do not create duplicate Slack parents.
- Slack replies in auto-created threads pass allowlists, append to the same session, and wake the gateway.
- `ShepherdSessionClient` wraps new RPC methods.
- CLI parser treats no args as TUI new session.
- CLI parser supports `--session`, `--resume`, and `--continue`.

Autostart can be tested at a thinner unit level by injecting a fake connector/spawner instead of launching a real detached daemon in unit tests.

## Open questions

1. Should empty auto-created sessions be pruned automatically?
2. Should `session.create` emit a session-level event or only create the DB row?
3. Should cwd registration bypass allowed roots only for interactive TUI, or also for `shepherd send` when run locally?
4. What should the exact `platform.binding_failed` payload shape be?
