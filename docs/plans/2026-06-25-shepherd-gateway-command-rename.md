# Shepherd Gateway Command and Naming Unification Plan

> **For implementers:** Execute this plan task-by-task. Complete each checkbox step, run the listed validation, and commit after each task.

Date: 2026-06-25

## Status

Active.

## Progress

- **Not started** — This is a plan-only document. No implementation files have been changed.

## Next steps

Implement Task 1 first. Do not keep backward compatibility for `shepherd daemon`, `SHEPHERD_DAEMON_ID`, `daemonId`, `src/daemon`, or daemon-named tests because Shepherd has not been released.

**Goal:** Make Shepherd's local background service consistently named **Gateway** across CLI, code, wire contracts, Pi bridge metadata, tests, README, and active plans. Add `shepherd gateway start/stop/restart/status` as the primary service management surface.

**Architecture:** `Shepherd Gateway` is the local long-running service that owns the Unix socket, JSON Lines RPC, platform adapters, Pi supervision, run queueing, recovery, and logical tools. Existing `gateway.*` RPC methods, `gateway.*` event types, and the `gateway_runs` database table already use the right product term and stay unchanged. The previous foreground service implementation moves from `src/daemon/*` into `src/gateway/*`; a small process manager starts/stops a detached `shepherd gateway run` child for `start/stop/restart/status`.

**Tech Stack:** TypeScript ESM with `NodeNext`, Node.js `node:child_process`, `node:net`, `node:fs`, Vitest, Biome, SQLite via `node:sqlite`, Pi extension JavaScript.

## Global Constraints

- No compatibility aliases for the old unreleased surface:
  - `shepherd daemon` must become an unknown command.
  - `SHEPHERD_DAEMON_ID` must be replaced by `SHEPHERD_GATEWAY_ID`.
  - Pi binding/RPC field `daemonId` must be replaced by `gatewayId`.
  - The persisted identity file must be `gateway-id`, not `daemon-id`.
  - `src/daemon` and `test/*daemon*` files must be renamed.
- Keep existing `gateway.*` RPC methods and events unchanged, including `gateway.claim_next_run`, `gateway.start_run`, `gateway.complete_run`, `gateway.fail_run`, `gateway.stream_delta`, `gateway.stream_finish`, and `gateway.run.queued`.
- Keep the `gateway_runs` DB table unchanged. No Drizzle migration is needed for this rename.
- Keep neutral environment variables unless the name currently hides the service role. Replace `SHEPHERD_SOCKET_PATH` with `SHEPHERD_GATEWAY_SOCKET_PATH`; keep `SHEPHERD_DB_PATH` and `SHEPHERD_CONFIG`.
- `daemon` may remain only in archived historical docs under `docs/plans/archived/**`. Source, tests, packages, README, and active plans should use `gateway`.
- Implementation changes must use TDD where behavior changes. Pure file/class renames may be validated by the renamed test suite plus `rg` checks.
- After implementation, run `pnpm check`; because CLI process management and dist entrypoint behavior change, also run `pnpm build`.

## Current Context

- `src/cli/shepherd.ts` currently parses `shepherd daemon [--socket <path>] [--db <path>] [--config <path>]` and runs the service in the foreground.
- `src/daemon/server.ts` exports `ShepherdDaemonServer`, owns the Unix socket, JSON Lines RPC, Pi handshake/attach/heartbeat, session events, logical tool RPC, and external gateway run RPC.
- `src/daemon/identity.ts` stores a stable id in `<stateDir>/daemon-id` and exports `readOrCreateDaemonId`.
- `src/daemon/recovery.ts` exports `recoverDaemonState` and writes recovery notes for queued/running gateway runs.
- `src/daemon/json-lines.ts` is imported by the TUI client, Herdr socket clients, CLI tools, Pi readiness tests, and server tests.
- `packages/shepherd-pi/extensions/index.js` has `ShepherdDaemonClient`, reads `SHEPHERD_DAEMON_ID` and `SHEPHERD_SOCKET_PATH`, writes binding entries with `daemonId`, and displays daemon-oriented error messages.
- `test/unit/cli.test.ts` asserts `shepherd daemon` parsing and `SHEPHERD_DAEMON_ID` in Pi open environment.
- `test/integration/daemon-rpc.test.ts`, `test/integration/daemon-recovery.test.ts`, and `test/unit/daemon-identity.test.ts` directly encode daemon naming in filenames, imports, `describe` labels, temp prefixes, and expected wire fields.
- `README.md`, `README.ja.md`, and active plans under `docs/plans/2026-06-25-pi-runtime-gateway*` still describe daemon startup and daemon identity.

## File Structure

- Move: `src/daemon/server.ts` -> `src/gateway/server.ts` — Gateway Unix socket/RPC server.
- Move: `src/daemon/identity.ts` -> `src/gateway/identity.ts` — stable Gateway identity file.
- Move: `src/daemon/recovery.ts` -> `src/gateway/recovery.ts` — Gateway startup recovery for in-flight runs.
- Move: `src/daemon/json-lines.ts` -> `src/gateway/json-lines.ts` — Gateway JSON Lines framing used by all local clients.
- Create: `src/gateway/process-manager.ts` — detached process management for `start/stop/restart/status`.
- Modify: `src/cli/shepherd.ts` — parse `gateway` subcommands, foreground `gateway run`, background management commands, env names, help text.
- Modify: `src/cli/shepherd-tools.ts` — import JSON Lines from `@/gateway/json-lines.js` and read `SHEPHERD_GATEWAY_SOCKET_PATH`.
- Modify: `src/tui/client.ts` — import JSON Lines from `@/gateway/json-lines.js` and use gateway wording.
- Modify: `src/herdr/socket-client.ts` and `src/herdr/managed-socket-client.ts` tests as needed — update JSON Lines imports only.
- Modify: `src/gateway/pi-readiness.ts` — import `PiHandshakeRecord` from `@/gateway/server.js`, use `shepherd gateway start` guidance, read `SHEPHERD_GATEWAY_SOCKET_PATH` in spawned Pi env.
- Modify: `src/gateway/pi-supervisor.ts` — pass `SHEPHERD_GATEWAY_SOCKET_PATH` to headless Pi sessions.
- Modify: `packages/shepherd-pi/extensions/index.js` — rename client class, env variables, binding key, messages.
- Modify: `packages/shepherd-pi/package.json` — update description.
- Move: `test/integration/daemon-rpc.test.ts` -> `test/integration/gateway-rpc.test.ts`.
- Move: `test/integration/daemon-recovery.test.ts` -> `test/integration/gateway-recovery.test.ts`.
- Move: `test/unit/daemon-identity.test.ts` -> `test/unit/gateway-identity.test.ts`.
- Modify: `test/unit/shepherd-tools.test.ts` and `test/unit/pi-supervisor.test.ts` — assert gateway env names.
- Modify: all tests importing `@/daemon/json-lines.js` or `@/daemon/server.js` to use `@/gateway/...`.
- Modify: `README.md`, `README.ja.md` — user-facing commands and project layout.
- Move: `docs/plans/2026-06-25-pi-runtime-gateway/2026-06-25-daemon-pi-supervisor-run-queue.md` -> `docs/plans/2026-06-25-pi-runtime-gateway/2026-06-25-gateway-pi-supervisor-run-queue.md`.
- Modify: active plan links/text under `docs/plans/2026-06-25-pi-runtime-gateway.md` and its child plans.

## Tasks

### Task 1: Rename the Gateway server modules and stable identity

**Objective:** Remove daemon naming from service implementation modules while preserving current foreground runtime behavior.

**Files:**
- Move: `src/daemon/server.ts` -> `src/gateway/server.ts`
- Move: `src/daemon/identity.ts` -> `src/gateway/identity.ts`
- Move: `src/daemon/recovery.ts` -> `src/gateway/recovery.ts`
- Move: `src/daemon/json-lines.ts` -> `src/gateway/json-lines.ts`
- Move: `test/unit/daemon-identity.test.ts` -> `test/unit/gateway-identity.test.ts`
- Move: `test/integration/daemon-recovery.test.ts` -> `test/integration/gateway-recovery.test.ts`
- Move: `test/integration/daemon-rpc.test.ts` -> `test/integration/gateway-rpc.test.ts`
- Modify: `src/cli/shepherd.ts`, `src/cli/shepherd-tools.ts`, `src/tui/client.ts`, `src/herdr/socket-client.ts`, `src/gateway/pi-readiness.ts`, tests importing `@/daemon/*`

**Interfaces:**
- Consumes: existing `ShepherdDaemonServer`, `recoverDaemonState`, `readOrCreateDaemonId`, `PiHandshakeRecord` behavior.
- Produces: `ShepherdGatewayServer`, `recoverGatewayState`, `readOrCreateGatewayId`, `PiHandshakeRecord` with `gatewayId`.

- [ ] **Step 1: Write the failing rename expectations**

Update the renamed tests before implementation:

1. In `test/unit/gateway-identity.test.ts`, import `readOrCreateGatewayId` from `@/gateway/identity.js`, use `describe("readOrCreateGatewayId", ...)`, use temp prefix `shepherd-gateway-id-`, and assert the identity file is `gateway-id`:

```ts
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { readOrCreateGatewayId } from "@/gateway/identity.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("readOrCreateGatewayId", () => {
  test("creates and reuses a stable gateway id", () => {
    const dir = mkdtempSync(join(tmpdir(), "shepherd-gateway-id-"));
    tempDirs.push(dir);

    const first = readOrCreateGatewayId(dir);
    const second = readOrCreateGatewayId(dir);

    expect(second).toBe(first);
    expect(existsSync(join(dir, "gateway-id"))).toBe(true);
    expect(readFileSync(join(dir, "gateway-id"), "utf8").trim()).toBe(first);
  });
});
```

2. In `test/integration/gateway-recovery.test.ts`, import `recoverGatewayState`, use `describe("recoverGatewayState", ...)`, and expect the recovery message to say `gateway startup`:

```ts
expect(events.listEvents("session-1")[0]?.payload).toMatchObject({
  message: "Gateway run was in flight during gateway startup. Shepherd did not replay it automatically.",
});
```

3. In `test/integration/gateway-rpc.test.ts`, import `ShepherdGatewayServer` and `encodeJsonLine`/`JsonLineDecoder` from `@/gateway/...`, use `describe("ShepherdGatewayServer JSON Lines RPC", ...)`, rename helper option `gatewayId?: string`, construct `new ShepherdGatewayServer({ gatewayId: ... })`, and replace expected `daemonId` fields with `gatewayId`.

4. Update all remaining imports from `@/daemon/json-lines.js`, `@/daemon/server.js`, `@/daemon/recovery.js`, and `@/daemon/identity.js` to `@/gateway/...`. This includes `src/cli/shepherd-tools.ts`, `test/unit/shepherd-tools.test.ts`, TUI client tests, Herdr socket client tests, and Pi readiness tests.

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm test -- test/unit/gateway-identity.test.ts test/integration/gateway-recovery.test.ts test/integration/gateway-rpc.test.ts
```

Expected: tests fail to resolve `@/gateway/identity.js`, `@/gateway/server.js`, or renamed exports.

- [ ] **Step 3: Move files and rename exported service identifiers**

Move files with `git mv` and update their contents:

```bash
git mv src/daemon/server.ts src/gateway/server.ts
git mv src/daemon/identity.ts src/gateway/identity.ts
git mv src/daemon/recovery.ts src/gateway/recovery.ts
git mv src/daemon/json-lines.ts src/gateway/json-lines.ts
git mv test/unit/daemon-identity.test.ts test/unit/gateway-identity.test.ts
git mv test/integration/daemon-recovery.test.ts test/integration/gateway-recovery.test.ts
git mv test/integration/daemon-rpc.test.ts test/integration/gateway-rpc.test.ts
```

Apply these semantic renames:

```text
ShepherdDaemonServerOptions -> ShepherdGatewayServerOptions
ShepherdDaemonServer -> ShepherdGatewayServer
#daemonId -> #gatewayId
options.daemonId -> options.gatewayId
PiHandshakeRecord.daemonId -> PiHandshakeRecord.gatewayId
DaemonRecoveryResult -> GatewayRecoveryResult
recoverDaemonState -> recoverGatewayState
readOrCreateDaemonId -> readOrCreateGatewayId
SHEPHERD_DAEMON_ID -> SHEPHERD_GATEWAY_ID
daemon-id -> gateway-id
```

Use this complete implementation for `src/gateway/identity.ts`:

```ts
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function readOrCreateGatewayId(stateDir: string): string {
  mkdirSync(stateDir, { recursive: true });
  const path = join(stateDir, "gateway-id");
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8").trim();
    if (existing.length > 0) {
      return existing;
    }
  }

  const gatewayId = randomUUID();
  writeFileSync(path, `${gatewayId}\n`, { mode: 0o600 });
  return gatewayId;
}
```

In `src/gateway/recovery.ts`, keep the same recovery logic but rename the function/type and update the message string:

```ts
export type GatewayRecoveryResult = {
  gatewayRuns: GatewayRunRecoveryNote[];
};

export function recoverGatewayState(options: {
  events: EventStore;
  sqlite: DatabaseSync;
}): GatewayRecoveryResult {
  // Same loop as the current implementation.
  // The recovery message must be exactly:
  // "Gateway run was in flight during gateway startup. Shepherd did not replay it automatically."
}
```

In `src/gateway/server.ts`, change the Pi handshake and attach wire results to `gatewayId`:

```ts
type ShepherdGatewayServerOptions = {
  configPath?: string;
  gatewayId?: string;
  // keep the rest of the existing option fields unchanged
};

export type PiHandshakeRecord = {
  attached: boolean;
  extensionVersion: string;
  gatewayId: string;
  mode: "json" | "print" | "rpc" | "tui";
  ownerId: string;
  ownerKind: PiOwnerKind;
  piSessionFile?: string;
  piSessionId?: string;
  sessionId?: string;
};
```

When parsing handshake binding, read `params.binding?.gatewayId`, compare it to `this.#gatewayId`, and write `gatewayId: this.#gatewayId` in `pi.handshake` and `pi.attach` responses.

Also update `stop()` to unlink the socket after the server closes so `gateway stop` and `gateway status` do not observe a stale socket:

```ts
async stop(): Promise<void> {
  for (const socket of this.#sockets) {
    socket.destroy();
  }
  this.#sockets.clear();
  this.#subscriptions.clear();

  await new Promise<void>((resolve, reject) => {
    if (!this.#server.listening) {
      resolve();
      return;
    }

    this.#server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

  if (existsSync(this.#socketPath)) {
    unlinkSync(this.#socketPath);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
pnpm test -- test/unit/gateway-identity.test.ts test/integration/gateway-recovery.test.ts test/integration/gateway-rpc.test.ts test/integration/tui-client.test.ts test/unit/pi-readiness.test.ts test/unit/json-lines.test.ts
```

Expected: all listed tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/gateway src/cli/shepherd.ts src/tui/client.ts src/herdr/socket-client.ts test/unit test/integration
git add -u src/daemon test/unit/daemon-identity.test.ts test/integration/daemon-recovery.test.ts test/integration/daemon-rpc.test.ts
git commit -m "refactor: rename local service internals to gateway"
```

### Task 2: Replace `shepherd daemon` with `shepherd gateway run` and update env parsing

**Objective:** Make the foreground service command `shepherd gateway run` and remove the old top-level `daemon` command.

**Files:**
- Modify: `src/cli/shepherd.ts`
- Modify: `test/unit/cli.test.ts`
- Modify: `src/gateway/pi-readiness.ts`
- Modify: `test/unit/pi-readiness.test.ts`

**Interfaces:**
- Consumes: `ShepherdGatewayServer`, `readOrCreateGatewayId`, `recoverGatewayState` from Task 1.
- Produces: CLI parse result for `gateway run`, gateway-prefixed socket/id env names, help text with gateway commands.

- [ ] **Step 1: Write the failing CLI tests**

Update `test/unit/cli.test.ts` so the first two tests assert `gateway run` parsing:

```ts
test("parses gateway run options", () => {
  expect(
    parseCliArgs([
      "gateway",
      "run",
      "--socket",
      "/tmp/shepherd.sock",
      "--db",
      "/tmp/shepherd.sqlite",
      "--config",
      "/tmp/shepherd.yaml",
    ]),
  ).toEqual({
    command: "gateway",
    action: "run",
    configPath: "/tmp/shepherd.yaml",
    dbPath: "/tmp/shepherd.sqlite",
    socketPath: "/tmp/shepherd.sock",
  });
});

test("uses environment defaults for gateway run options", () => {
  expect(
    parseCliArgs(["gateway", "run"], {
      SHEPHERD_CONFIG: "/tmp/env.yaml",
      SHEPHERD_DB_PATH: "/tmp/env.sqlite",
      SHEPHERD_GATEWAY_SOCKET_PATH: "/tmp/env.sock",
    }),
  ).toEqual({
    command: "gateway",
    action: "run",
    configPath: "/tmp/env.yaml",
    dbPath: "/tmp/env.sqlite",
    socketPath: "/tmp/env.sock",
  });
});

test("rejects old daemon command", () => {
  expect(() => parseCliArgs(["daemon"])).toThrow("Unknown command: daemon");
});
```

Update the help test:

```ts
expect(helpText()).toContain("shepherd gateway start");
expect(helpText()).toContain("shepherd gateway run");
expect(helpText()).not.toContain("shepherd daemon");
```

Update Pi open env test to expect `SHEPHERD_GATEWAY_ID` and `SHEPHERD_GATEWAY_SOCKET_PATH`:

```ts
expect(
  piOpenEnvironment({
    environment: { PATH: "/bin" },
    gatewayId: "gateway-1",
    sessionId: "session-1",
    socketPath: "/tmp/shepherd.sock",
  }),
).toMatchObject({
  PATH: "/bin",
  SHEPHERD_GATEWAY_ID: "gateway-1",
  SHEPHERD_GATEWAY_SOCKET_PATH: "/tmp/shepherd.sock",
  SHEPHERD_SESSION_ID: "session-1",
});
```

In `test/unit/pi-readiness.test.ts`, assert the spawned Pi env key is `SHEPHERD_GATEWAY_SOCKET_PATH` and readiness guidance contains `shepherd gateway start`.

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm test -- test/unit/cli.test.ts test/unit/pi-readiness.test.ts
```

Expected: CLI tests fail because `gateway run` is unknown, old env variables are still used, and guidance still says `shepherd daemon`.

- [ ] **Step 3: Implement foreground gateway parsing and env names**

In `src/cli/shepherd.ts`, replace the daemon command union member with:

```ts
type GatewayAction = "restart" | "run" | "start" | "status" | "stop";

type GatewayRunCommand = {
  action: "run";
  command: "gateway";
  configPath?: string;
  dbPath: string;
  socketPath: string;
};

type GatewayManagedCommand = {
  action: Exclude<GatewayAction, "run">;
  command: "gateway";
  configPath?: string;
  dbPath: string;
  logPath?: string;
  pidPath?: string;
  socketPath: string;
  timeoutMs: number;
};
```

Then make `CliCommand` include `GatewayRunCommand | GatewayManagedCommand` instead of `{ command: "daemon"; ... }`.

Add a parser branch before other command checks:

```ts
if (command === "gateway") {
  const [action = "status", ...gatewayRest] = rest;
  if (!["start", "stop", "restart", "status", "run"].includes(action)) {
    throw new Error(`Unknown gateway action: ${action}`);
  }

  const parsed = parseOptions(gatewayRest);
  const configPath = parsed.config ?? environment.SHEPHERD_CONFIG;
  const base = {
    command: "gateway" as const,
    dbPath: parsed.db ?? environment.SHEPHERD_DB_PATH ?? "shepherd.sqlite",
    socketPath:
      parsed.socket ?? environment.SHEPHERD_GATEWAY_SOCKET_PATH ?? "/tmp/shepherd.sock",
  };

  if (action === "run") {
    return configPath ? { ...base, action, configPath } : { ...base, action };
  }

  return {
    ...base,
    action: action as "restart" | "start" | "status" | "stop",
    ...(configPath ? { configPath } : {}),
    ...(parsed.log ? { logPath: parsed.log } : {}),
    ...(parsed.pid ? { pidPath: parsed.pid } : {}),
    timeoutMs: parsed["timeout-ms"] ? Number(parsed["timeout-ms"]) : 10_000,
  };
}
```

Change existing send/open/watch/rename defaults from `environment.SHEPHERD_SOCKET_PATH` to `environment.SHEPHERD_GATEWAY_SOCKET_PATH`.

In `src/cli/shepherd-tools.ts`, change the default socket env in `parseShepherdToolsArgs` from `environment.SHEPHERD_SOCKET_PATH` to `environment.SHEPHERD_GATEWAY_SOCKET_PATH`, and update its JSON Lines import to `@/gateway/json-lines.js`. In `test/unit/shepherd-tools.test.ts`, change the parser test to:

```ts
expect(parseShepherdToolsArgs([], { SHEPHERD_GATEWAY_SOCKET_PATH: "/tmp/custom.sock" })).toEqual({
  command: "serve",
  socketPath: "/tmp/custom.sock",
});
```

Also rename the test label `bridges JSON Lines stdio frames to the Shepherd daemon client` to `bridges JSON Lines stdio frames to the Shepherd Gateway client`.

Change `piOpenEnvironment` input and output:

```ts
export function piOpenEnvironment(input: {
  environment?: NodeJS.ProcessEnv;
  gatewayId?: string;
  sessionId: string;
  socketPath: string;
}): NodeJS.ProcessEnv {
  return {
    ...(input.environment ?? process.env),
    SHEPHERD_GATEWAY_ID: input.gatewayId ?? "default",
    SHEPHERD_GATEWAY_SOCKET_PATH: input.socketPath,
    SHEPHERD_SESSION_ID: input.sessionId,
  };
}
```

Change `runPiSession` to accept `gatewayId` and pass it to `piOpenEnvironment`.

Update imports from Task 1:

```ts
import { readOrCreateGatewayId } from "@/gateway/identity.js";
import { recoverGatewayState } from "@/gateway/recovery.js";
import { ShepherdGatewayServer } from "@/gateway/server.js";
```

Use `recoverGatewayState`, `ShepherdGatewayServer`, and `gatewayId: readOrCreateGatewayId(stateDir)` in the foreground service path.

- [ ] **Step 4: Update help text and readiness guidance**

Use this command section in `helpText()`:

```text
Usage:
  shepherd gateway start [--socket <path>] [--db <path>] [--config <path>] [--pid <path>] [--log <path>]
  shepherd gateway stop [--socket <path>] [--db <path>] [--pid <path>] [--timeout-ms <ms>]
  shepherd gateway restart [--socket <path>] [--db <path>] [--config <path>] [--pid <path>] [--log <path>] [--timeout-ms <ms>]
  shepherd gateway status [--socket <path>] [--db <path>] [--pid <path>]
  shepherd gateway run [--socket <path>] [--db <path>] [--config <path>]
  shepherd send --session <id> --text <text> [--socket <path>] [--actor <id>] [--display-name <name>] [--provider <name>] [--model <id>]
  shepherd open --session <id> [--socket <path>] [--db <path>]
  shepherd watch --session <id> [--socket <path>] [--after <event-id>]
  shepherd rename --session <id> --title <title> [--socket <path>]
  shepherd audit --session <id> [--db <path>] [--after <event-id>] [--limit <n>] [--json true]

Commands:
  gateway   Manage the local Shepherd Gateway
  send      Send a user message into a Shepherd session
  open      Open the matching Pi session in the Pi TUI
  watch     Print session events as JSON Lines
  rename    Rename a Shepherd session
  audit     Print stored session events from the SQLite audit log
  help      Show this help
```

In `src/gateway/pi-readiness.ts`, replace the setup guidance command with:

```text
Then restart:
  shepherd gateway restart
```

and make spawned Pi env use `SHEPHERD_GATEWAY_SOCKET_PATH`.

- [ ] **Step 5: Run tests to verify they pass**

Run:

```bash
pnpm test -- test/unit/cli.test.ts test/unit/shepherd-tools.test.ts test/unit/pi-readiness.test.ts test/integration/gateway-rpc.test.ts test/integration/tui-client.test.ts
```

Expected: all listed tests pass; `parseCliArgs(["daemon"])` throws `Unknown command: daemon`.

- [ ] **Step 6: Commit**

```bash
git add src/cli/shepherd.ts src/cli/shepherd-tools.ts src/gateway/pi-readiness.ts test/unit/cli.test.ts test/unit/shepherd-tools.test.ts test/unit/pi-readiness.test.ts test/integration/gateway-rpc.test.ts test/integration/tui-client.test.ts
git commit -m "feat: replace daemon command with gateway run"
```

### Task 3: Add `shepherd gateway start/stop/restart/status`

**Objective:** Add the requested service-management commands without reintroducing daemon terminology.

**Files:**
- Create: `src/gateway/process-manager.ts`
- Modify: `src/cli/shepherd.ts`
- Create: `test/unit/gateway-process-manager.test.ts`
- Modify: `test/unit/cli.test.ts`

**Interfaces:**
- Consumes: `gateway run` foreground command from Task 2.
- Produces: detached process management commands with pid/log files and status output.

- [ ] **Step 1: Write failing parser and process-manager tests**

Add parser tests in `test/unit/cli.test.ts`:

```ts
test("parses gateway managed actions", () => {
  expect(
    parseCliArgs([
      "gateway",
      "start",
      "--socket",
      "/tmp/shepherd.sock",
      "--db",
      "/tmp/shepherd.sqlite",
      "--config",
      "/tmp/shepherd.yaml",
      "--pid",
      "/tmp/shepherd.pid",
      "--log",
      "/tmp/shepherd.log",
      "--timeout-ms",
      "2500",
    ]),
  ).toEqual({
    action: "start",
    command: "gateway",
    configPath: "/tmp/shepherd.yaml",
    dbPath: "/tmp/shepherd.sqlite",
    logPath: "/tmp/shepherd.log",
    pidPath: "/tmp/shepherd.pid",
    socketPath: "/tmp/shepherd.sock",
    timeoutMs: 2500,
  });

  expect(parseCliArgs(["gateway", "status"])).toMatchObject({
    action: "status",
    command: "gateway",
  });
});
```

Create `test/unit/gateway-process-manager.test.ts` with fake dependencies for filesystem and process checks. Cover these cases:

1. `resolveGatewayControlPaths({ dbPath: "/tmp/shepherd.sqlite" })` returns pid path `/tmp/shepherd.gateway.pid` and log path `/tmp/shepherd.gateway.log`.
2. `getGatewayStatus` returns `stopped` when no pid file exists.
3. `getGatewayStatus` returns `running` when pid file contains a live process id.
4. `startGatewayProcess` refuses to start when status is already `running`.
5. `stopGatewayProcess` sends `SIGTERM` to the pid and removes a stale pid file after the process disappears.

Expected public types in the test:

```ts
import {
  getGatewayStatus,
  resolveGatewayControlPaths,
  startGatewayProcess,
  stopGatewayProcess,
} from "@/gateway/process-manager.js";
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm test -- test/unit/cli.test.ts test/unit/gateway-process-manager.test.ts
```

Expected: tests fail because `@/gateway/process-manager.js` does not exist and managed actions are not handled by `main()`.

- [ ] **Step 3: Implement process manager**

Create `src/gateway/process-manager.ts` with these exports:

```ts
import { spawn, type ChildProcess } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { dirname, resolve } from "node:path";

export type GatewayControlPaths = {
  logPath: string;
  pidPath: string;
};

export type GatewayStatus =
  | { pidPath: string; socketPath: string; state: "stopped"; stalePid?: number }
  | { pid: number; pidPath: string; socketPath: string; socketReachable: boolean; state: "running" };

export type GatewayProcessDependencies = {
  connectSocket?: (socketPath: string) => Promise<boolean>;
  isProcessRunning?: (pid: number) => boolean;
  killProcess?: (pid: number, signal: NodeJS.Signals) => void;
  spawnProcess?: typeof spawn;
  waitMs?: (ms: number) => Promise<void>;
};

export function resolveGatewayControlPaths(input: {
  dbPath: string;
  logPath?: string;
  pidPath?: string;
}): GatewayControlPaths {
  const stateDir = dirname(resolve(input.dbPath));
  return {
    logPath: input.logPath ?? resolve(stateDir, "shepherd.gateway.log"),
    pidPath: input.pidPath ?? resolve(stateDir, "shepherd.gateway.pid"),
  };
}

export async function getGatewayStatus(input: {
  deps?: GatewayProcessDependencies;
  pidPath: string;
  socketPath: string;
}): Promise<GatewayStatus> {
  const isProcessRunning = input.deps?.isProcessRunning ?? defaultIsProcessRunning;
  const connectSocket = input.deps?.connectSocket ?? defaultConnectSocket;

  if (!existsSync(input.pidPath)) {
    return { pidPath: input.pidPath, socketPath: input.socketPath, state: "stopped" };
  }

  const pid = Number(readFileSync(input.pidPath, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0 || !isProcessRunning(pid)) {
    return { pidPath: input.pidPath, socketPath: input.socketPath, stalePid: pid, state: "stopped" };
  }

  return {
    pid,
    pidPath: input.pidPath,
    socketPath: input.socketPath,
    socketReachable: await connectSocket(input.socketPath),
    state: "running",
  };
}

export async function startGatewayProcess(input: {
  cliPath: string;
  configPath?: string;
  dbPath: string;
  deps?: GatewayProcessDependencies;
  env: NodeJS.ProcessEnv;
  logPath: string;
  nodePath: string;
  pidPath: string;
  socketPath: string;
}): Promise<{ pid: number }> {
  const status = await getGatewayStatus({
    deps: input.deps,
    pidPath: input.pidPath,
    socketPath: input.socketPath,
  });
  if (status.state === "running") {
    throw new Error(`Shepherd Gateway is already running with pid ${status.pid}`);
  }

  mkdirSync(dirname(input.pidPath), { recursive: true });
  mkdirSync(dirname(input.logPath), { recursive: true });
  if (status.state === "stopped" && status.stalePid !== undefined) {
    rmSync(input.pidPath, { force: true });
  }

  const logFd = openSync(input.logPath, "a");
  let child: ChildProcess;
  try {
    const args = [
      input.cliPath,
      "gateway",
      "run",
      "--db",
      input.dbPath,
      "--socket",
      input.socketPath,
      ...(input.configPath ? ["--config", input.configPath] : []),
    ];
    child = (input.deps?.spawnProcess ?? spawn)(input.nodePath, args, {
      detached: true,
      env: input.env,
      stdio: ["ignore", logFd, logFd],
    });
  } finally {
    closeSync(logFd);
  }

  if (!child.pid) {
    throw new Error("Failed to start Shepherd Gateway: child pid was not assigned");
  }

  child.unref();
  writeFileSync(input.pidPath, `${child.pid}\n`, { mode: 0o600 });
  return { pid: child.pid };
}

export async function stopGatewayProcess(input: {
  deps?: GatewayProcessDependencies;
  pidPath: string;
  socketPath: string;
  timeoutMs: number;
}): Promise<{ alreadyStopped: boolean; pid?: number }> {
  const deps = input.deps ?? {};
  const status = await getGatewayStatus({ deps, pidPath: input.pidPath, socketPath: input.socketPath });
  if (status.state === "stopped") {
    rmSync(input.pidPath, { force: true });
    return { alreadyStopped: true };
  }

  const killProcess = deps.killProcess ?? ((pid, signal) => process.kill(pid, signal));
  const isProcessRunning = deps.isProcessRunning ?? defaultIsProcessRunning;
  const waitMs = deps.waitMs ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  killProcess(status.pid, "SIGTERM");
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessRunning(status.pid)) {
      rmSync(input.pidPath, { force: true });
      return { alreadyStopped: false, pid: status.pid };
    }
    await waitMs(50);
  }

  throw new Error(`Timed out waiting for Shepherd Gateway pid ${status.pid} to stop`);
}

function defaultIsProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function defaultConnectSocket(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    const done = (value: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(200, () => done(false));
  });
}
```

If TypeScript complains about `spawnProcess` overloads in tests, narrow the dependency type to a local function signature that returns `Pick<ChildProcess, "pid" | "unref">` and wrap Node's `spawn` in the default implementation.

- [ ] **Step 4: Wire process manager into CLI main**

In `src/cli/shepherd.ts`, import:

```ts
import {
  getGatewayStatus,
  resolveGatewayControlPaths,
  startGatewayProcess,
  stopGatewayProcess,
} from "@/gateway/process-manager.js";
```

In `main()`, before the foreground service setup, handle managed gateway actions:

```ts
if (command.command === "gateway" && command.action !== "run") {
  const paths = resolveGatewayControlPaths({
    dbPath: command.dbPath,
    ...(command.logPath !== undefined ? { logPath: command.logPath } : {}),
    ...(command.pidPath !== undefined ? { pidPath: command.pidPath } : {}),
  });

  if (command.action === "status") {
    const status = await getGatewayStatus({ ...paths, socketPath: command.socketPath });
    console.log(JSON.stringify(status));
    return;
  }

  if (command.action === "stop") {
    const result = await stopGatewayProcess({
      pidPath: paths.pidPath,
      socketPath: command.socketPath,
      timeoutMs: command.timeoutMs,
    });
    console.log(JSON.stringify(result));
    return;
  }

  if (command.action === "restart") {
    await stopGatewayProcess({
      pidPath: paths.pidPath,
      socketPath: command.socketPath,
      timeoutMs: command.timeoutMs,
    });
  }

  const result = await startGatewayProcess({
    cliPath: fileURLToPath(import.meta.url),
    ...(command.configPath !== undefined ? { configPath: command.configPath } : {}),
    dbPath: command.dbPath,
    env,
    logPath: paths.logPath,
    nodePath: process.execPath,
    pidPath: paths.pidPath,
    socketPath: command.socketPath,
  });
  console.log(JSON.stringify({ ...result, logPath: paths.logPath, pidPath: paths.pidPath }));
  return;
}
```

Then ensure the existing foreground service path starts only for `command.command === "gateway" && command.action === "run"`.

- [ ] **Step 5: Run tests to verify they pass**

Run:

```bash
pnpm test -- test/unit/cli.test.ts test/unit/gateway-process-manager.test.ts
```

Expected: parser tests and process manager tests pass.

- [ ] **Step 6: Build and smoke-test the CLI shape**

Run:

```bash
pnpm build
node dist/src/cli/shepherd.js --help
node dist/src/cli/shepherd.js gateway status --db /tmp/shepherd-plan-smoke.sqlite --socket /tmp/shepherd-plan-smoke.sock
```

Expected:
- Help contains `shepherd gateway start`, `stop`, `restart`, `status`, and `run`.
- Status prints JSON with `"state":"stopped"`.

- [ ] **Step 7: Commit**

```bash
git add src/gateway/process-manager.ts src/cli/shepherd.ts test/unit/cli.test.ts test/unit/gateway-process-manager.test.ts
git commit -m "feat: add gateway service management commands"
```

### Task 4: Rename the Pi bridge wire metadata from daemon to gateway

**Objective:** Make the Pi extension, Pi binding entries, and Pi handshake/attach tests use `gatewayId` and Gateway wording.

**Files:**
- Modify: `packages/shepherd-pi/extensions/index.js`
- Modify: `packages/shepherd-pi/package.json`
- Modify: `src/gateway/pi-supervisor.ts`
- Modify: `test/integration/gateway-rpc.test.ts`
- Modify: `test/unit/cli.test.ts`
- Modify: `test/unit/pi-readiness.test.ts`
- Modify: `test/unit/pi-supervisor.test.ts`
- Modify: `src/cli/shepherd.ts`, `src/gateway/server.ts`, `src/gateway/pi-readiness.ts` if any Task 1/2 leftovers remain

**Interfaces:**
- Consumes: `PiHandshakeRecord.gatewayId` and `piOpenEnvironment({ gatewayId })` from Tasks 1 and 2.
- Produces: `shepherd-pi` binding entries shaped as `{ gatewayId, sessionId, socketPath }` and env names `SHEPHERD_GATEWAY_ID`, `SHEPHERD_GATEWAY_SOCKET_PATH`.

- [ ] **Step 1: Write failing Pi bridge assertions**

In `test/integration/gateway-rpc.test.ts`, change the handshake mismatch test so the request binding and response use `gatewayId`:

```ts
client.write(
  encodeJsonLine({
    id: "handshake-1",
    method: "pi.handshake",
    params: {
      binding: { gatewayId: "gateway-other", sessionId: "session-1" },
      extensionVersion: "0.1.0",
      mode: "tui",
    },
  }),
);

expect(response).toMatchObject({
  id: "handshake-1",
  result: expect.objectContaining({ attached: false, gatewayId: "gateway-current" }),
});
```

In the attach test, expect `result.gatewayId`. In `test/unit/pi-readiness.test.ts`, make the fake handshake return `gatewayId: "default"`.

In `test/unit/pi-supervisor.test.ts`, change `SpawnRecord` and `toSpawnRecord` to read `env.SHEPHERD_GATEWAY_SOCKET_PATH` instead of `env.SHEPHERD_SOCKET_PATH`, while keeping `SHEPHERD_SESSION_ID` unchanged.

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm test -- test/integration/gateway-rpc.test.ts test/unit/cli.test.ts test/unit/pi-readiness.test.ts test/unit/pi-supervisor.test.ts
```

Expected: failures mention missing `gatewayId`, still-present `daemonId`, or the old `SHEPHERD_SOCKET_PATH` in the headless Pi supervisor.

- [ ] **Step 3: Update `packages/shepherd-pi/extensions/index.js`**

Apply these exact rename rules in the extension:

```text
ShepherdDaemonClient -> ShepherdGatewayClient
Shepherd daemon client -> Shepherd Gateway client
Shepherd daemon socket -> Shepherd Gateway socket
SHEPHERD_DAEMON_ID -> SHEPHERD_GATEWAY_ID
SHEPHERD_SOCKET_PATH -> SHEPHERD_GATEWAY_SOCKET_PATH
daemonId -> gatewayId
expectedDaemonId -> expectedGatewayId
DEFAULT_SOCKET_PATH remains /tmp/shepherd.sock unless Task 2 changed the default socket path.
```

The environment binding helper must become:

```js
function bindingFromEnvironment() {
  if (!process.env.SHEPHERD_SESSION_ID) return undefined;
  return {
    gatewayId: process.env.SHEPHERD_GATEWAY_ID ?? "default",
    sessionId: process.env.SHEPHERD_SESSION_ID,
    socketPath: process.env.SHEPHERD_GATEWAY_SOCKET_PATH ?? DEFAULT_SOCKET_PATH,
  };
}
```

The binding lookup must compare `entry.data.gatewayId`:

```js
function findBinding(ctx) {
  const entries = ctx.sessionManager.getEntries();
  const expectedGatewayId = process.env.SHEPHERD_GATEWAY_ID;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      entry.type === "custom" &&
      entry.customType === BINDING_ENTRY_TYPE &&
      entry.data?.sessionId
    ) {
      if (expectedGatewayId && entry.data.gatewayId && entry.data.gatewayId !== expectedGatewayId) {
        return undefined;
      }
      return entry.data;
    }
  }
  return undefined;
}
```

When handling `pi.attach`, store:

```js
state.binding = {
  gatewayId: result.gatewayId,
  sessionId,
  socketPath: result.socketPath,
};
```

Update `packages/shepherd-pi/package.json` description to:

```json
"description": "Pi extension bridge for Shepherd Gateway sessions."
```

- [ ] **Step 4: Update headless Pi supervisor env**

In `src/gateway/pi-supervisor.ts`, change the spawned Pi env from:

```ts
SHEPHERD_SOCKET_PATH: this.#socketPath,
```

to:

```ts
SHEPHERD_GATEWAY_SOCKET_PATH: this.#socketPath,
```

Update `test/unit/pi-supervisor.test.ts` so `toSpawnRecord` records `env.SHEPHERD_GATEWAY_SOCKET_PATH`.

- [ ] **Step 5: Run tests and package check**

Run:

```bash
pnpm test -- test/integration/gateway-rpc.test.ts test/unit/cli.test.ts test/unit/pi-readiness.test.ts test/unit/pi-supervisor.test.ts
pnpm pi-package:check
```

Expected: tests pass and the Pi package syntax/pack dry run succeeds.

- [ ] **Step 6: Commit**

```bash
git add packages/shepherd-pi/extensions/index.js packages/shepherd-pi/package.json src/cli/shepherd.ts src/gateway/server.ts src/gateway/pi-readiness.ts src/gateway/pi-supervisor.ts test/integration/gateway-rpc.test.ts test/unit/cli.test.ts test/unit/pi-readiness.test.ts test/unit/pi-supervisor.test.ts
git commit -m "refactor: rename pi bridge identity to gateway"
```

### Task 5: Update README and active plans to the Gateway product model

**Objective:** Make public and active planning docs match the new `Shepherd Gateway` command and vocabulary.

**Files:**
- Modify: `README.md`
- Modify: `README.ja.md`
- Modify: `docs/plans/2026-06-25-pi-runtime-gateway.md`
- Move: `docs/plans/2026-06-25-pi-runtime-gateway/2026-06-25-daemon-pi-supervisor-run-queue.md` -> `docs/plans/2026-06-25-pi-runtime-gateway/2026-06-25-gateway-pi-supervisor-run-queue.md`
- Modify: active child plans under `docs/plans/2026-06-25-pi-runtime-gateway/`

**Interfaces:**
- Consumes: the command and env names implemented in Tasks 2-4.
- Produces: docs with no `daemon` wording outside archived historical plans and this implementation plan.

- [ ] **Step 1: Update README command examples**

In `README.md` and `README.ja.md`, replace:

```bash
export SHEPHERD_SOCKET_PATH=/tmp/shepherd.sock
node dist/src/cli/shepherd.js daemon \
```

with:

```bash
export SHEPHERD_GATEWAY_SOCKET_PATH=/tmp/shepherd.sock
node dist/src/cli/shepherd.js gateway start \
```

Change command examples using `--socket "$SHEPHERD_SOCKET_PATH"` to `--socket "$SHEPHERD_GATEWAY_SOCKET_PATH"`.

Change references as follows:

```text
daemon -> Gateway
running daemon session -> running Gateway session
`shepherd daemon` starts -> `shepherd gateway start` starts
starts the daemon -> starts the Gateway
src/daemon -> src/gateway/server.ts, src/gateway/json-lines.ts, src/gateway/recovery.ts
src/tui daemon socket client -> src/tui Gateway socket client
```

Keep `gateway` config examples unchanged.

- [ ] **Step 2: Update active plans and rename the child plan file**

Move the child plan file:

```bash
git mv docs/plans/2026-06-25-pi-runtime-gateway/2026-06-25-daemon-pi-supervisor-run-queue.md docs/plans/2026-06-25-pi-runtime-gateway/2026-06-25-gateway-pi-supervisor-run-queue.md
```

Update the parent plan link text from `Daemon Pi supervisor and run queue` to `Gateway Pi supervisor and run queue` and update the link target.

In active plans under `docs/plans/2026-06-25-pi-runtime-gateway*`, replace product/service wording:

```text
shepherd daemon -> shepherd gateway start or shepherd gateway run, depending on whether the text describes managed startup or foreground debug startup
daemon startup -> Gateway startup
daemon RPC -> Gateway RPC
daemon socket -> Gateway socket
daemon identity -> Gateway identity
daemonId -> gatewayId
SHEPHERD_DAEMON_ID -> SHEPHERD_GATEWAY_ID
```

Do not edit archived plans under `docs/plans/archived/**`.

- [ ] **Step 3: Run documentation grep checks**

Run:

```bash
rg -n "daemon|Daemon|SHEPHERD_DAEMON|daemonId" README.md README.ja.md packages src test docs/plans/2026-06-25-pi-runtime-gateway.md docs/plans/2026-06-25-pi-runtime-gateway -S
```

Expected: no matches. If matches remain, each must be in this newly created plan file only; the command above does not include this plan file.

- [ ] **Step 4: Commit**

```bash
git add README.md README.ja.md docs/plans/2026-06-25-pi-runtime-gateway.md docs/plans/2026-06-25-pi-runtime-gateway packages/shepherd-pi/package.json
git add -u docs/plans/2026-06-25-pi-runtime-gateway/2026-06-25-daemon-pi-supervisor-run-queue.md
git commit -m "docs: describe shepherd as gateway"
```

### Task 6: Run final rename and behavior validation

**Objective:** Prove that the codebase uses Gateway naming and the requested commands are available.

**Files:**
- Modify only if validation finds missed references from previous tasks.

**Interfaces:**
- Consumes: all previous tasks.
- Produces: final verified implementation ready for review.

- [ ] **Step 1: Run focused tests**

Run:

```bash
pnpm test -- test/unit/cli.test.ts test/unit/shepherd-tools.test.ts test/unit/gateway-process-manager.test.ts test/unit/gateway-identity.test.ts test/integration/gateway-rpc.test.ts test/integration/gateway-recovery.test.ts test/unit/pi-readiness.test.ts test/unit/pi-supervisor.test.ts test/integration/tui-client.test.ts
```

Expected: all listed tests pass.

- [ ] **Step 2: Run full project checks**

Run:

```bash
pnpm check
pnpm build
```

Expected: both commands exit 0.

- [ ] **Step 3: Run command smoke checks against built output**

Run:

```bash
node dist/src/cli/shepherd.js --help
node dist/src/cli/shepherd.js gateway status --db /tmp/shepherd-final-smoke.sqlite --socket /tmp/shepherd-final-smoke.sock
node dist/src/cli/shepherd.js daemon
```

Expected:
- Help includes `shepherd gateway start`, `shepherd gateway stop`, `shepherd gateway restart`, `shepherd gateway status`, and `shepherd gateway run`.
- `gateway status` prints stopped JSON and exits 0.
- `daemon` exits non-zero with `Unknown command: daemon`.

- [ ] **Step 4: Run final no-daemon grep**

Run:

```bash
rg -n "daemon|Daemon|SHEPHERD_DAEMON|daemonId|src/daemon|shepherd daemon" src test packages README.md README.ja.md docs/plans/2026-06-25-pi-runtime-gateway.md docs/plans/2026-06-25-pi-runtime-gateway -S
```

Expected: no output.

Then run:

```bash
find src test -path '*daemon*' -print
```

Expected: no output.

- [ ] **Step 5: Commit any missed-reference fixes**

If Step 4 found missed references and they were fixed:

```bash
git add src test packages README.md README.ja.md docs/plans/2026-06-25-pi-runtime-gateway.md docs/plans/2026-06-25-pi-runtime-gateway
git commit -m "chore: finish gateway naming cleanup"
```

If Step 4 had no misses, do not create an empty commit.

## Validation

- `pnpm test -- test/unit/cli.test.ts test/unit/shepherd-tools.test.ts test/unit/gateway-process-manager.test.ts test/unit/gateway-identity.test.ts test/integration/gateway-rpc.test.ts test/integration/gateway-recovery.test.ts test/unit/pi-readiness.test.ts test/unit/pi-supervisor.test.ts test/integration/tui-client.test.ts` — focused behavior and rename tests pass.
- `pnpm check` — typecheck, Vitest, Biome, Drizzle check, and Pi package check pass.
- `pnpm build` — dist output builds and `tsc-alias` resolves imports.
- `node dist/src/cli/shepherd.js gateway status --db /tmp/shepherd-final-smoke.sqlite --socket /tmp/shepherd-final-smoke.sock` — prints stopped Gateway status JSON.
- `node dist/src/cli/shepherd.js daemon` — exits non-zero with `Unknown command: daemon`.
- `rg -n "daemon|Daemon|SHEPHERD_DAEMON|daemonId|src/daemon|shepherd daemon" src test packages README.md README.ja.md docs/plans/2026-06-25-pi-runtime-gateway.md docs/plans/2026-06-25-pi-runtime-gateway -S` — no output.

## Risks, Tradeoffs, and Open Questions

- Renaming `SHEPHERD_SOCKET_PATH` to `SHEPHERD_GATEWAY_SOCKET_PATH` breaks local shell snippets and Pi bindings, but this is acceptable because Shepherd is unreleased and the user explicitly allowed ignoring compatibility.
- `gateway start` writes a pid file immediately after spawning. If Pi readiness fails quickly, `gateway status` may briefly report a live pid before the child exits; the next status call will mark the pid stale. Waiting for full readiness in `start` would require a readiness RPC or log protocol and is outside this rename.
- The process manager uses POSIX-style pid files and signals. That matches the current Unix socket/Pi/macOS development target. If Windows support becomes a requirement later, the process manager needs a separate implementation.
- Archived plans can keep `daemon` as historical wording. Do not rewrite archived docs as part of this change.
- No DB migration is planned. The existing `gateway_runs` table already uses the target term and remains valid.

## Self Review

- Requirement coverage: The plan covers `shepherd gateway start/stop/restart/status`, removes `shepherd daemon`, and renames internal service concepts to Gateway.
- Specificity: Each step names concrete files, commands, expected results, and required names.
- Naming consistency: The plan consistently uses `Gateway`, `gatewayId`, `SHEPHERD_GATEWAY_ID`, and `SHEPHERD_GATEWAY_SOCKET_PATH` for the service surface.
- Testability: Each task has a failing-test step, pass command, and final validation command.
- Scope control: The plan does not rename `gateway.*` events/RPC or `gateway_runs`, because those already match the desired product term.
