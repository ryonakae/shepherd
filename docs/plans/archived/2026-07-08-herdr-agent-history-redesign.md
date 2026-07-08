# Herdr Agent History Redesign Implementation Plan

> **For implementers:** Execute the child plans task-by-task. Complete each checkbox step, run the listed validation, and commit after each task. This parent plan is the source of scope, terminology, and ordering.

**Status:** Completed

**Goal:** Rebuild Shepherd around Herdr agents and agent history so `shepherd agent list/get/read` returns compact, accurate context for running Herdr workspaces, while the daemon keeps push notifications, unread cursors, and cache/index data.

**Architecture:** Shepherd remains a TypeScript daemon + CLI, but Herdr and agent history files are the source of truth. The daemon periodically discovers all running Herdr sessions with `herdr session list --json`, indexes every workspace/agent in those running sessions, subscribes to Herdr agent status events, and stores agent events plus compact history cache in SQLite. CLI and Pi extension talk to the daemon; no user-installed adapter/config is required beyond the Shepherd packages.

**Tech Stack:** TypeScript ESM + NodeNext, Node.js >=24.18.0, pnpm 11.9.0, SQLite via `node:sqlite`, Drizzle schema/migrations, TypeBox/Ajv RPC schemas, Vitest, Biome, Herdr socket API, Pi extension API.

## Global Constraints

- Chat responses are Japanese; public repository code/docs should use English unless an existing local file uses Japanese.
- Use Herdr official vocabulary externally: `agent`, `agent_session`, `agent history`.
- Do not expose `worker`, `run`, standalone `session`, `context`, or `snapshot` in user-facing CLI/API/docs after this rewrite. Plan files may mention old names only to describe deletion/migration.
- Remove old external commands: `shepherd context`, `shepherd snapshot`, `shepherd events`, `shepherd notifications`, `shepherd ack`, `shepherd message-worker`, `shepherd wait-worker`.
- Add external commands: `shepherd agent list`, `shepherd agent get <target>`, `shepherd agent read <target>`.
- CLI defaults to the current Herdr workspace when `HERDR_ENV=1`; `agent list` supports `--all`, `--workspace <id>`, and `--session <name>`.
- CLI requires the Shepherd daemon. If the daemon socket is unavailable, return an error that tells the user to run `shepherd daemon start`. Do not auto-start.
- Shepherd daemon watches only Herdr sessions whose `herdr session list --json` entry has `running: true`. Stopped sessions are out of scope for this rewrite.
- Daemon rescans `herdr session list --json` every 60 seconds to add newly running sessions and unwatch stopped sessions.
- Within each running Herdr session, daemon watches all workspaces and agents.
- Push notifications are triggered primarily by Herdr agent status changes. On a status change, daemon rereads that agent's history, builds compact history, stores an agent event, and pushes the event to connected subscribers.
- Pull output and push hidden context use the same compact history contract.
- `shepherd agent list` returns agent metadata plus one-line compact history: `agent`, `paneId`, `status`, `updatedAt`, `lastUserMessage`, `lastAssistantMessage`.
- `shepherd agent get <target>` returns one agent's metadata plus compact history and `lastToolResult`.
- `shepherd agent read <target> --limit N` returns recent structured messages including compact `tool_result` items.
- Tool results are compacted RTK-style: use tool/content-aware reduction modes and explicit fallback markers, not raw full tool output by default.
- DB remains, but it is not the source of truth for agent history. DB is an index/cache/push/cursor layer. Source of truth is Herdr live state and agent history files.
- DB/API/code names should be changed to `agent_*` / Herdr names. Existing `worker_*` names should be removed outside archived plans.
- Pi hidden context is current workspace only. It should include current workspace compact agent history and unread agent events for that workspace.
- Implementation changes must follow TDD. After implementation changes, run `pnpm check`; run `pnpm build` for CLI entrypoint/package changes; run `pnpm db:generate` when DB schema changes.
- User accepted deleting existing Shepherd config/DB and rebuilding from zero. Do not preserve compatibility with old SQLite tables or old external RPC names.

## Current Context

- Herdr v0.7.2 supports `session.snapshot`.
- `HerdrSocketClient.sessionSnapshot()` already prefers `session.snapshot` and falls back to list APIs.
- `herdr session list --json` returns running session entries with `name`, `running`, `session_dir`, and `socket_path`.
- Running Herdr session means the API socket exists and can be connected; stopped Herdr session has saved `session.json` but no socket API.
- Herdr `agent list` / `pane list` return agent metadata including `agent`, `agent_status`, `pane_id`, `terminal_id`, `workspace_id`, `tab_id`, `cwd`, `foreground_cwd`, and sometimes `agent_session`.
- Herdr target syntax accepts terminal ids, unique agent names, detected/reported agent labels, and legacy pane ids. Shepherd should resolve targets within the selected workspace unless `--all` is used.
- Existing code still uses `worker`, `context`, `snapshot`, `notification` names in `src/observability`, `src/db`, CLI, Pi extension, Herdr plugin, tests, and docs.
- Existing DB tables are `observed_workspaces`, `workers`, `worker_events`, `worker_snapshots`, `notification_subscriptions`, and `notification_cursors`; these can be replaced.
- Existing Pi transcript adapter only extracts last assistant/tool hints; it must become an agent history reader that returns user/assistant/tool_result messages.
- Pi history files were observed under `~/.pi/agent/sessions/.../*.jsonl`.
- Claude history files were observed under `~/.claude/projects/.../*.jsonl`.
- Existing modified files before this plan: `src/herdr/socket-client.ts`, `test/integration/herdr-socket-client.test.ts`, `test/integration/managed-herdr-socket-client.test.ts`.

## Child Plans

1. [Contracts, DB schema, and migrations](2026-07-08-herdr-agent-history-redesign/01-contracts-db.md)
2. [Agent history discovery, readers, and compaction](2026-07-08-herdr-agent-history-redesign/02-history-readers-compaction.md)
3. [Daemon session discovery, indexing, watch loop, and agent events](2026-07-08-herdr-agent-history-redesign/03-daemon-watch-index.md)
4. [RPC and CLI: `shepherd agent list/get/read`](2026-07-08-herdr-agent-history-redesign/04-rpc-cli.md)
5. [Pi extension, Herdr plugin, docs, cleanup, and dogfooding](2026-07-08-herdr-agent-history-redesign/05-pi-plugin-docs-validation.md)

## Progress

- [x] Design decisions captured from `/dig` session.
- [x] Child plan 01 implemented and verified.
- [x] Child plan 02 implemented and verified.
- [x] Child plan 03 implemented and verified.
- [x] Child plan 04 implemented and verified.
- [x] Child plan 05 implemented and verified.

## Completion notes

Implemented through child plans 01-05, committed and pushed in multiple slices. Final validation passed with `pnpm check` and `pnpm build`. Dogfood with `SHEPHERD_HOME=/tmp/shepherd-agent-history-dogfood` verified `agent list/get/read` for workspace `wB` and daemon-required CLI behavior.

## Validation

- `pnpm check` — all typecheck, tests, Biome, Drizzle, Pi package, and Herdr plugin checks pass.
- `pnpm build` — CLI package entrypoint and import aliases resolve after build.
- `herdr session list --json` — running sessions are discoverable in the local Herdr environment.
- In Herdr workspace `wB`, `shepherd agent list --json` returns the Pi pane `wB:p1` and Claude pane `wB:p2` with compact history.
- In Herdr workspace `wB`, `shepherd agent get claude --json` resolves within the current workspace.
- In Herdr workspace `wB`, `shepherd agent read claude --limit 10 --json` returns recent user/assistant/tool_result messages without raw full tool output.

## Risks, Tradeoffs, and Open Questions

- Herdr event subscriptions for `pane.agent_status_changed` are pane-specific in the current wrapper. Child plan 03 must resubscribe when pane sets change.
- Built-in history discovery for Claude and Pi may need robust fallback scanning because path slug formats are implementation details of those agents.
- DB reset is accepted, but generated migrations must be kept consistent with Drizzle metadata.
- Push status changes can miss history-only updates if an agent writes more messages without a Herdr status transition. This is accepted for the first implementation; CLI read/get still pull from latest history/cache.
- Stopped Herdr sessions are out of scope. Do not add archived history commands in this rewrite.
