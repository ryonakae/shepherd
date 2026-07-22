# Herdr v0.7.5 Alignment Implementation Plan

> **For implementers:** Execute the child plans task-by-task. Complete each checkbox step, run the listed validation, and commit after each task.

**Status:** Planned

**Goal:** Align Shepherd with Herdr v0.7.5 by indexing Herdr live agent names, preserving Shepherd's structured-history and Pi notification roles, and deleting the unused Herdr control layer.

**Architecture:** Herdr remains the source of truth for live topology, agent kind, live agent name, and lifecycle state. Shepherd remains a daemon-backed, read-only history and notification layer: it stores `AgentInfo.name` as mutable metadata beside the existing agent kind, resolves names before kind fallbacks, enriches persisted events with the observed name, and shows both role name and runtime kind. Shepherd does not wrap Herdr start, prompt, wait, layout, or terminal-input APIs.

**Tech Stack:** TypeScript ESM with NodeNext, Node.js 24.18.0 or newer, pnpm 11.9.0, TypeBox/Ajv, Drizzle SQLite, Node `DatabaseSync`, Vitest, Biome, Herdr socket API, Pi extension API.

## Global Constraints

- Keep both Shepherd product capabilities:
  - daemon-backed `shepherd agent list/get/read` for structured agent history;
  - owner-only Pi context, agent outcomes, automatic wake, and ordered acknowledgement.
- Keep the Shepherd daemon mandatory for both CLI inspection and Pi notification flows. Do not add direct-read or daemon auto-start fallbacks.
- Keep Shepherd read-only. The official Herdr CLI and skill own workspace, tab, pane, start, prompt, send-keys, focus, and wait operations.
- Keep the public requirement at `Herdr >= 0.7.0`. Do not raise it to v0.7.2 or v0.7.5.
- Keep the `session.snapshot` compatibility fallback for Herdr versions that do not expose that method.
- Treat Herdr `AgentInfo.name` as nullable mutable metadata. It must not participate in Shepherd agent identity, history-ref invalidation, owner identity, or self-event filtering.
- Keep stable Shepherd identity based on the existing terminal-first matching rules. A live-name change must retain the same `agents.id`, session refs, context snapshot, and event ownership identity.
- Store agent kind and live name separately:
  - `agent` remains the Herdr runtime kind such as `codex` or `claude`;
  - `name` is the optional live alias such as `reviewer`.
- Resolve a target in this order within the selected scope:
  1. exact pane ID, terminal ID, or Shepherd agent ID;
  2. exact live agent name;
  3. exact agent kind only when no live-name match exists.
- Preserve existing ambiguity errors for multiple matches at the selected priority. Include both `name` and `agent` in candidate diagnostics.
- Snapshot an agent's live name into every newly created Shepherd status/outcome event payload. Historical event payloads without `name` remain valid.
- Display both fields when a live name exists:
  - CLI and Herdr plugin use separate `name` and `agent` columns/lines;
  - Pi uses `reviewer · Codex` and falls back to `Codex` when `name` is null.
- At the Pi provider/UI boundary, accept name and kind identity tokens only when they match Herdr's `[a-z][a-z0-9_-]{0,31}` grammar. Reject control-bearing or malformed names as unnamed metadata.
- Keep all previously decided notification semantics unchanged, including owner claim/release, ownerless periods, reconnect grace, pending transfer, acknowledgement order, wake timing, and self-event exclusion.
- Keep running-session-only queries, history readers, history cache, context snapshots, periodic refresh, pane-scoped status subscriptions, and the Shepherd Herdr plugin.
- Do not adopt `state_change_seq`; Herdr v0.7.5 status events do not carry it, and the existing status-event/idempotency pipeline remains authoritative for Shepherd.
- Do not add runtime dependencies or change package versions in this implementation. Release versioning remains a separate operation.
- Generate the additive Drizzle migration with `pnpm db:generate`. Do not edit migrations `0000` through `0003`.
- Follow TDD for behavior changes: write a focused failing test, confirm red, implement the smallest change, confirm green, then refactor.
- Public repository code, tests, docs, and commit messages remain in English.
- After implementation, run `pnpm check`, `pnpm build`, and `pnpm package:check`.

## Current Context

- `README.md` already delegates live Herdr control to the official Herdr skill and describes Shepherd as a structured-history reader, but its opening description underplays the Pi notification capability.
- `src/observability/contracts.ts` exposes `AgentIndexRecord.agent` but has no live-name field.
- `src/db/agents.ts` currently maps Herdr `agent` and ignores Herdr v0.7.5 `AgentInfo.name`.
- `AgentStore.resolveTarget()` currently treats `agent` as the name and searches pane ID, terminal ID, kind, and Shepherd ID in one candidate set.
- `AgentIndexService.sameIdentity()` correctly uses terminal identity, runtime kind, cwd, foreground cwd, and session ref. Live name must stay outside this function.
- `AgentIndexService.sameContextMetadata()` controls workspace-context publication and must include live name so rename observations reach the owner snapshot.
- Status event payloads currently contain `agent` but no `name`.
- `packages/shepherd-pi` carries a reduced wire type and formats agent kind in hidden context, wake evidence, and visible cards.
- `packages/shepherd-herdr-plugin/index.mjs` renders cached history excerpts that Herdr's v0.7.5 Agent view cannot display. Keep the plugin.
- Herdr v0.7.5 emits `pane.updated` for an explicit agent rename, but `PaneInfo` does not expose the live name. Existing periodic/session refresh remains the recovery path; this plan does not add a noisy pane-updated-to-full-snapshot loop.
- `src/herdr/managed-socket-client.ts`, `src/herdr/session-lifecycle.ts`, `src/herdr/session.ts`, `src/herdr/naming.ts`, and `src/herdr/client-pool.ts` have no production consumers.
- `HerdrSocketClient` production consumers use only `getPane`, `sessionSnapshot`, `subscribeEvents`, and `close`. Its operation wrappers are either unused or stale against v0.7.5.

## Child Plans

1. [Named agent contracts, persistence, targeting, and events](2026-07-22-herdr-v0-7-5-alignment/01-named-agent-core.md)
2. [Named agent CLI, plugin, Pi surfaces, and docs](2026-07-22-herdr-v0-7-5-alignment/02-named-agent-surfaces.md)
3. [Read-only Herdr client cleanup and final validation](2026-07-22-herdr-v0-7-5-alignment/03-read-only-client-cleanup.md)

## Requirement Coverage

| Decision | Implementation | Proof |
| --- | --- | --- |
| Preserve structured pull and Pi push | Child 01 keeps the daemon index/event model; Child 02 updates both surfaces | RPC, CLI, Pi extension, wake, and UI tests |
| Keep daemon mandatory | No direct CLI path or auto-start behavior added | Existing daemon-required CLI tests remain green |
| Keep Shepherd read-only | Child 03 removes the unused control and managed-session layers | Repository search and focused Herdr client tests |
| Keep `Herdr >= 0.7.0` | Child 03 retains `session.snapshot` fallback; Child 02 leaves requirements unchanged | fallback integration test and docs review |
| Add nullable live name beside kind | Child 01 Tasks 1-2 | migration, store, and contract tests |
| Preserve terminal identity across rename | Child 01 Tasks 1 and 3 | stable-ID, history-call-count, and context-publication tests |
| Target priority: IDs, name, kind | Child 01 Task 2 | exact collision and ambiguity tests |
| Event-time name snapshot | Child 01 Task 3 | status/outcome event payload tests |
| Show both name and kind | Child 02 Tasks 1-2 | CLI, plugin, hidden-context, wake, and card tests |
| Preserve notification behavior | Child 02 Task 2 and full regression suite | existing orchestrator/Pi tests plus focused named tests |
| Keep Herdr plugin | Child 02 Task 1 | plugin package/render tests |
| Remove dead operation layer | Child 03 Task 1 | deleted-file list, import search, typecheck, and remaining socket tests |

## Ordering

1. Complete child 01 so every later surface consumes the final `AgentIndexRecord.name` and event payload.
2. Complete child 02 so CLI, plugin, Pi wire types, hidden context, wake projection, and visible cards agree on one display rule.
3. Complete child 03 after the feature paths pass, then remove dead Herdr control code and run full package validation.

## Progress

- [ ] Child 01: named agent core
- [ ] Child 02: named agent surfaces
- [ ] Child 03: read-only client cleanup and final validation

## Validation

- `pnpm test test/integration/agent-store-terminal-identity.test.ts test/integration/agent-index-service.test.ts test/integration/observability-rpc.test.ts test/integration/sqlite-migrations.test.ts` — live-name persistence, identity, target priority, event enrichment, RPC output, and migration pass.
- `pnpm test test/unit/cli.test.ts test/unit/herdr-plugin-package.test.ts test/unit/shepherd-pi-wake.test.ts test/unit/shepherd-pi-agent-update-ui.test.ts test/unit/shepherd-pi-extension.test.ts` — all human/Pi display surfaces show the decided identity format without changing notification semantics.
- `pnpm test test/integration/herdr-socket-client.test.ts test/integration/herdr-pane-identity-resolver.test.ts test/unit/herdr-session-watch-manager.test.ts` — the reduced socket client still supports snapshots, fallback, pane identity, and event subscriptions.
- `pnpm db:check` — Drizzle schema, migration `0004`, and metadata agree.
- `pnpm check` — typecheck, all Vitest tests, Biome, Drizzle, package checks, Pi package checks, and Herdr plugin checks pass.
- `pnpm build` — root CLI/daemon build and import alias resolution pass after file deletion.
- `pnpm package:check` — the root tarball includes only the intended runtime files and contains no stale imports.
- `git diff --check` — no whitespace errors.
- `git status --short` — only planned source, test, migration, docs, and deleted dead-layer files appear before commits; the final worktree is clean after commits.

## Risks, Tradeoffs, and Open Questions

- Older Herdr versions omit `name`; nullable mapping and kind fallback preserve compatibility.
- Herdr agent names are ephemeral. Persisting the observed name in event payloads preserves historical meaning while the current agent row follows the latest snapshot.
- Manual `agent rename` can take up to the existing refresh interval to appear in Shepherd because Herdr's `pane.updated` event omits the name. This plan accepts the existing eventual-consistency window instead of introducing full-snapshot refreshes on generic pane updates.
- Human CLI table output gains a column. JSON output changes additively.
- Removing internal files can expose hidden test/import dependencies. Child 03 requires repository-wide import searches and a clean build before completion.
- No unresolved product decisions remain.
