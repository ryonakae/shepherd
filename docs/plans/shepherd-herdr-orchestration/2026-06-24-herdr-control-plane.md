# Shepherd Herdr Control-Plane Mapping

Date: 2026-06-24

Parent: [Shepherd Herdr Orchestration Plan](../2026-06-24-shepherd-herdr-orchestration.md)

## Goal

Define how Shepherd maps its sessions and working contexts onto Herdr sessions, workspaces, tabs, panes, and agents.

## Implementation status

Status as of commit `f8d2766`: MVP control-plane implementation is complete, with the limits noted below.

Implemented:

- Herdr named-session validation and CLI lifecycle through `herdr --session <name>`.
- reusable Herdr socket client and managed client pool.
- workspace create/list/get/focus, tab create/list/get, pane split/list/get/read/run/send-text, agent start/list/get/read/send/focus, and wait wrappers.
- Shepherd workspace layout creation with `agents`, `tests`, `logs`, `review`, and `scratch` tabs.
- Herdr DB bindings for created and explicitly attached workspaces.
- gateway logical tools for `herdr_read`, `ensure_herdr_workspace`, `attach_herdr_workspace`, `open_pane`, `run_pane_command`, `send_pane_text`, `read_pane`, `start_agent`, `send_agent_message`, `read_agent_output`, and waits.

MVP limits:

- Herdr event subscription is not a dedicated streaming adapter yet; MVP uses `agent.wait` and `wait.output` plus Shepherd event records.
- `send_agent_message` uses Herdr `agent.send`, not the older draft's internal `pane.send_input` example.
- Explicit attach is included in MVP only when the user asks for it; broad attach/discovery modes remain out of scope.

## Herdr facts used

From Herdr documentation and source:

- Herdr is a terminal workspace manager. Panes are real terminals.
- A Herdr agent is a process Herdr recognizes inside a pane.
- `agent.start` starts a process that should be treated as an agent target.
- `pane` APIs should be used for normal terminals, servers, tests, logs, and low-level input.
- Herdr named sessions are persistent server namespaces.
- Herdr session names must be at most 64 bytes and contain ASCII letters/numbers plus `.`, `_`, `-`.
- Herdr APIs can create/list/focus/rename/close workspaces and tabs; split/read/send/close panes; start/read/send/focus agents; subscribe to events.

## Named session lifecycle

Shepherd uses Herdr's named-session CLI lifecycle to ensure or create the named session for a working context. After the session exists, Shepherd uses the Herdr socket API for normal control-plane operations.

- Do not start or supervise `herdr server` directly in MVP.
- Do not use one-off CLI wrappers for every operation when a socket API is available.
- Resolve the socket for the target Herdr named session, then keep a reusable socket client for workspace, tab, pane, agent, and event operations.

## Mapping

```text
working context
  -> Herdr named session: shepherd-<working-context-slug>

Shepherd session
  -> Herdr workspace: shepherd-<task-slug>-<short-id>

Herdr tabs
  -> agents / tests / logs / review / scratch

Herdr panes
  -> actual terminals, coding agents, test runners, dev servers
```

Rationale:

- One working context gets one Herdr named session.
- Multiple Shepherd sessions for the same working context become separate Herdr workspaces inside that named session.
- Workspace names describe work, not the platform where the conversation began.
- The `shepherd-` prefix helps humans distinguish Shepherd-managed Herdr resources when using Herdr directly.

## Naming

```text
Herdr named session: shepherd-<working-context-slug>
Herdr workspace:     shepherd-<task-slug>-<short-id>
```

Rules:

- Do not include platform prefixes such as `slack-` or `tui-`.
- Append a short id to avoid collision.
- Allow later rename/title updates.
- Validate against Herdr session-name constraints before creating named sessions.

## Working context discovery

Do not assume Git.

Signals may include:

- configured catalog entries
- path name
- recent Shepherd bindings
- Herdr existing sessions/workspaces
- `.git`
- `package.json`
- `pyproject.toml`
- `Cargo.toml`
- `go.mod`
- `README*`
- `AGENTS.md`, `CLAUDE.md`, `HERMES.md`, `.hermes.md`
- `.shepherd.toml` if introduced later

Resolution order:

1. explicit configured catalog
2. previous Shepherd DB bindings and recent working contexts
3. allowed roots scan
4. user clarification when ambiguous

Allowed root scanning is opt-in. Shepherd must not scan the whole home directory by default.

## Agent and pane operations

Use Herdr APIs at the right level:

- `agent.start` for configured worker agents.
- `send_agent_message` as a Shepherd-level tool that sends through Herdr `agent.send`.
- `pane.split`, `pane.run`, `pane.read`, and related pane APIs for tests, servers, logs, and shells.
- `agent.read` / `pane.read` for result summarization.
- `events.subscribe` / waits for Herdr state changes.

## Autonomy boundary

Inside Shepherd-managed Herdr resources, the gateway LLM may create workspaces, tabs, panes, and agents, send input, wait, read output, and summarize results.

Expose that capability through high-level Shepherd logical tools, not raw Herdr socket methods. The logical tools should cover workspace setup, agent pane preparation, agent start, pane creation, controlled pane commands, reads, waits, and agent messaging while Shepherd enforces DB bindings and policy.

For non-Shepherd Herdr resources:

- Do not attach unless the user explicitly asks.
- Once attached, record the binding in Shepherd DB.
- Do not add broad discovery/auto-attach modes in MVP.
- The prompt must remind the gateway LLM that non-Shepherd resources are user-owned.

## DB bindings

`herdr_bindings` records the relation between Shepherd and Herdr:

- Shepherd session id
- Herdr named session name
- Herdr workspace id
- created vs attached metadata
- timestamps and last-seen state

Shepherd DB remains the source of truth for bindings.
