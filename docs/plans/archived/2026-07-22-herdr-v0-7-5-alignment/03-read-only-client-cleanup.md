# Read-Only Herdr Client Cleanup and Final Validation Plan

> **For implementers:** Execute this plan task-by-task. Complete each checkbox step, run the listed validation, and commit after each task.

**Status:** Completed

**Goal:** Delete Shepherd's unused Herdr control and named-session management code, reduce `HerdrSocketClient` to observability operations, and validate the complete v0.7.5 alignment.

**Architecture:** The daemon discovers running sessions through `herdr session list --json`; it never starts or owns Herdr sessions. One small socket client supports live `pane.get`, `session.snapshot` with the existing list fallback, and pane-scoped event subscriptions. The official Herdr CLI/skill owns every mutation and lifecycle wait. Removing internal wrappers does not change the root package's documented CLI or package export contract.

**Tech Stack:** TypeScript, Node sockets/child processes, Vitest, pnpm package checks.

## Global Constraints

- Inherit every constraint from the parent plan.
- Delete code that exists only for Shepherd-managed Herdr startup or control. Do not update stale methods to v0.7.5.
- Keep `HerdrSocketClient.close()`, `getPane()`, `sessionSnapshot()`, and `subscribeEvents()` as the production-facing methods.
- Keep the `session.snapshot` unknown-variant fallback to `workspace.list`, `pane.list`, `tab.list`, and `agent.list` through private requests.
- Keep event envelope normalization for Herdr's `event/data`, `method/params`, and subscription response shapes.
- Keep `src/herdr/session-list.ts`, `src/herdr/session-snapshot.ts`, and `src/herdr/pane-identity-resolver.ts`.
- Keep pane-scoped `pane.agent_status_changed` subscriptions and existing watch-manager restart behavior.
- Do not alter daemon lifecycle, process-manager CLI, `HerdrSessionWatchManager` timing, or error swallowing in this cleanup.
- File deletion is a pure refactor. Prove retained behavior before and after; do not create artificial failing tests for deleted private APIs.
- The root package has no `exports` map and documents no deep Herdr client imports. Do not add compatibility re-exports or empty modules for removed internals.

## Current Context

- Production references outside `src/herdr/socket-client.ts` use:
  - `AgentIndexService`: `sessionSnapshot()`;
  - `HerdrSessionWatchManager`: `subscribeEvents()` and `close()`;
  - `HerdrPaneIdentityResolver`: `getPane()`.
- `src/herdr/managed-socket-client.ts` is referenced only by `test/integration/managed-herdr-socket-client.test.ts`.
- `src/herdr/session-lifecycle.ts` is referenced only by the managed client and `test/unit/herdr-session-lifecycle.test.ts`.
- `src/herdr/session.ts` and `src/herdr/naming.ts` support the dead session lifecycle and their own tests only.
- `src/herdr/client-pool.ts` has no production consumer and is covered only by `test/unit/herdr-client-pool.test.ts`.
- `HerdrSocketClient` still exposes workspace/tab creation, focus, pane mutation/input/read, agent read/list/get/focus/start/send/wait, output wait, and generic event wait methods.
- `sendAgentMessage()` calls removed Herdr `agent.send`; `startAgent()` and `waitForAgent()` use pre-v0.7.5 parameter shapes.
- `test/integration/herdr-socket-client.test.ts` mixes required observability behavior with tests for the dead operation methods.

## File Structure

- Delete: `src/herdr/managed-socket-client.ts`
- Delete: `src/herdr/session-lifecycle.ts`
- Delete: `src/herdr/session.ts`
- Delete: `src/herdr/naming.ts`
- Delete: `src/herdr/client-pool.ts`
- Delete: `test/integration/managed-herdr-socket-client.test.ts`
- Delete: `test/unit/herdr-session-lifecycle.test.ts`
- Delete: `test/unit/herdr-session.test.ts`
- Delete: `test/unit/herdr-naming.test.ts`
- Delete: `test/unit/herdr-client-pool.test.ts`
- Modify: `src/herdr/socket-client.ts` — retain only observability methods and private protocol helpers.
- Modify: `test/integration/herdr-socket-client.test.ts` — remove control tests and preserve snapshot/fallback/event/pane-get coverage.
- Verify: `src/herdr/pane-identity-resolver.ts` and `test/integration/herdr-pane-identity-resolver.test.ts` — no behavior change.
- Verify: `src/daemon/herdr-session-watch-manager.ts` and `test/unit/herdr-session-watch-manager.test.ts` — no behavior change.
- Modify: parent and child plan status/progress after every implementation child completes.

## Interfaces

The retained public class surface is:

```ts
export class HerdrSocketClient {
  constructor(options: HerdrSocketClientOptions);
  close(): void;
  getPane(params: { pane_id: string }): Promise<unknown>;
  sessionSnapshot(): Promise<unknown>;
  subscribeEvents(
    params?: { paneIds?: string[] },
    options?: { signal?: AbortSignal },
  ): AsyncIterable<unknown>;
}
```

Inside `HerdrSocketClient`, rename the generic persistent-socket request method to a private method:

```ts
#request(method: string, params: unknown = {}): Promise<unknown>;
```

Use it only from `getPane()` and `subscribeEvents()`. Keep `#requestOnce()` for snapshot/fallback calls.

## Tasks

### Task 1: Lock the Required Socket Behavior

**Objective:** Establish a passing baseline for the only Herdr socket behaviors Shepherd will retain.

**Files:**
- Modify: `test/integration/herdr-socket-client.test.ts`
- Verify: `test/integration/herdr-pane-identity-resolver.test.ts`
- Verify: `test/unit/herdr-session-watch-manager.test.ts`

**Interfaces:**
- Produces: focused coverage for `getPane`, snapshot, fallback, event normalization, stream close, and watch-manager consumers.
- Removes from the test contract: every control/mutation wrapper.

- [x] **Step 1: Replace the broad inspection/control test with a pane-get test**

Keep or add this focused interaction in `test/integration/herdr-socket-client.test.ts`:

```ts
const response = await client.getPane({ pane_id: "w1:p2" });
expect(response).toEqual({ pane: { pane_id: "w1:p2", terminal_id: "term_2" } });
expect(requests).toContainEqual({
  id: expect.any(String),
  method: "pane.get",
  params: { pane_id: "w1:p2" },
});
```

Use the file's existing fake Unix socket harness and response envelope style rather than adding another server helper.

Delete test cases whose sole purpose is to exercise:

- generic workspace/tab/pane command wrappers;
- `agent.send`, `agent.read`, `agent.list`, `agent.get`, `agent.focus`, `agent.start`, or `agent.wait`;
- `pane.send_input`, `pane.read`, `pane.wait_for_output`, or `events.wait`.

Keep these existing behavior tests:

- Herdr `session.snapshot` success;
- unknown-variant list fallback;
- subscription notification normalization;
- event stream rejection when the socket closes.

Remove `workspaceId: "w1"` from the subscription test input because production subscriptions use only pane IDs and the client never reads that option.

- [x] **Step 2: Run the retained baseline tests**

Run:

```bash
pnpm test test/integration/herdr-socket-client.test.ts test/integration/herdr-pane-identity-resolver.test.ts test/unit/herdr-session-watch-manager.test.ts
```

Expected: all retained observability behavior passes before production deletion.

- [x] **Step 3: Commit the narrowed test contract**

```bash
git add test/integration/herdr-socket-client.test.ts
git commit -m "test(herdr): narrow socket client contract"
```

### Task 2: Delete the Dead Control and Session-Management Layer

**Objective:** Leave one minimal Herdr socket client with no Shepherd-owned control or startup abstraction.

**Files:**
- Delete: `src/herdr/managed-socket-client.ts`
- Delete: `src/herdr/session-lifecycle.ts`
- Delete: `src/herdr/session.ts`
- Delete: `src/herdr/naming.ts`
- Delete: `src/herdr/client-pool.ts`
- Delete: `test/integration/managed-herdr-socket-client.test.ts`
- Delete: `test/unit/herdr-session-lifecycle.test.ts`
- Delete: `test/unit/herdr-session.test.ts`
- Delete: `test/unit/herdr-naming.test.ts`
- Delete: `test/unit/herdr-client-pool.test.ts`
- Modify: `src/herdr/socket-client.ts`

**Interfaces:**
- Consumes: focused retained tests from Task 1.
- Produces: the reduced `HerdrSocketClient` interface from this plan.

- [x] **Step 1: Delete isolated files and tests**

Delete the ten files listed above. Do not leave empty exports, deprecated aliases, comments about deleted APIs, or compatibility shims.

- [x] **Step 2: Remove unused HerdrSocketClient methods**

Delete these methods from `src/herdr/socket-client.ts`:

```text
createWorkspace
listWorkspaces
getWorkspace
focusWorkspace
createTab
listTabs
getTab
splitPane
listPanes
sendPaneInput
sendPaneText
runPaneCommand
readPane
readAgent
listAgents
getAgent
focusAgent
startAgent
sendAgentMessage
waitForAgent
waitForOutput
waitForEvent
```

Retain `getPane()` and implement it through private `#request()`:

```ts
getPane(params: { pane_id: string }): Promise<unknown> {
  return this.#request("pane.get", params);
}
```

Rename the current public `request()` method and internal call sites to:

```ts
#request(method: string, params: unknown = {}): Promise<unknown> {
  const id = `shepherd-${this.#nextId}`;
  this.#nextId += 1;

  return new Promise((resolve, reject) => {
    this.#pending.set(id, { reject, resolve });
    this.#socket.write(encodeJsonLine({ id, method, params }));
  });
}
```

Narrow `subscribeEvents()` params to `{ paneIds?: string[] }`, then call `this.#request("events.subscribe", ...)`.

Do not alter `#requestOnce()`, `#handleData()`, notification normalization, snapshot fallback helpers, or close/error handling except for names required by the private-method rename.

- [x] **Step 3: Search for stale imports and control APIs**

Run:

```bash
rg -n "ManagedHerdrSocketClient|HerdrSessionLifecycle|HerdrClientPool|herdrCliCommandForNamedSession|herdrSocketPathForNamedSession|validateHerdrName|startAgent|sendAgentMessage|waitForAgent|agent\.send" src packages test || true
```

Expected: no matches.

Run:

```bash
rg -n "workspace\.create|tab\.create|pane\.send_input|pane\.wait_for_output|events\.wait|agent\.start|agent\.prompt|agent\.wait" src/herdr packages README.md SKILL.md || true
```

Expected: no Shepherd implementation advertises or wraps these methods. A README/SKILL statement that delegates control to official Herdr may mention command concepts in prose, but must not define Shepherd wrappers.

- [x] **Step 4: Run focused tests and typecheck**

Run:

```bash
pnpm test test/integration/herdr-socket-client.test.ts test/integration/herdr-pane-identity-resolver.test.ts test/unit/herdr-session-watch-manager.test.ts
pnpm typecheck
```

Expected: retained client behavior and every production import compile after deletion.

- [x] **Step 5: Build to catch stale emitted imports**

Run:

```bash
pnpm build
```

Expected: clean `dist` generation succeeds; no output import points to a deleted Herdr module.

- [x] **Step 6: Commit**

```bash
git add -A src/herdr test/integration/herdr-socket-client.test.ts test/integration/managed-herdr-socket-client.test.ts test/unit/herdr-session-lifecycle.test.ts test/unit/herdr-session.test.ts test/unit/herdr-naming.test.ts test/unit/herdr-client-pool.test.ts
git commit -m "refactor(herdr): remove unused control layer"
```

### Task 3: Run Full Validation and Close the Plan

**Objective:** Prove named-agent behavior, notification regressions, migration integrity, package contents, and dead-code removal as one release-ready change.

**Files:**
- Modify: `docs/plans/2026-07-22-herdr-v0-7-5-alignment.md`
- Modify: `docs/plans/2026-07-22-herdr-v0-7-5-alignment/01-named-agent-core.md`
- Modify: `docs/plans/2026-07-22-herdr-v0-7-5-alignment/02-named-agent-surfaces.md`
- Modify: `docs/plans/2026-07-22-herdr-v0-7-5-alignment/03-read-only-client-cleanup.md`

**Interfaces:**
- Consumes: every implementation and test commit from all child plans.
- Produces: completed plan status and recorded command evidence.

- [x] **Step 1: Run focused core and surface suites**

Run:

```bash
pnpm test test/unit/observability-contracts.test.ts test/integration/sqlite-migrations.test.ts test/integration/agent-store-terminal-identity.test.ts test/integration/agent-index-service.test.ts test/integration/agent-context-service.test.ts test/integration/observability-rpc.test.ts test/integration/orchestrator-pane-move.test.ts test/unit/cli.test.ts test/unit/herdr-plugin-package.test.ts test/unit/shepherd-pi-wake.test.ts test/unit/shepherd-pi-agent-update-ui.test.ts test/unit/shepherd-pi-extension.test.ts test/integration/herdr-socket-client.test.ts test/integration/herdr-pane-identity-resolver.test.ts test/unit/herdr-session-watch-manager.test.ts
```

Expected: every named/unnamed, target-priority, event, UI, notification, socket, and migration test passes.

- [x] **Step 2: Run all repository gates**

Run:

```bash
pnpm check
pnpm build
pnpm package:check
```

Expected:

- typecheck passes;
- all Vitest suites pass;
- Biome lint/format passes;
- Drizzle check passes;
- root, Pi, and Herdr plugin package checks pass;
- clean build and alias resolution pass;
- root tarball validation passes.

If the shell resolves an older Node or pnpm, rerun with the project-documented PATH prefix:

```bash
PATH="$HOME/.local/share/mise/installs/node/24.18.0/bin:$HOME/.local/share/mise/installs/pnpm/11.9.0/bin:$PATH" pnpm check
PATH="$HOME/.local/share/mise/installs/node/24.18.0/bin:$HOME/.local/share/mise/installs/pnpm/11.9.0/bin:$PATH" pnpm build
PATH="$HOME/.local/share/mise/installs/node/24.18.0/bin:$HOME/.local/share/mise/installs/pnpm/11.9.0/bin:$PATH" pnpm package:check
```

- [x] **Step 3: Run repository and package-content audits**

Run:

```bash
rg -n "ManagedHerdrSocketClient|HerdrSessionLifecycle|HerdrClientPool|startAgent|sendAgentMessage|waitForAgent|agent\.send" src packages test || true
rg -n "name: string \| null|name: agent\.name|name=\$\{agent\.name|agentIdentityLabel" src packages test
find dist/src/herdr -maxdepth 1 -type f -print | sort
git diff --check
git status --short
```

Expected:

- first search has no matches;
- second search shows the contract, event, target diagnostics, and Pi display helper;
- `dist/src/herdr` has no output for deleted modules;
- no whitespace errors;
- only the intended implementation/plan changes remain before final commits.

- [x] **Step 4: Record completion evidence**

Update every child `Status` to `Completed`, check completed tasks, and add a short `Completion Evidence` section with:

- migration filename;
- focused test count/output summary;
- `pnpm check`, `pnpm build`, and `pnpm package:check` results;
- dead-symbol search result;
- any explicitly unverified manual behavior.

Update the parent `Status` to `Completed`, check all child progress items, and summarize the same evidence without copying detailed logs.

- [x] **Step 5: Commit plan completion separately**

```bash
git add docs/plans/2026-07-22-herdr-v0-7-5-alignment.md docs/plans/2026-07-22-herdr-v0-7-5-alignment/
git commit -m "docs: complete Herdr v0.7.5 alignment plan"
```

## Validation

- `pnpm check` — all repository gates pass.
- `pnpm build` — no deleted Herdr module remains in clean output.
- `pnpm package:check` — root package allowlist passes.
- `pnpm db:check` — migration `0004` remains valid.
- dead-symbol `rg` searches return no matches.
- plan status and completion evidence match actual command results.

## Completion Evidence

- Deleted five unused Herdr production modules and their five dedicated test files.
- Reduced `HerdrSocketClient` to `close`, `getPane`, `sessionSnapshot`, `subscribeEvents`, and private protocol helpers.
- Retained pane lookup, snapshot compatibility fallback, event normalization, and socket-close behavior; 17 focused tests passed.
- Dead-symbol and control-method searches returned no matches.
- `pnpm check`, `pnpm build`, and `pnpm package:check` passed.

## Risks, Tradeoffs, and Open Questions

- Some deleted classes were exported from their source files but never exposed through a documented package entrypoint. Deep imports from `dist` are unsupported and receive no compatibility alias.
- The snapshot fallback still sends private one-shot list requests. Removing public list wrappers does not remove that compatibility behavior.
- A stale `dist` could hide deletion errors. `pnpm build` cleans `dist` before emitting and is mandatory.
- Do not archive the plan in the implementation commit sequence. Project policy requires completed-plan archival as a separate docs-only commit if the user later requests it.
- No open questions remain.
