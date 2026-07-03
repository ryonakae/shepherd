# Herdr Worker Observability Rewrite Plan

**Goal:** Rewrite Shepherd as a Herdr-centered worker observability and orchestration layer that produces structured worker snapshots, enriched worker events, and push notifications for orchestrator runtimes.

**Architecture:** Shepherd owns observed-workspace registry, worker identity mapping, runtime-neutral telemetry ingestion, transcript adapters, `WorkerStatePipeline`, notification delivery, and JSONL/CLI orchestration APIs. Herdr remains the low-level terminal/workspace/pane/agent control surface. Pi is the first runtime adapter; Hermes/OpenClaw can later implement the same telemetry/transcript contracts.

## Status

Not started.

## Progress

- Not started — Parent/child plan split is complete; implementation has not started.

## Next steps

- Start with [01-contracts-and-rpc.md](2026-07-02-herdr-worker-observability-rewrite/01-contracts-and-rpc.md).
- Do not edit legacy Gateway behavior before the replacement contracts and tests exist.

## Decisions Carried Forward

- Existing Gateway behavior can be discarded. No compatibility with old DB files, old session events, Slack delivery, `pi_turns`, logical tools, or queue behavior is required.
- Shepherd must not become a thin Herdr wrapper. Low-level Herdr pane/tab/workspace operations stay in Herdr CLI/socket/skill/plugin unless Shepherd adds worker-observability value.
- The core value is structured worker snapshots, enriched worker events, and push notifications to orchestrators.
- The MVP domain model is observed Herdr workspace + discovered workers. Do not introduce `task` as the core domain unit.
- Workers are auto-discovered from Herdr `agent.list` for the observed workspace. Manual worker promotion is not required in the MVP.
- Worker identity prefers `agent_session.source/agent/kind/value`; fallback identity is scoped to `herdrSessionName/socketPath + workspaceId + paneId`.
- Shepherd issues stable `observedWorkspaceId`; Herdr live ids are internal and may change. Use Herdr move/open/close/status events and `session.snapshot` re-resolution.
- Herdr daemon `events.subscribe` is the primary event stream. Herdr Plugin is a companion for observe action, dashboard pane, and install/config UX.
- Enriched public events are worker-level only in the MVP: `worker.completed`, `worker.blocked`, `worker.needs_input`, `worker.tool.failed`, `worker.summary.updated`, and `worker.status.changed`. Do not add workspace-level ready/initialized events.
- Snapshot inference uses facts plus deterministic light rules. Do not add a daemon-owned LLM summarizer.
- Push notifications default to non-invasive UI/status/widget + unread persisted event + next-turn hidden context. Optional `autoResume` uses extension-origin message injection.
- Notification delivery uses durable daemon cursors plus subscriber-local cursors; `notification.ack` finalizes delivery.
- Pi live telemetry uses bounded structured payloads with redacted excerpts, `sessionRef`, and `artifactRefs`. Do not store full tool results or hidden thinking.
- Persistence is append-only worker events plus current worker snapshots. MVP retention is simple/permanent for sanitized excerpts; future retention settings can add pruning.
- External MVP entrypoints are Pi extension and CLI JSON/JSONL. Delete `shepherd-tools`; do not preserve the old logical-tool bridge.
- Use TypeBox/Ajv for RPC schemas and Drizzle for SQLite schema. Write tests first for each implementation task.

## Child Plans

| Order | Child plan | Status | Scope |
|---:|---|---|---|
| 1 | [Contracts and RPC Schemas](2026-07-02-herdr-worker-observability-rewrite/01-contracts-and-rpc.md) | Done | Shared types, public RPC methods, TypeBox schemas |
| 2 | [Persistence Baseline](2026-07-02-herdr-worker-observability-rewrite/02-persistence.md) | Not started | DB schema, stores, migrations |
| 3 | [Herdr Observation and Resolution](2026-07-02-herdr-worker-observability-rewrite/03-herdr-observation.md) | Not started | Herdr socket API alignment, `session.snapshot`, workspace/worker re-resolution |
| 4 | [Runtime Telemetry Pipeline](2026-07-02-herdr-worker-observability-rewrite/04-runtime-telemetry-pipeline.md) | Not started | Runtime adapters, Pi transcript/telemetry, deterministic rules, `WorkerStatePipeline` |
| 5 | [Notifications, RPC, and CLI](2026-07-02-herdr-worker-observability-rewrite/05-notifications-rpc-cli.md) | Not started | Notification cursors, JSONL daemon RPC, observed-workspace CLI |
| 6 | [Pi Extension and Herdr Plugin](2026-07-02-herdr-worker-observability-rewrite/06-runtime-extensions.md) | Not started | Pi telemetry/notification bridge and Herdr companion plugin |
| 7 | [Cleanup, Documentation, and Validation](2026-07-02-herdr-worker-observability-rewrite/07-cleanup-docs-validation.md) | Not started | Legacy Gateway/session removal, README/package metadata, final validation |

## Implementation Order

1. Complete each child plan in table order.
2. Commit after each task inside a child plan, using the commit commands listed there.
3. Keep `pnpm test <focused-test-files>` passing before broad validation.
4. After all child plans are done, run final validation from child plan 7.

## Final Validation

Run after all child plans are complete:

```bash
pnpm check
pnpm build
```

Expected final result:

- TypeScript checks pass.
- Unit and integration tests pass.
- Biome lint and format checks pass.
- Drizzle check passes with the new observability baseline schema.
- Pi package check and Herdr plugin package check pass.
- Build succeeds and CLI entrypoints resolve aliases.

Manual smoke tests are defined in [07-cleanup-docs-validation.md](2026-07-02-herdr-worker-observability-rewrite/07-cleanup-docs-validation.md).

## Risk Summary

- Scope is large across DB, daemon, CLI, Pi extension, and Herdr plugin. The child plans keep the work reviewable.
- Heuristic events must carry confidence and evidence so orchestrators can decide whether to act.
- MVP stores sanitized excerpts indefinitely. Full tool results are not stored.
- Herdr Plugin remains companion-only because command-based hooks are not suitable as the primary high-frequency event stream.

## Plan Maintenance

- Keep this parent plan focused on goal, decisions, child-plan status, and cross-cutting validation.
- Put implementation steps, code snippets, and task-level test commands in child plans only.
- When child status changes, update both the child plan `Status`/`Progress` and the row in this parent plan.
