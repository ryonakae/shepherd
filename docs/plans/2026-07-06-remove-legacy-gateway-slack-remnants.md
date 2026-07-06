# Remove Legacy Gateway and Slack Remnants Plan

> **For implementers:** Execute this plan task-by-task. Complete each checkbox step, run the listed validation, and commit after each task. This cleanup intentionally drops old compatibility and old naming.

**Goal:** Remove legacy Gateway/Slack remnants from current implementation, current docs, and current tests while preserving historical archived plans.

**Architecture:** Shepherd remains a Herdr worker observability/orchestration layer. The daemon process manager lives under `src/daemon`, shared JSON Lines framing lives under `src/shared`, and the Pi package talks to the Shepherd daemon through `shepherd.sock`. Historical plan files may retain old terms only under `docs/plans/archived/`.

**Tech Stack:** TypeScript ESM with NodeNext, Vitest, Biome, pnpm 11, Drizzle check, Pi package dry-pack, Herdr plugin dry-pack.

## Status

Not started.

## Progress

- Not started — plan created for implementation.

## Next steps

- Start Task 1 and keep each cleanup slice independently validated and committed.

## Global Constraints

- No old compatibility paths. Do not keep shim files, fallback env vars, old socket names, or old process entrypoints.
- Current implementation, current docs, current tests, package metadata, and lockfile must not contain old Gateway/Slack implementation names after the final cleanup.
- `docs/plans/archived/` is historical evidence and must not be rewritten to hide past design work.
- Completed plans currently under `docs/plans/` that contain old names should be moved into `docs/plans/archived/` in docs-only commits.
- Keep Shepherd centered on worker observability: structured worker snapshots, enriched `worker.*` events, and orchestrator notifications.
- Do not add a new compatibility layer, migration path, config aliases, or deprecation warnings for removed surfaces.
- Use TDD or focused tests for code changes, then run broad validation.
- Commit after each task. Push after the final validation commit.

## Current Context

- Current old-name remnants found outside `docs/plans/archived/`:
  - `src/gateway/identity.ts`
  - `src/gateway/json-lines.ts`
  - `src/gateway/process-manager.ts`
  - `src/gateway/service.ts`
  - `src/cli/shepherd-gateway.ts`
  - imports from `@/gateway/json-lines.js` and `@/gateway/process-manager.js`
  - `packages/shepherd-pi/src/index.ts` defaulting to `gateway.sock`
  - `packages/shepherd-pi/skills/shepherd/SKILL.md` describing old control-plane/logical-tool behavior
  - root dependencies `@slack/bolt` and `@slack/web-api`
  - current tests named `gateway-*` or using Slack/Gateway examples
  - current docs using old wording in `README.md`, `AGENTS.md`, and completed plans still under `docs/plans/`
- Some words are not legacy and should remain when semantically correct:
  - Herdr `session.snapshot`
  - `sessionRef` / `agent_session` as Pi/Herdr transcript identity fields
  - `delivery` when referring to notification acknowledgement semantics
  - Herdr plugin TOML `platforms = [...]`
- `src/gateway/identity.ts` is unused. Delete it instead of renaming to a daemon identity.

## File Structure

- Move to archive: `docs/plans/2026-07-02-herdr-worker-observability-rewrite.md` — completed historical parent plan.
- Move to archive: `docs/plans/2026-07-02-herdr-worker-observability-rewrite/` — completed historical child plans.
- Create: `src/shared/json-lines.ts` — shared JSON Lines encoder/decoder.
- Delete: `src/gateway/json-lines.ts`.
- Create: `src/daemon/process-manager.ts` — daemon process lifecycle and runtime record helpers.
- Delete: `src/gateway/process-manager.ts`.
- Delete: `src/gateway/identity.ts`.
- Delete: `src/gateway/service.ts`.
- Create: `src/cli/shepherd-daemon.ts` — internal daemon process entrypoint.
- Delete: `src/cli/shepherd-gateway.ts`.
- Modify: `src/cli/shepherd.ts` — use daemon process-manager symbols and `shepherd-daemon.js`.
- Modify: `src/config/runtime.ts` — read daemon runtime records from `src/daemon/process-manager.ts`.
- Modify: `src/daemon/client.ts` — import JSON Lines from `src/shared/json-lines.ts`.
- Modify: `src/daemon/observability-server.ts` — import JSON Lines from `src/shared/json-lines.ts`.
- Modify: `src/herdr/socket-client.ts` — import JSON Lines from `src/shared/json-lines.ts`.
- Modify: `packages/shepherd-pi/src/index.ts` — default socket path is `shepherd.sock`.
- Modify: `packages/shepherd-pi/skills/shepherd/SKILL.md` — describe current worker observability behavior.
- Modify: `packages/shepherd-pi/package.json` — keep or remove `pi.skills` according to the rewritten skill path.
- Modify: `package.json` and `pnpm-lock.yaml` — remove unused Slack SDK dependencies.
- Modify: `README.md`, `README.ja.md`, and `AGENTS.md` — replace old wording with worker observability wording.
- Test: `test/unit/json-lines.test.ts`.
- Rename test: `test/unit/gateway-process-manager.test.ts` -> `test/unit/daemon-process-manager.test.ts`.
- Delete test: `test/unit/gateway-identity.test.ts`.
- Modify tests importing `@/gateway/json-lines.js`.
- Modify tests using old Gateway/Slack names as examples.

## Tasks

### Task 1: Archive Completed Historical Plans

**Objective:** Move completed plans that legitimately mention old architecture into `docs/plans/archived/` so current docs can be cleaned without rewriting history.

**Files:**
- Move: `docs/plans/2026-07-02-herdr-worker-observability-rewrite.md` -> `docs/plans/archived/2026-07-02-herdr-worker-observability-rewrite.md`
- Move: `docs/plans/2026-07-02-herdr-worker-observability-rewrite/` -> `docs/plans/archived/2026-07-02-herdr-worker-observability-rewrite/`
- Modify: links inside the moved parent and child plans so relative links still resolve from `docs/plans/archived/`.

**Interfaces:**
- Consumes: completed rewrite plan with `Status: Done`.
- Produces: current `docs/plans/` containing only active work.

- [ ] **Step 1: Move the completed plan files**

Run:

```bash
mkdir -p docs/plans/archived
mv docs/plans/2026-07-02-herdr-worker-observability-rewrite.md docs/plans/archived/2026-07-02-herdr-worker-observability-rewrite.md
mv docs/plans/2026-07-02-herdr-worker-observability-rewrite docs/plans/archived/2026-07-02-herdr-worker-observability-rewrite
```

Expected: the parent plan and child directory now live under `docs/plans/archived/`.

- [ ] **Step 2: Verify moved-plan relative links**

The child plans are still one directory below their parent after the move, so the existing parent link should remain correct:

```markdown
Parent: [2026-07-02-herdr-worker-observability-rewrite.md](../2026-07-02-herdr-worker-observability-rewrite.md)
```

Run this check:

```bash
rg '^Parent: .*\.\.\/2026-07-02-herdr-worker-observability-rewrite\.md' docs/plans/archived/2026-07-02-herdr-worker-observability-rewrite
```

Expected: every child plan reports the same parent link. If a moved child has a different relative path, edit only that link to point to `../2026-07-02-herdr-worker-observability-rewrite.md`.

- [ ] **Step 3: Validate archive move**

Run:

```bash
test -f docs/plans/archived/2026-07-02-herdr-worker-observability-rewrite.md
test -f docs/plans/archived/2026-07-02-herdr-worker-observability-rewrite/07-cleanup-docs-validation.md
test ! -e docs/plans/2026-07-02-herdr-worker-observability-rewrite.md
test ! -e docs/plans/2026-07-02-herdr-worker-observability-rewrite
```

Expected: all four commands exit with code `0`.

- [ ] **Step 4: Commit**

```bash
git add docs/plans
git commit -m "docs: archive completed observability rewrite plan"
```

### Task 2: Move JSON Lines Framing to Shared Module

**Objective:** Remove the old module path from JSON Lines framing while preserving the exact encoder/decoder behavior used by daemon RPC and Herdr socket tests.

**Files:**
- Create: `src/shared/json-lines.ts`
- Delete: `src/gateway/json-lines.ts`
- Modify: `src/daemon/client.ts`
- Modify: `src/daemon/observability-server.ts`
- Modify: `src/herdr/socket-client.ts`
- Modify: `test/unit/json-lines.test.ts`
- Modify: `test/integration/herdr-socket-client.test.ts`
- Modify: `test/integration/managed-herdr-socket-client.test.ts`
- Modify: `test/integration/observability-rpc.test.ts`

**Interfaces:**
- Consumes: existing `encodeJsonLine(value: unknown): string` and `JsonLineDecoder` behavior.
- Produces: same exports from `@/shared/json-lines.js`.

- [ ] **Step 1: Write the failing import change**

Update `test/unit/json-lines.test.ts` to import from `@/shared/json-lines.js` and replace the old sample method with a current method:

```ts
import { describe, expect, test } from "vitest";
import { encodeJsonLine, JsonLineDecoder } from "@/shared/json-lines.js";

describe("JSON Lines framing", () => {
  test("encodes one JSON value per newline-delimited frame", () => {
    expect(encodeJsonLine({ id: 1, method: "worker.events" })).toBe(
      '{"id":1,"method":"worker.events"}\n',
    );
  });

  test("decodes frames split across chunks", () => {
    const decoder = new JsonLineDecoder();

    expect(decoder.push('{"id":1')).toEqual([]);
    expect(decoder.push('}\n{"id":2}\n')).toEqual([{ id: 1 }, { id: 2 }]);
  });

  test("flushes a final frame without a trailing newline", () => {
    const decoder = new JsonLineDecoder();

    expect(decoder.push('{"id":1}')).toEqual([]);
    expect(decoder.flush()).toEqual([{ id: 1 }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test test/unit/json-lines.test.ts`

Expected: module resolution fails for `@/shared/json-lines.js`.

- [ ] **Step 3: Create the shared module and update imports**

Create `src/shared/json-lines.ts` with the current implementation:

```ts
export function encodeJsonLine(value: unknown): string {
  const encoded = JSON.stringify(value);

  if (encoded === undefined) {
    throw new TypeError("JSON Lines values must be JSON-serializable");
  }

  return `${encoded}\n`;
}

export class JsonLineDecoder {
  #buffer = "";

  push(chunk: string): unknown[] {
    this.#buffer += chunk;

    const lines = this.#buffer.split("\n");
    this.#buffer = lines.pop() ?? "";

    return lines.filter((line) => line.length > 0).map((line) => JSON.parse(line));
  }

  flush(): unknown[] {
    if (this.#buffer.length === 0) {
      return [];
    }

    const line = this.#buffer;
    this.#buffer = "";
    return [JSON.parse(line)];
  }
}
```

Replace every import from `@/gateway/json-lines.js` with `@/shared/json-lines.js`.

Delete `src/gateway/json-lines.ts`.

- [ ] **Step 4: Run focused tests**

Run:

```bash
pnpm test test/unit/json-lines.test.ts test/integration/herdr-socket-client.test.ts test/integration/managed-herdr-socket-client.test.ts test/integration/observability-rpc.test.ts
```

Expected: all listed tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/shared/json-lines.ts src/daemon/client.ts src/daemon/observability-server.ts src/herdr/socket-client.ts test/unit/json-lines.test.ts test/integration/herdr-socket-client.test.ts test/integration/managed-herdr-socket-client.test.ts test/integration/observability-rpc.test.ts
git rm src/gateway/json-lines.ts
git commit -m "refactor: move json lines framing to shared module"
```

### Task 3: Rename Process Management and Daemon Entrypoint

**Objective:** Replace old process-manager names and internal entrypoint with daemon names, with no shim or compatibility file.

**Files:**
- Create: `src/daemon/process-manager.ts`
- Create: `src/cli/shepherd-daemon.ts`
- Delete: `src/gateway/process-manager.ts`
- Delete: `src/gateway/identity.ts`
- Delete: `src/gateway/service.ts`
- Delete: `src/cli/shepherd-gateway.ts`
- Modify: `src/cli/shepherd.ts`
- Modify: `src/config/runtime.ts`
- Rename: `test/unit/gateway-process-manager.test.ts` -> `test/unit/daemon-process-manager.test.ts`
- Delete: `test/unit/gateway-identity.test.ts`

**Interfaces:**
- Consumes: daemon service function `runObservabilityDaemonService()` from `src/daemon/service.ts`.
- Produces:
  - `DaemonRuntimeRecord`
  - `DaemonStatus`
  - `DaemonProcessDependencies`
  - `readDaemonRuntimeRecord(path)`
  - `writeDaemonRuntimeRecord(path, record)`
  - `prepareDaemonSocketPath(input)`
  - `getDaemonStatus(input)`
  - `startDaemonProcess(input)`
  - `stopDaemonProcess(input)`

- [ ] **Step 1: Rename the focused process-manager test first**

Move the test file and update imports/symbols/text:

```bash
mv test/unit/gateway-process-manager.test.ts test/unit/daemon-process-manager.test.ts
```

Use these replacements inside the moved file:

| Old | New |
|---|---|
| `@/gateway/process-manager.js` | `@/daemon/process-manager.js` |
| `GatewayRuntimeRecord` | `DaemonRuntimeRecord` |
| `getGatewayStatus` | `getDaemonStatus` |
| `prepareGatewaySocketPath` | `prepareDaemonSocketPath` |
| `readGatewayRuntimeRecord` | `readDaemonRuntimeRecord` |
| `startGatewayProcess` | `startDaemonProcess` |
| `stopGatewayProcess` | `stopDaemonProcess` |
| `writeGatewayRuntimeRecord` | `writeDaemonRuntimeRecord` |
| `gateway process manager` | `daemon process manager` |
| `gateway.sock` | `shepherd.sock` |
| `shepherd-gateway.js` | `shepherd-daemon.js` |
| `Shepherd Gateway` | `Shepherd daemon` |

Delete `test/unit/gateway-identity.test.ts`; daemon identity is intentionally absent.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test test/unit/daemon-process-manager.test.ts`

Expected: module resolution fails for `@/daemon/process-manager.js` or old symbols are missing.

- [ ] **Step 3: Create daemon process manager**

Move the process-manager implementation to `src/daemon/process-manager.ts` and rename all exported types/functions according to the table in Step 1.

Use these exact user-facing error messages:

```ts
throw new Error(`Shepherd daemon socket is already reachable: ${input.socketPath}`);
throw new Error(`Shepherd daemon is already running with pid ${status.pid}`);
throw new Error("Failed to start Shepherd daemon: child pid was not assigned");
throw new Error(`Timed out waiting for Shepherd daemon pid ${status.pid} to stop`);
```

Rename the private spawn helper to `spawnDaemonProcess`.

Delete `src/gateway/process-manager.ts` after all imports are updated.

- [ ] **Step 4: Replace internal daemon entrypoint**

Create `src/cli/shepherd-daemon.ts`:

```ts
#!/usr/bin/env node
import { resolve } from "node:path";
import { argv, exit } from "node:process";
import { fileURLToPath } from "node:url";
import { runObservabilityDaemonService } from "@/daemon/service.js";

async function main(): Promise<void> {
  if (argv.length > 2) {
    throw new Error("shepherd-daemon does not accept CLI arguments");
  }
  await runObservabilityDaemonService();
}

if (fileURLToPath(import.meta.url) === resolve(argv[1] ?? "")) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    exit(1);
  });
}
```

Delete `src/cli/shepherd-gateway.ts` and `src/gateway/service.ts`. Do not create a shim.

- [ ] **Step 5: Update consumers**

In `src/cli/shepherd.ts`:

```ts
import {
  getDaemonStatus,
  startDaemonProcess,
  stopDaemonProcess,
} from "@/daemon/process-manager.js";
```

Replace calls and entrypoint:

```ts
await getDaemonStatus(...)
await stopDaemonProcess(...)
await startDaemonProcess({
  entrypointPath: resolve(dirname(fileURLToPath(import.meta.url)), "shepherd-daemon.js"),
  ...
})
```

In `src/config/runtime.ts`, replace the import and call:

```ts
import { readDaemonRuntimeRecord } from "@/daemon/process-manager.js";

const record = readDaemonRuntimeRecord(input.recordPath ?? defaultPaths.runtimeRecordPath);
```

- [ ] **Step 6: Delete daemon identity remnant**

Delete `src/gateway/identity.ts`. Do not create `src/daemon/identity.ts`.

- [ ] **Step 7: Run focused validation**

Run:

```bash
pnpm test test/unit/daemon-process-manager.test.ts test/unit/config-runtime.test.ts test/unit/cli.test.ts
pnpm typecheck
```

Expected:

- Process-manager tests pass with daemon names.
- Config runtime tests pass using `readDaemonRuntimeRecord`.
- CLI tests pass with daemon command behavior unchanged externally.
- TypeScript reports no imports from `@/gateway/process-manager.js`.

- [ ] **Step 8: Commit**

```bash
git add src/daemon/process-manager.ts src/cli/shepherd-daemon.ts src/cli/shepherd.ts src/config/runtime.ts test/unit/daemon-process-manager.test.ts test/unit/config-runtime.test.ts test/unit/cli.test.ts
git rm src/gateway/process-manager.ts src/gateway/identity.ts src/gateway/service.ts src/cli/shepherd-gateway.ts test/unit/gateway-identity.test.ts
git commit -m "refactor: rename process management to daemon"
```

### Task 4: Clean Pi Package Runtime Naming and Skill Text

**Objective:** Make the Pi package describe and connect to the current Shepherd daemon/worker-observability surface only.

**Files:**
- Modify: `packages/shepherd-pi/src/index.ts`
- Modify: `packages/shepherd-pi/skills/shepherd/SKILL.md`
- Modify: `test/unit/shepherd-pi-extension.test.ts` if a default socket test is added.

**Interfaces:**
- Consumes: daemon socket default `~/.shepherd/shepherd.sock`.
- Produces: Pi extension behavior with no old socket fallback and a current skill document.

- [ ] **Step 1: Add or update a focused test for default socket path**

If `test/unit/shepherd-pi-extension.test.ts` does not currently assert the default socket, add an exported helper from the extension module:

```ts
export function defaultSocketPath() {
  return `${defaultShepherdHome().replace(/\/$/, "")}/shepherd.sock`;
}
```

Then add a test that imports `defaultSocketPath`, sets `SHEPHERD_HOME` to `/tmp/shepherd-home`, and expects `/tmp/shepherd-home/shepherd.sock`.

If exporting the helper would expose unnecessary API, instead test by injecting a fake `createConnection` only if the current module structure already supports that. Do not add a compatibility env var.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test test/unit/shepherd-pi-extension.test.ts`

Expected: the new default socket test fails because the extension still returns `gateway.sock`.

- [ ] **Step 3: Change default socket path**

In `packages/shepherd-pi/src/index.ts`, change the default from:

```ts
return `${defaultShepherdHome().replace(/\/$/, "")}/gateway.sock`;
```

to:

```ts
return `${defaultShepherdHome().replace(/\/$/, "")}/shepherd.sock`;
```

Do not read `SHEPHERD_GATEWAY_SOCKET_PATH`, `SHEPHERD_SOCKET_PATH`, or `SHEPHERD_DAEMON_SOCKET_PATH`.

- [ ] **Step 4: Rewrite the Pi skill**

Replace `packages/shepherd-pi/skills/shepherd/SKILL.md` with current guidance:

```markdown
---
name: shepherd
description: Guidance for Shepherd worker observability notifications and telemetry in an attached Pi session. Use when you need Shepherd/Herdr/Pi role boundaries or package-level bridge behavior.
disable-model-invocation: true
---

# Shepherd Worker Observability Bridge

Shepherd watches Herdr-managed coding agents and provides worker snapshots, enriched `worker.*` events, and orchestrator notifications. Pi owns the model conversation and provider runtime. Herdr owns terminal workspaces, panes, and low-level agent control.

When the `shepherd-pi` extension is active:

- It observes the current Herdr workspace when Pi runs inside Herdr.
- It sends bounded, redacted runtime telemetry to Shepherd, including tool result excerpts, final message excerpts, `sessionRef`, and `artifactRefs`.
- It receives Shepherd worker notifications and surfaces them through Pi status, widgets, session entries, and next-turn hidden context.
- It may auto-resume only when configured by the extension and Pi is idle.
- It does not send hidden thinking, full tool results, or full transcripts to Shepherd.
- It does not replace Herdr commands for workspace, tab, pane, or agent control.

Use Shepherd data as observability context. Use Herdr directly for low-level terminal or workspace operations when the user asks for those operations.
```

- [ ] **Step 5: Run focused validation**

Run:

```bash
pnpm test test/unit/shepherd-pi-extension.test.ts
pnpm pi-package:check
```

Expected: Pi extension unit tests pass, package typecheck passes, and dry pack succeeds.

- [ ] **Step 6: Commit**

```bash
git add packages/shepherd-pi/src/index.ts packages/shepherd-pi/skills/shepherd/SKILL.md test/unit/shepherd-pi-extension.test.ts
git commit -m "refactor(pi): remove legacy socket and skill wording"
```

### Task 5: Remove Slack SDK Dependencies and Old Test Examples

**Objective:** Remove unused Slack SDK dependencies and eliminate old names from current tests rather than keeping rejection tests for deleted concepts.

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `test/unit/config-schema.test.ts`
- Modify: `test/unit/config-loader.test.ts`
- Modify: `test/unit/config-runtime.test.ts`
- Modify: `test/unit/herdr-naming.test.ts`
- Modify: `test/integration/notification-service.test.ts`

**Interfaces:**
- Consumes: current config schema that only accepts `runtime` and `observability`.
- Produces: current tests without old implementation names.

- [ ] **Step 1: Update config tests away from old names**

In `test/unit/config-schema.test.ts`, replace the old rejection test with an unknown-key rejection that does not name removed features:

```ts
test("rejects unknown top-level config surfaces", () => {
  for (const config of [
    { workers: { enabled: true } },
    { providers: { example: {} } },
    { orchestration: { queue: {} } },
  ]) {
    const result = parseShepherdConfig(config);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.errors.some((error) => error.keyword === "additionalProperties")).toBe(true);
  }
});
```

In `test/unit/config-loader.test.ts`, replace the old rejection test with:

```ts
test("rejects unknown config fields", () => {
  const result = parseShepherdConfig({ providers: { example: {} }, workers: { enabled: true } });

  expect(result.ok).toBe(false);
  if (!result.ok)
    expect(result.errors.some((error) => error.keyword === "additionalProperties")).toBe(true);
});
```

In `test/unit/config-runtime.test.ts`:

- Replace `SLACK_BOT_TOKEN=file-token` with `EXAMPLE_SERVICE_TOKEN=file-token`.
- Replace assertions for `SLACK_BOT_TOKEN` with `EXAMPLE_SERVICE_TOKEN`.
- Replace `SHEPHERD_GATEWAY_SOCKET_PATH=/tmp/ignored.sock` with `SHEPHERD_INTERNAL_SOCKET_PATH=/tmp/ignored.sock`.
- Replace assertions for `SHEPHERD_GATEWAY_SOCKET_PATH` with `SHEPHERD_INTERNAL_SOCKET_PATH`.
- Replace every parse-error fixture string `gateway: [` with `runtime: [`.

- [ ] **Step 2: Update naming and notification examples**

In `test/unit/herdr-naming.test.ts`, replace Slack-specific examples:

```ts
expect(herdrWorkspaceNameForTask("Review Worker Sync", "abc123")).toBe(
  "shepherd-review-worker-sync-abc123",
);
expect(slugifyHerdrName("Worker thread / deploy")).toBe("worker-thread-deploy");
expect(() => validateHerdrName("worker/thread")).toThrow("Invalid Herdr name");
```

In `test/integration/notification-service.test.ts`, replace `subscriberId: "tui"` and `subscriberKind: "tui"` with `subscriberId: "cli"` and `subscriberKind: "cli"`, unless the test is specifically validating Pi behavior.

- [ ] **Step 3: Remove unused Slack SDK dependencies**

Run:

```bash
pnpm remove @slack/bolt @slack/web-api
```

Expected: `package.json` no longer lists those dependencies, and `pnpm-lock.yaml` removes unreachable Slack packages.

- [ ] **Step 4: Run focused validation**

Run:

```bash
pnpm test test/unit/config-schema.test.ts test/unit/config-loader.test.ts test/unit/config-runtime.test.ts test/unit/herdr-naming.test.ts test/integration/notification-service.test.ts
```

Expected: all listed tests pass with no old-name examples.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml test/unit/config-schema.test.ts test/unit/config-loader.test.ts test/unit/config-runtime.test.ts test/unit/herdr-naming.test.ts test/integration/notification-service.test.ts
git commit -m "chore: remove unused messaging dependencies and old examples"
```

### Task 6: Clean Current Docs and Run Legacy-Name Audit

**Objective:** Ensure current docs and implementation no longer expose old names, while archived plans remain untouched.

**Files:**
- Modify: `README.md`
- Modify: `README.ja.md`
- Modify: `AGENTS.md`
- Modify: any current non-archived file reported by the audit command.

**Interfaces:**
- Consumes: renamed daemon/shared modules and cleaned Pi package.
- Produces: current documentation aligned with worker observability wording.

- [ ] **Step 1: Update README wording**

In `README.md`, replace wording that says Shepherd is not an LLM gateway with wording that avoids the old name entirely. Use:

```markdown
Shepherd is not an LLM runtime and is not a thin Herdr wrapper.
```

Keep the current value proposition:

- structured worker snapshots
- enriched `worker.*` events
- orchestrator push notifications

Do not mention removed Slack, old queueing, old logical tools, or old command surfaces.

In `README.ja.md`, replace the stale old architecture document with a Japanese version of the current worker observability README. It must describe:

- Shepherd as a Herdr worker observability/orchestration layer.
- Core value: worker snapshots, enriched `worker.*` events, orchestrator notifications.
- Current quick start: `pnpm install`, `pnpm check`, `pnpm build`, `shepherd daemon start`, Pi extension install, Herdr plugin link.
- Current CLI examples: `observe`, `observe-current`, `snapshot`, `events`, `notifications`, `ack`, `message-worker`, `wait-worker`.
- Current important paths: `src/observability`, `src/daemon`, `src/db`, `src/herdr`, `packages/shepherd-pi`, `packages/shepherd-herdr-plugin`.

It must not mention removed messaging platforms, removed queueing, removed old command entrypoints, or removed helper binaries.

- [ ] **Step 2: Update AGENTS.md wording**

In root `AGENTS.md`, replace the opening description from an orchestration gateway to an orchestration layer. The first sentence should read:

```markdown
Shepherd は、Herdr 管理の coding agent を TUI / Pi / Herdr plugin などのイベントストリームから観測・操作する orchestration layer です。
```

If `TUI` is no longer a supported surface in current code, use this instead:

```markdown
Shepherd は、Herdr 管理の coding agent を CLI / Pi / Herdr plugin などのイベントストリームから観測・操作する orchestration layer です。
```

Choose the second version if no current `src/tui` implementation exists.

- [ ] **Step 3: Run current-surface audit**

Run:

```bash
rg 'gateway|Gateway|slack|Slack|SLACK|shepherd-tools|session_bindings|pi_turns|worker_agent_bindings|logical tools|logical-tool' \
  src packages test README.md README.ja.md AGENTS.md package.json pnpm-lock.yaml
```

Expected: no matches.

Then run a docs-scoped check excluding archived plans:

```bash
rg 'gateway|Gateway|slack|Slack|SLACK|shepherd-tools|session_bindings|pi_turns|worker_agent_bindings|logical tools|logical-tool' \
  docs/plans -g '!**/archived/**'
```

Expected: matches only in this active cleanup plan before Task 8. If other current plan files match, archive completed plans or rewrite current docs according to their status.

- [ ] **Step 4: Run focused docs/package checks**

Run:

```bash
pnpm format:check
pnpm lint
```

Expected: Biome format and lint pass for covered files.

- [ ] **Step 5: Commit**

```bash
git add README.md README.ja.md AGENTS.md
git commit -m "docs: remove legacy wording from current docs"
```

If Step 3 required additional current-file changes, include those files in the same commit only when they are documentation-only changes. Code/test fixes should be committed with the task that introduced them.

### Task 7: Full Validation and Build

**Objective:** Verify the cleanup as a complete product slice.

**Files:**
- No new files expected unless validation exposes missing imports or stale tests.

**Interfaces:**
- Consumes: all prior cleanup tasks.
- Produces: validated codebase with old implementation names removed from current surfaces.

- [ ] **Step 1: Run full validation**

Run:

```bash
pnpm check
pnpm build
```

Expected:

- `pnpm check` passes typecheck, tests, Biome, format check, Drizzle check, Pi package check, Herdr plugin package check, and package dry-runs.
- `pnpm build` emits `dist` without TypeScript or alias resolution errors.
- `dist/src/cli/shepherd-daemon.js` exists after build.
- `dist/src/cli/shepherd-gateway.js` does not exist after a clean build. If `dist` contains stale files from a previous build, remove `dist` and rerun `pnpm build`.

- [ ] **Step 2: Run CLI smoke outside Herdr**

Run:

```bash
node dist/src/cli/shepherd.js observe-current --json
```

Expected:

- Exit code `1`.
- stderr includes `observe-current requires a Herdr-managed pane`.

- [ ] **Step 3: Run current-surface legacy-name audit again**

Run:

```bash
rg 'gateway|Gateway|slack|Slack|SLACK|shepherd-tools|session_bindings|pi_turns|worker_agent_bindings|logical tools|logical-tool' \
  src packages test README.md README.ja.md AGENTS.md package.json pnpm-lock.yaml
```

Expected: no matches.

Run:

```bash
rg 'gateway|Gateway|slack|Slack|SLACK|shepherd-tools|session_bindings|pi_turns|worker_agent_bindings|logical tools|logical-tool' \
  docs/plans -g '!**/archived/**'
```

Expected: matches only in this cleanup plan before it is archived in Task 8.

- [ ] **Step 4: Commit validation fixes if needed**

If validation required code or test fixes, commit them as:

```bash
git add <fixed-files>
git commit -m "fix: stabilize daemon cleanup"
```

If no fixes were needed, do not create an empty commit.

### Task 8: Archive This Cleanup Plan and Push

**Objective:** Leave no old implementation names in active plans after the cleanup is complete, while preserving this plan as history.

**Files:**
- Move: `docs/plans/2026-07-06-remove-legacy-gateway-slack-remnants.md` -> `docs/plans/archived/2026-07-06-remove-legacy-gateway-slack-remnants.md`

**Interfaces:**
- Consumes: completed cleanup with all validation passing.
- Produces: current `docs/plans/` without this old-name cleanup plan.

- [ ] **Step 1: Update this plan status before archiving**

Change this file's top sections before moving:

```markdown
## Status

Done.

## Progress

- Done — legacy remnants removed from current implementation, docs, tests, package metadata, and lockfile.

## Next steps

- No remaining implementation steps. Historical references remain only under `docs/plans/archived/`.
```

- [ ] **Step 2: Move the plan to archived**

Run:

```bash
mv docs/plans/2026-07-06-remove-legacy-gateway-slack-remnants.md docs/plans/archived/2026-07-06-remove-legacy-gateway-slack-remnants.md
```

Expected: the cleanup plan now lives under `docs/plans/archived/`.

- [ ] **Step 3: Final docs audit**

Run:

```bash
rg 'gateway|Gateway|slack|Slack|SLACK|shepherd-tools|session_bindings|pi_turns|worker_agent_bindings|logical tools|logical-tool' \
  docs/plans -g '!**/archived/**'
```

Expected: no matches.

- [ ] **Step 4: Commit archive move**

```bash
git add docs/plans
git commit -m "docs: archive legacy cleanup plan"
```

- [ ] **Step 5: Push**

Run:

```bash
git status --short
git push
```

Expected:

- `git status --short` is empty before push.
- Push succeeds to the current branch's upstream.

## Validation

Run after Task 7 and again after any validation fixes:

```bash
pnpm check
pnpm build
```

Expected final result:

- TypeScript checks pass.
- Unit and integration tests pass.
- Biome lint and format checks pass.
- Drizzle check passes.
- Pi package check and Herdr plugin package check pass.
- Build succeeds and emits `dist/src/cli/shepherd-daemon.js`.
- Current implementation, current docs, current tests, `package.json`, and `pnpm-lock.yaml` have no matches for:
  - `gateway`
  - `Gateway`
  - `slack`
  - `Slack`
  - `SLACK`
  - `shepherd-tools`
  - `session_bindings`
  - `pi_turns`
  - `worker_agent_bindings`
  - `logical tools`
  - `logical-tool`
- Historical matches may remain under `docs/plans/archived/`.

Manual smoke:

```bash
node dist/src/cli/shepherd.js observe-current --json
```

Expected outside Herdr: exit code `1` and stderr `observe-current requires a Herdr-managed pane`.

## Risks, Tradeoffs, and Open Questions

- **Risk: stale `dist` files.** TypeScript does not delete old build output. If `dist/src/cli/shepherd-gateway.js` remains after build, remove `dist` and rerun `pnpm build`; do not keep a shim.
- **Risk: audit false positives.** `sessionRef`, Herdr `session.snapshot`, `agent_session`, and plugin TOML `platforms` are current concepts and are not part of the forbidden audit list.
- **Risk: active plan contains old names until archived.** This is accepted only during implementation. Task 8 archives this plan so current plans become clean afterward.
- **Tradeoff: no old config rejection examples.** Unknown top-level rejection remains tested, but removed product names are not preserved in current tests.
- **Tradeoff: no socket env override in Pi package.** This keeps old compatibility out. If a future override is needed, add a new design with current names in a separate plan.
- **No blocking open questions.** The `/dig` decisions provide enough detail to implement.

## Self-Review Checklist

- Requirement coverage: user decisions A/A/B/old-compat-none/B/A and the correction about not preserving old names in tests are represented.
- Placeholder check: no placeholder markers or unspecified cleanup remains.
- Naming consistency: daemon symbols use `Daemon*`, JSON Lines imports use `@/shared/json-lines.js`, Pi socket uses `shepherd.sock`.
- Testability: each code task has focused tests and expected failures/successes.
- Scope: archived historical docs are preserved; current implementation/docs/tests are cleaned.
- DRY: shared JSON Lines framing is defined once in `src/shared`.
- Implementation handoff: file paths, rename mappings, commands, and commit points are explicit.
