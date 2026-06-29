# Shepherd Runtime Config and CLI Cleanup Implementation Plan

> **For implementers:** Execute this plan task-by-task. Complete each checkbox step, run the listed validation, and commit after each task.

**Goal:** Replace scattered CLI options and `SHEPHERD_*` path environment variables with one `SHEPHERD_HOME`-centered runtime model, optional `runtime:` path settings in `config.yaml`, a simpler positional CLI, and a non-public Gateway service entrypoint.

**Architecture:** Add a shared runtime resolver that derives Shepherd home, config/env paths, and runtime paths before any command connects to the Gateway or opens the DB. Keep `SHEPHERD_HOME` as the only user-facing environment variable; load `$SHEPHERD_HOME/.env` with file values overriding shell values for credentials, while ignoring Shepherd control variables. Move foreground Gateway startup out of the public `shepherd gateway run` command into an internal JS entrypoint spawned by `gateway start`.

**Tech Stack:** TypeScript ESM with NodeNext, TypeBox/Ajv config schema, Vitest, Biome, Node `fs`/`path`/`os` APIs, existing SQLite/JSON Lines Gateway stack.

**Status:** Done

**Progress:**
- Done — runtime resolver, `runtime:` config schema, `.env` loading, invalid-config management fallback, internal Gateway entrypoint, simplified CLI, `shepherd-tools` migration, Pi bridge default, README/README.ja/AGENTS updates, and tests are implemented.
- Verified — `pnpm check`, `pnpm build`, and `SHEPHERD_HOME=/tmp/shepherd-plan-smoke node dist/src/cli/shepherd.js gateway status` passed.

**Next steps:**
- Archived for historical reference.

## Global Constraints

- User-facing environment configuration is limited to `SHEPHERD_HOME`.
- If `SHEPHERD_HOME` is unset, the default home is `~/.shepherd` on all platforms. Windows is not a supported/verified target in this change.
- Default layout:
  - Config: `$SHEPHERD_HOME/config.yaml`
  - Env: `$SHEPHERD_HOME/.env`
  - DB: `$SHEPHERD_HOME/state.db`
  - Socket: `$SHEPHERD_HOME/gateway.sock`
  - PID: `$SHEPHERD_HOME/gateway.pid`
  - Log: `$SHEPHERD_HOME/logs/gateway.log`
  - Runtime record: `$SHEPHERD_HOME/runtime.json`
  - Pi sessions: `$SHEPHERD_HOME/pi-sessions/`
- `config.yaml` may optionally override runtime paths:
  ```yaml
  runtime:
    db_path: state.db
    socket_path: gateway.sock
    pid_path: gateway.pid
    log_path: logs/gateway.log
  ```
- Relative `runtime.*_path` values are resolved relative to `$SHEPHERD_HOME`. Absolute paths remain absolute.
- `$SHEPHERD_HOME/config.yaml` is optional. If absent, commands use default runtime paths and minimal Gateway behavior.
- If `config.yaml` exists and is invalid, normal commands fail. `shepherd gateway status` and `shepherd gateway stop` fall back to `$SHEPHERD_HOME/runtime.json`, then home defaults, and must print a warning to stderr.
- `$SHEPHERD_HOME/.env` values override shell values for non-Shepherd variables. The loader must ignore variables whose names start with `SHEPHERD_`.
- Internal Pi bridge environment variables remain allowed only as process-to-process protocol: `SHEPHERD_SESSION_ID`, `SHEPHERD_GATEWAY_ID`, `SHEPHERD_GATEWAY_SOCKET_PATH`. Users should not need to export them.
- Public CLI path/config/socket/db options are removed. Session/text/title become positional arguments.
- Remove public `shepherd gateway run`. Do not replace it with another public or hidden CLI command. Use an internal JS entrypoint instead.
- Keep changes minimal and compatible with existing TypeScript style. No new runtime dependency is required for `.env` parsing.
- After implementation changes, run `pnpm check`. Because CLI entrypoints and dist import resolution change, also run `pnpm build`.

## Current Context

- `src/cli/shepherd.ts` currently parses per-command `--db`, `--socket`, `--config`, `--pid`, `--log`, `--session`, `--text`, `--title`, `--after`, `--limit`, `--json`, and provider override flags.
- `src/cli/shepherd.ts` currently defaults DB to `shepherd.sqlite` and socket to `/tmp/shepherd.sock` through `SHEPHERD_DB_PATH` and `SHEPHERD_GATEWAY_SOCKET_PATH` fallback.
- `src/gateway/process-manager.ts` currently spawns the main Shepherd CLI as `node <current shepherd CLI path> gateway run` with DB, socket, and config command-line options.
- `src/cli/shepherd-tools.ts` currently accepts `--socket` and falls back to `SHEPHERD_GATEWAY_SOCKET_PATH`.
- `src/db/migrate.ts` currently reads `SHEPHERD_DB_PATH` directly.
- `packages/shepherd-pi/extensions/index.js` currently defaults socket path to `/tmp/shepherd.sock` and reads internal bridge env variables.
- Hermes Agent reference: `HERMES_HOME` is the single home source, `config.yaml` and `.env` live under home, and `.env` is loaded on startup. Shepherd should adopt the home-centered idea but keep stricter config-error behavior for normal commands.

## File Structure

- Create: `src/config/runtime.ts` — resolve `SHEPHERD_HOME`, optional config, runtime paths, home-relative path values, runtime record path, and `.env` overlay.
- Create: `src/gateway/service.ts` — exported Gateway foreground service runner extracted from `src/cli/shepherd.ts`.
- Create: `src/cli/shepherd-gateway.ts` — internal JS entrypoint for the long-running Gateway service; not added to `package.json#bin`.
- Modify: `src/config/schema.ts` — add optional top-level `runtime` schema.
- Modify: `src/config/load.ts` — keep existing config validation; use from runtime resolver.
- Modify: `src/cli/shepherd.ts` — simplify public CLI parser and delegate runtime path resolution.
- Modify: `src/cli/shepherd-tools.ts` — remove `--socket` and resolve socket via shared runtime resolver.
- Modify: `src/gateway/process-manager.ts` — spawn the internal service entrypoint, write runtime record, remove `resolveGatewayControlPaths` default-by-DB behavior.
- Modify: `src/db/migrate.ts` — resolve DB through shared runtime resolver instead of `SHEPHERD_DB_PATH`.
- Modify: `packages/shepherd-pi/extensions/index.js` — update default socket fallback from `/tmp/shepherd.sock` to `$SHEPHERD_HOME/gateway.sock` for direct Pi sessions without a binding.
- Modify: `README.md` — update usage and configuration examples to the new CLI and home/config model.
- Test: `test/unit/config-runtime.test.ts` — runtime resolver, `.env`, config error fallback.
- Test: `test/unit/config-schema.test.ts` and `test/unit/config-loader.test.ts` — `runtime:` schema coverage.
- Test: `test/unit/cli.test.ts` — simplified parser and command execution dependencies.
- Test: `test/unit/gateway-process-manager.test.ts` — internal entrypoint spawn and runtime record behavior.
- Test: `test/unit/shepherd-tools.test.ts` — no-arg resolver behavior.
- Test: `test/unit/pi-readiness.test.ts`, `test/unit/pi-supervisor.test.ts` — internal env still passed.

## Tasks

### Task 1: Add runtime schema and shared runtime resolver

**Objective:** Introduce one place that resolves `$SHEPHERD_HOME`, `$SHEPHERD_HOME/config.yaml`, `$SHEPHERD_HOME/.env`, default runtime paths, optional `runtime:` overrides, and `.env` overlay semantics.

**Files:**
- Create: `src/config/runtime.ts`
- Modify: `src/config/schema.ts`
- Test: `test/unit/config-runtime.test.ts`
- Test: `test/unit/config-schema.test.ts`
- Test: `test/unit/config-loader.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type RuntimePaths = {
    configPath: string;
    dbPath: string;
    envPath: string;
    homeDir: string;
    logPath: string;
    pidPath: string;
    piSessionDir: string;
    runtimeRecordPath: string;
    socketPath: string;
  };

  export type RuntimeResolution = {
    config?: ShepherdConfig;
    configErrors?: ConfigLoadError[];
    configPath: string;
    environment: NodeJS.ProcessEnv;
    homeDir: string;
    paths: RuntimePaths;
  };

  export function getShepherdHome(environment?: NodeJS.ProcessEnv): string;
  export function resolveRuntimePath(homeDir: string, value: string): string;
  export function resolveRuntimePaths(input: {
    config?: ShepherdConfig;
    environment?: NodeJS.ProcessEnv;
  }): RuntimePaths;
  export function loadShepherdDotEnv(input: {
    baseEnvironment?: NodeJS.ProcessEnv;
    envPath: string;
  }): NodeJS.ProcessEnv;
  export function resolveRuntime(input?: {
    allowInvalidConfig?: boolean;
    environment?: NodeJS.ProcessEnv;
  }): RuntimeResolution;
  ```
- Consumes: existing `loadShepherdConfig`, `ShepherdConfig`.

- [ ] **Step 1: Write failing runtime resolver tests**

Create `test/unit/config-runtime.test.ts` with these cases:

1. `getShepherdHome({ HOME: "/Users/test" })` returns `/Users/test/.shepherd` when `SHEPHERD_HOME` is absent.
2. `getShepherdHome({ SHEPHERD_HOME: "/tmp/shepherd-dev" })` returns `/tmp/shepherd-dev`.
3. `resolveRuntime({ environment: { SHEPHERD_HOME: dir } })` returns default paths under `dir`: `config.yaml`, `.env`, `state.db`, `gateway.sock`, `gateway.pid`, `logs/gateway.log`, `runtime.json`, `pi-sessions`.
4. With config file:
   ```yaml
   runtime:
     db_path: data/state.sqlite
     socket_path: sockets/dev.sock
     pid_path: run/dev.pid
     log_path: logs/dev.log
   gateway: {}
   default_agent: implementer
   agents:
     implementer:
       command: codex
   ```
   the resolved paths use `$SHEPHERD_HOME/data/state.sqlite`, `$SHEPHERD_HOME/sockets/dev.sock`, `$SHEPHERD_HOME/run/dev.pid`, `$SHEPHERD_HOME/logs/dev.log`.
5. Absolute runtime paths remain absolute.
6. `loadShepherdDotEnv` overrides shell values from `.env` for `SLACK_BOT_TOKEN`, keeps existing values not mentioned in `.env`, and ignores `SHEPHERD_HOME` / `SHEPHERD_GATEWAY_SOCKET_PATH` in `.env`.
7. Invalid config returns `configErrors` only when `allowInvalidConfig: true`; without it, `resolveRuntime` throws an error containing `Invalid Shepherd config`.

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
pnpm test -- test/unit/config-runtime.test.ts test/unit/config-schema.test.ts test/unit/config-loader.test.ts
```

Expected: `test/unit/config-runtime.test.ts` fails because `src/config/runtime.ts` and `runtime:` schema do not exist.

- [ ] **Step 3: Add `runtime:` schema**

In `src/config/schema.ts`, add a top-level optional runtime object before `platforms`:

```ts
const runtimePathsSchema = Type.Object(
  {
    db_path: Type.Optional(Type.String({ minLength: 1 })),
    log_path: Type.Optional(Type.String({ minLength: 1 })),
    pid_path: Type.Optional(Type.String({ minLength: 1 })),
    socket_path: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);
```

Then add this field to `shepherdConfigSchema`:

```ts
runtime: Type.Optional(runtimePathsSchema),
```

Add schema tests in `test/unit/config-schema.test.ts` that valid config accepts `runtime.db_path`, `runtime.socket_path`, `runtime.pid_path`, `runtime.log_path`, and rejects unknown `runtime.extra`.

- [ ] **Step 4: Implement `src/config/runtime.ts`**

Implement with Node built-ins only:

```ts
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { loadShepherdConfig, type ConfigLoadError } from "@/config/load.js";
import type { ShepherdConfig } from "@/config/schema.js";

export type RuntimePaths = {
  configPath: string;
  dbPath: string;
  envPath: string;
  homeDir: string;
  logPath: string;
  pidPath: string;
  piSessionDir: string;
  runtimeRecordPath: string;
  socketPath: string;
};

export type RuntimeResolution = {
  config?: ShepherdConfig;
  configErrors?: ConfigLoadError[];
  configPath: string;
  environment: NodeJS.ProcessEnv;
  homeDir: string;
  paths: RuntimePaths;
};

export function getShepherdHome(environment: NodeJS.ProcessEnv = process.env): string {
  const explicit = environment.SHEPHERD_HOME?.trim();
  return resolve(explicit && explicit.length > 0 ? explicit : resolve(homedir(), ".shepherd"));
}

export function resolveRuntimePath(homeDir: string, value: string): string {
  return isAbsolute(value) ? value : resolve(homeDir, value);
}

export function resolveRuntimePaths(input: {
  config?: ShepherdConfig;
  environment?: NodeJS.ProcessEnv;
} = {}): RuntimePaths {
  const homeDir = getShepherdHome(input.environment);
  const runtime = input.config?.runtime;
  return {
    homeDir,
    configPath: resolve(homeDir, "config.yaml"),
    envPath: resolve(homeDir, ".env"),
    dbPath: resolveRuntimePath(homeDir, runtime?.db_path ?? "state.db"),
    socketPath: resolveRuntimePath(homeDir, runtime?.socket_path ?? "gateway.sock"),
    pidPath: resolveRuntimePath(homeDir, runtime?.pid_path ?? "gateway.pid"),
    logPath: resolveRuntimePath(homeDir, runtime?.log_path ?? "logs/gateway.log"),
    runtimeRecordPath: resolve(homeDir, "runtime.json"),
    piSessionDir: resolve(homeDir, "pi-sessions"),
  };
}
```

Add a minimal `.env` parser in the same file:

```ts
export function loadShepherdDotEnv(input: {
  baseEnvironment?: NodeJS.ProcessEnv;
  envPath: string;
}): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...(input.baseEnvironment ?? process.env) };
  if (!existsSync(input.envPath)) return next;

  for (const rawLine of readFileSync(input.envPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equalsIndex = line.indexOf("=");
    if (equalsIndex <= 0) continue;
    const key = line.slice(0, equalsIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (key.startsWith("SHEPHERD_")) continue;
    next[key] = unquoteEnvValue(line.slice(equalsIndex + 1).trim());
  }
  return next;
}

function unquoteEnvValue(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
```

Then implement `resolveRuntime`:

```ts
export function resolveRuntime(input: {
  allowInvalidConfig?: boolean;
  environment?: NodeJS.ProcessEnv;
} = {}): RuntimeResolution {
  const initialPaths = resolveRuntimePaths({ environment: input.environment });
  const environment = loadShepherdDotEnv({
    baseEnvironment: input.environment,
    envPath: initialPaths.envPath,
  });
  const basePaths = resolveRuntimePaths({ environment });

  if (!existsSync(basePaths.configPath)) {
    return { configPath: basePaths.configPath, environment, homeDir: basePaths.homeDir, paths: basePaths };
  }

  const loaded = loadShepherdConfig(basePaths.configPath);
  if (!loaded.ok) {
    if (input.allowInvalidConfig) {
      return {
        configErrors: loaded.errors,
        configPath: basePaths.configPath,
        environment,
        homeDir: basePaths.homeDir,
        paths: basePaths,
      };
    }
    throw new Error(`Invalid Shepherd config: ${loaded.errors.map((error) => error.message).join("; ")}`);
  }

  const paths = resolveRuntimePaths({ config: loaded.value, environment });
  return { config: loaded.value, configPath: basePaths.configPath, environment, homeDir: paths.homeDir, paths };
}
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
pnpm test -- test/unit/config-runtime.test.ts test/unit/config-schema.test.ts test/unit/config-loader.test.ts
```

Expected: all listed tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/config/runtime.ts src/config/schema.ts test/unit/config-runtime.test.ts test/unit/config-schema.test.ts test/unit/config-loader.test.ts
git commit -m "feat: add Shepherd runtime path resolver"
```

### Task 2: Add runtime record helpers and safer socket startup

**Objective:** Add runtime record read/write helpers for later `gateway start` integration, and prevent live socket unlinking.

**Files:**
- Modify: `src/gateway/process-manager.ts`
- Test: `test/unit/gateway-process-manager.test.ts`

**Interfaces:**
- Consumes: `RuntimePaths` from Task 1.
- Produces:
  ```ts
  export type GatewayRuntimeRecord = {
    dbPath: string;
    homeDir: string;
    logPath: string;
    pid: number;
    pidPath: string;
    socketPath: string;
    startedAt: string;
    version: 1;
  };

  export function readGatewayRuntimeRecord(path: string): GatewayRuntimeRecord | undefined;
  export function writeGatewayRuntimeRecord(path: string, record: GatewayRuntimeRecord): void;
  export async function prepareGatewaySocketPath(input: { deps?: GatewayProcessDependencies; socketPath: string }): Promise<void>;
  ```

- [ ] **Step 1: Write failing process-manager tests**

Update `test/unit/gateway-process-manager.test.ts`:

1. Replace the old `resolveGatewayControlPaths({ dbPath })` expectation with explicit `RuntimePaths` input once Task 3 wires it. In this task, add tests for runtime record read/write only.
2. Test `writeGatewayRuntimeRecord` writes JSON with mode `0600` and `readGatewayRuntimeRecord` returns the same record.
3. Test `readGatewayRuntimeRecord` returns `undefined` for missing file and invalid JSON.
4. Test `prepareGatewaySocketPath` throws `Shepherd Gateway socket is already reachable` when `connectSocket` returns `true`.
5. Test `prepareGatewaySocketPath` removes an existing stale socket path when `connectSocket` returns `false`.

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
pnpm test -- test/unit/gateway-process-manager.test.ts
```

Expected: tests fail because the new exports do not exist.

- [ ] **Step 3: Implement runtime record and socket preparation**

In `src/gateway/process-manager.ts`:

- Add `unlinkSync` import if not already available through `rmSync`; using `rmSync(path, { force: true })` is acceptable.
- Add `GatewayRuntimeRecord` type.
- Implement `readGatewayRuntimeRecord` with `JSON.parse`, required field checks, and `undefined` on missing/invalid data.
- Implement `writeGatewayRuntimeRecord` with parent directory creation and `writeFileSync(path, json, { mode: 0o600 })`.
- Implement `prepareGatewaySocketPath`:
  ```ts
  export async function prepareGatewaySocketPath(input: {
    deps?: GatewayProcessDependencies;
    socketPath: string;
  }): Promise<void> {
    if (!existsSync(input.socketPath)) return;
    const connectSocket = input.deps?.connectSocket ?? defaultConnectSocket;
    if (await connectSocket(input.socketPath)) {
      throw new Error(`Shepherd Gateway socket is already reachable: ${input.socketPath}`);
    }
    rmSync(input.socketPath, { force: true });
  }
  ```

- [ ] **Step 4: Leave `startGatewayProcess` call sites unchanged in this task**

Do not change the `startGatewayProcess` signature yet. This task should compile after adding only the runtime record helpers and `prepareGatewaySocketPath`. Task 3 changes the spawn entrypoint and wires `writeGatewayRuntimeRecord` into `startGatewayProcess` after the internal entrypoint exists.

- [ ] **Step 5: Run focused tests**

Run:

```bash
pnpm test -- test/unit/gateway-process-manager.test.ts
```

Expected: process-manager tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/gateway/process-manager.ts test/unit/gateway-process-manager.test.ts
git commit -m "feat: record gateway runtime paths"
```

### Task 3: Extract Gateway foreground service into an internal entrypoint

**Objective:** Remove the public `gateway run` execution path from the main CLI and spawn `src/cli/shepherd-gateway.ts` for the long-running service process.

**Files:**
- Create: `src/gateway/service.ts`
- Create: `src/cli/shepherd-gateway.ts`
- Modify: `src/cli/shepherd.ts`
- Modify: `src/gateway/process-manager.ts`
- Test: `test/unit/gateway-process-manager.test.ts`
- Test: `test/unit/cli.test.ts`

**Interfaces:**
- Consumes: `resolveRuntime` from Task 1 and runtime record helpers from Task 2.
- Produces:
  ```ts
  export async function runGatewayService(input?: {
    environment?: NodeJS.ProcessEnv;
  }): Promise<void>;
  ```

- [ ] **Step 1: Write failing tests**

Update `test/unit/cli.test.ts`:

1. `parseCliArgs(["gateway", "run"])` throws `Unknown gateway action: run` or `Unknown gateway action`.
2. `helpText()` does not contain `gateway run`.
3. `helpText()` contains only:
   - `shepherd gateway start`
   - `shepherd gateway stop`
   - `shepherd gateway restart`
   - `shepherd gateway status`

Update `test/unit/gateway-process-manager.test.ts`:

- The spawn expectation should become:
  ```ts
  expect(spawned).toMatchObject([
    {
      command: "/usr/bin/node",
      args: ["/repo/dist/src/cli/shepherd-gateway.js"],
      options: { detached: true },
    },
  ]);
  ```
- Ensure no spawned args include `gateway`, `run`, `--db`, `--socket`, or `--config`.

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
pnpm test -- test/unit/cli.test.ts test/unit/gateway-process-manager.test.ts
```

Expected: tests fail because `gateway run` still exists and process-manager still spawns it.

- [ ] **Step 3: Create `src/gateway/service.ts`**

Move the current foreground Gateway block from `src/cli/shepherd.ts` into `runGatewayService`. The function must:

1. Call `resolveRuntime({ environment })`.
2. Use `runtime.paths.dbPath` instead of `command.dbPath`.
3. Use `runtime.paths.socketPath` instead of `command.socketPath`.
4. Use `runtime.paths.piSessionDir` instead of `resolve(stateDir, "pi-sessions")`.
5. Use `runtime.config` instead of `loadConfigOrThrow(command.configPath)`.
6. Preserve the existing config-absent behavior exactly: when `runtime.config` is `undefined`, create the SQLite stores, `WorkingContextResolver`, `PiSessionMetadataStore`, and `ShepherdGatewayServer`, but leave `gatewayRuntime`, `headlessPi`, `platformRuntime`, `logicalTools`, `providerOverrides`, and Pi readiness checks undefined/disabled. `allowedRoots` should be `[]`, and `allowUnconfiguredLocalPaths` should stay `true`.
7. Use `runtime.environment` when creating platform/gateway providers that accept environment dependencies. If a called factory currently reads `process.env`, set `process.env[key] = value` for values returned by `loadShepherdDotEnv` before constructing runtimes.
8. Call `prepareGatewaySocketPath({ socketPath: runtime.paths.socketPath })` before `server.start()`.
9. Keep shutdown behavior identical: close platform runtime, stop headless Pi, stop server, close gateway runtime, close SQLite.

The service should keep importing existing stores and runtime factories. Remove no behavior except public CLI parsing.

- [ ] **Step 4: Create `src/cli/shepherd-gateway.ts`**

Create an internal executable entrypoint:

```ts
#!/usr/bin/env node
import { argv, exit } from "node:process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runGatewayService } from "@/gateway/service.js";

async function main(): Promise<void> {
  if (argv.length > 2) {
    throw new Error("shepherd-gateway does not accept CLI arguments");
  }
  await runGatewayService();
}

if (fileURLToPath(import.meta.url) === resolve(argv[1] ?? "")) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    exit(1);
  });
}
```

Do not add `shepherd-gateway` to `package.json#bin`.

- [ ] **Step 5: Update `startGatewayProcess`**

Change `startGatewayProcess` to accept `entrypointPath` and spawn:

```ts
const args = [input.entrypointPath];
```

Remove `cliPath`, `configPath`, `dbPath`, and command-line args from this function. Keep detached stdio/log behavior. After the child PID is available and the PID file is written, call `writeGatewayRuntimeRecord(input.runtimeRecordPath, { ...input.runtimeRecord, pid: child.pid, startedAt: new Date().toISOString(), version: 1 })`.

- [ ] **Step 6: Update main CLI to call internal entrypoint**

In `src/cli/shepherd.ts`, remove `GatewayRunCommand`, remove `"run"` from `GatewayAction`, remove the foreground Gateway service block, and update `gateway start/restart` to pass:

```ts
entrypointPath: resolve(dirname(fileURLToPath(import.meta.url)), "shepherd-gateway.js"),
runtimeRecordPath: runtime.paths.runtimeRecordPath,
runtimeRecord: {
  dbPath: runtime.paths.dbPath,
  homeDir: runtime.homeDir,
  logPath: runtime.paths.logPath,
  pidPath: runtime.paths.pidPath,
  socketPath: runtime.paths.socketPath,
},
```

The main CLI should no longer import `ShepherdGatewayServer`, `createGatewayRuntime`, `createPlatformRuntime`, store classes used only by service startup, or `checkPiReadiness` unless still needed elsewhere.

- [ ] **Step 7: Run focused tests**

Run:

```bash
pnpm test -- test/unit/cli.test.ts test/unit/gateway-process-manager.test.ts
pnpm typecheck
```

Expected: focused tests and typecheck pass.

- [ ] **Step 8: Commit**

```bash
git add src/gateway/service.ts src/cli/shepherd-gateway.ts src/cli/shepherd.ts src/gateway/process-manager.ts test/unit/cli.test.ts test/unit/gateway-process-manager.test.ts
git commit -m "refactor: move gateway service to internal entrypoint"
```

### Task 4: Simplify public `shepherd` CLI to positional arguments and runtime resolver

**Objective:** Remove user-facing path/config/session/text/title options and make public commands resolve paths from shared runtime configuration.

**Files:**
- Modify: `src/cli/shepherd.ts`
- Test: `test/unit/cli.test.ts`

**Interfaces:**
- Consumes: `resolveRuntime` from Task 1.
- Produces simplified command shapes:
  ```ts
  export type CliCommand =
    | { action: "restart" | "start" | "status" | "stop"; command: "gateway" }
    | { command: "start-local"; workingContextPath: string }
    | { command: "send"; sessionId: string; text: string }
    | { command: "rename"; sessionId: string; title: string | null }
    | { command: "open"; sessionId: string }
    | { command: "watch"; sessionId: string }
    | { command: "audit"; sessionId: string }
    | { command: "help" };
  ```

- [ ] **Step 1: Write failing parser tests**

Update `test/unit/cli.test.ts` for these exact parses:

```ts
expect(parseCliArgs([])).toEqual({ command: "start-local", workingContextPath: process.cwd() });
expect(parseCliArgs(["gateway"])).toEqual({ command: "gateway", action: "status" });
expect(parseCliArgs(["gateway", "start"])).toEqual({ command: "gateway", action: "start" });
expect(parseCliArgs(["open", "session-1"])).toEqual({ command: "open", sessionId: "session-1" });
expect(parseCliArgs(["send", "session-1", "continue from here"])).toEqual({ command: "send", sessionId: "session-1", text: "continue from here" });
expect(parseCliArgs(["send", "session-1", "continue", "from", "here"])).toEqual({ command: "send", sessionId: "session-1", text: "continue from here" });
expect(parseCliArgs(["rename", "session-1", "Review Slack sync"])).toEqual({ command: "rename", sessionId: "session-1", title: "Review Slack sync" });
expect(parseCliArgs(["rename", "session-1", ""])).toEqual({ command: "rename", sessionId: "session-1", title: null });
expect(parseCliArgs(["watch", "session-1"])).toEqual({ command: "watch", sessionId: "session-1" });
expect(parseCliArgs(["audit", "session-1"])).toEqual({ command: "audit", sessionId: "session-1" });
```

Add rejection tests:

```ts
expect(() => parseCliArgs(["open"])).toThrow("open requires <session-id>");
expect(() => parseCliArgs(["send", "session-1"])).toThrow("send requires <session-id> and <text>");
expect(() => parseCliArgs(["watch", "session-1", "--after", "12"])).toThrow("Invalid argument");
expect(() => parseCliArgs(["audit", "session-1", "--json"])).toThrow("Invalid argument");
expect(() => parseCliArgs(["audit", "session-1", "--limit", "25"])).toThrow("Invalid argument");
expect(() => parseCliArgs(["gateway", "start", "--socket", "/tmp/x.sock"])).toThrow("Invalid argument");
```

- [ ] **Step 2: Run parser tests to verify failure**

Run:

```bash
pnpm test -- test/unit/cli.test.ts
```

Expected: parser tests fail because the old option parser is still active.

- [ ] **Step 3: Replace `parseCliArgs` implementation**

Implement direct positional parsing. Remove `parseOptions` from `src/cli/shepherd.ts` once no longer used. A command with any extra argument not explicitly accepted should throw `Invalid argument: <value>`.

Expected usage text:

```text
Usage:
  shepherd
  shepherd gateway [start|stop|restart|status]
  shepherd open <session-id>
  shepherd send <session-id> <text>
  shepherd watch <session-id>
  shepherd rename <session-id> <title>
  shepherd audit <session-id>
  shepherd help
```

Remove mentions of `--db`, `--socket`, `--config`, `--pid`, `--log`, `--session`, `--text`, `--title`, `--after`, `--limit`, `--json`, `--actor`, `--display-name`, `--provider`, and `--model`.

- [ ] **Step 4: Update command execution to resolve runtime paths**

At the start of `main`, after help handling, call `resolveRuntime`:

- For `gateway status` and `gateway stop`, call `resolveRuntime({ allowInvalidConfig: true })` and use fallback behavior from Task 5.
- For all other commands, call `resolveRuntime()` and fail on invalid config.

Use resolved paths:

- `runLocalPiStartup` receives `dbPath: runtime.paths.dbPath`, `socketPath: runtime.paths.socketPath`, `workingContextPath: process.cwd()`.
- `runOpenPiSession` receives `dbPath` and `socketPath` from runtime.
- `send`, `watch`, `rename` connect to `runtime.paths.socketPath`.
- `audit` opens `runtime.paths.dbPath`, uses `afterEventId = 0`, `limit = 100`, `json = false`.
- `gateway start/restart/status/stop` use `runtime.paths.pidPath`, `runtime.paths.logPath`, `runtime.paths.socketPath`, fixed `timeoutMs = 10_000`.

- [ ] **Step 5: Remove provider one-turn override from CLI**

Delete `actorId`, `displayName`, and `providerOverride` from `CliCommand` and from `send` execution. Keep existing runtime behavior:

```ts
actorId: "tui:user",
presentation: {
  displayName: "TUI User",
  sourcePlatform: "tui",
},
```

Provider selection remains available through config-level defaults and provider overrides, not CLI flags.

- [ ] **Step 6: Run focused tests**

Run:

```bash
pnpm test -- test/unit/cli.test.ts
pnpm typecheck
```

Expected: tests and typecheck pass.

- [ ] **Step 7: Commit**

```bash
git add src/cli/shepherd.ts test/unit/cli.test.ts
git commit -m "feat: simplify shepherd CLI arguments"
```

### Task 5: Implement config-error fallback for `gateway status` and `gateway stop`

**Objective:** Keep strict config validation for normal commands while allowing stop/status to operate when config is broken.

**Files:**
- Modify: `src/cli/shepherd.ts`
- Modify: `src/config/runtime.ts`
- Modify: `src/gateway/process-manager.ts`
- Test: `test/unit/cli.test.ts`
- Test: `test/unit/config-runtime.test.ts`

**Interfaces:**
- Consumes: `readGatewayRuntimeRecord` from Task 2.
- Produces helper:
  ```ts
  export function runtimePathsFromRecordOrDefault(input: {
    environment?: NodeJS.ProcessEnv;
    recordPath?: string;
  }): RuntimePaths;
  ```

- [ ] **Step 1: Write failing fallback tests**

In `test/unit/config-runtime.test.ts`:

1. With invalid `$SHEPHERD_HOME/config.yaml` and valid `$SHEPHERD_HOME/runtime.json`, resolving for management fallback returns record paths and exposes `configErrors`.
2. With invalid config and no runtime record, fallback returns home defaults.

In `test/unit/cli.test.ts`, use injected dependencies or parser-level tests to verify `gatewayStartHint` no longer mentions `--config <path>` and instead says:

```text
Shepherd Gateway is not reachable. Start it with:
  shepherd gateway start
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
pnpm test -- test/unit/config-runtime.test.ts test/unit/cli.test.ts
```

Expected: tests fail until fallback helpers and hint update exist.

- [ ] **Step 3: Implement management fallback**

In `src/config/runtime.ts`, add a function that:

1. Resolves home defaults.
2. If a readable runtime record exists at `$SHEPHERD_HOME/runtime.json`, returns the record's `dbPath`, `socketPath`, `pidPath`, and `logPath` with current home `configPath`, `envPath`, `runtimeRecordPath`, and `piSessionDir`.
3. If no valid record exists, returns home defaults.

In `src/cli/shepherd.ts`, when `resolveRuntime({ allowInvalidConfig: true })` returns `configErrors`, print one warning to stderr for `status` and `stop`:

```text
Warning: Invalid Shepherd config; using last runtime record or home defaults for gateway status/stop.
```

Then use the fallback paths.

- [ ] **Step 4: Update startup hint**

Change `gatewayStartHint` to avoid `SHEPHERD_CONFIG` and `--config`:

```ts
export function gatewayStartHint(): string {
  return "Shepherd Gateway is not reachable. Start it with:\n  shepherd gateway start";
}
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
pnpm test -- test/unit/config-runtime.test.ts test/unit/cli.test.ts
```

Expected: tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/config/runtime.ts src/cli/shepherd.ts src/gateway/process-manager.ts test/unit/config-runtime.test.ts test/unit/cli.test.ts
git commit -m "feat: allow gateway status stop with invalid config"
```

### Task 6: Update `shepherd-tools` and DB migration to use runtime resolver

**Objective:** Remove `--socket` and `SHEPHERD_GATEWAY_SOCKET_PATH` from `shepherd-tools`, and remove `SHEPHERD_DB_PATH` from migration.

**Files:**
- Modify: `src/cli/shepherd-tools.ts`
- Modify: `src/db/migrate.ts`
- Test: `test/unit/shepherd-tools.test.ts`

**Interfaces:**
- Consumes: `resolveRuntime`.
- Produces no new public interface.

- [ ] **Step 1: Write failing tests**

Update `test/unit/shepherd-tools.test.ts`:

```ts
expect(parseShepherdToolsArgs([])).toEqual({ command: "serve" });
expect(parseShepherdToolsArgs(["serve"])).toEqual({ command: "serve" });
expect(parseShepherdToolsArgs(["--socket", "/tmp/shepherd.sock"])).toThrow("Unknown argument: --socket");
expect(shepherdToolsHelpText()).toContain("shepherd-tools [serve]");
expect(shepherdToolsHelpText()).not.toContain("--socket");
```

Adjust `ShepherdToolsCommand` expected shape to `{ command: "serve" } | { command: "help" }`.

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
pnpm test -- test/unit/shepherd-tools.test.ts
```

Expected: tests fail because `--socket` still exists.

- [ ] **Step 3: Update `src/cli/shepherd-tools.ts`**

- Remove `env` import from `node:process` if unused.
- Remove `parseOptions`.
- `parseShepherdToolsArgs` should accept only no args, `serve`, `help`, `--help`, `-h`.
- In `main`, call `resolveRuntime()` and connect to `runtime.paths.socketPath`.

- [ ] **Step 4: Update `src/db/migrate.ts`**

Replace direct `env.SHEPHERD_DB_PATH` with:

```ts
import { resolveRuntime } from "@/config/runtime.js";

const runtime = resolveRuntime();
const { sqlite } = openSqlite(runtime.paths.dbPath);
```

Ensure import style works with existing relative imports. If `@/*` alias is not available in this script under `tsx`, use a relative import from `src/db/migrate.ts` to `../config/runtime.js`.

- [ ] **Step 5: Run focused tests and migration typecheck**

Run:

```bash
pnpm test -- test/unit/shepherd-tools.test.ts
pnpm typecheck
```

Expected: tests and typecheck pass.

- [ ] **Step 6: Commit**

```bash
git add src/cli/shepherd-tools.ts src/db/migrate.ts test/unit/shepherd-tools.test.ts
git commit -m "feat: use runtime resolver for tools and migrations"
```

### Task 7: Update Pi bridge defaults without changing internal attach protocol

**Objective:** Keep internal Pi bridge env variables while moving default socket fallback away from `/tmp/shepherd.sock`.

**Files:**
- Modify: `packages/shepherd-pi/extensions/index.js`
- Modify: `src/cli/shepherd.ts`
- Modify: `src/gateway/pi-readiness.ts`
- Modify: `src/gateway/pi-supervisor.ts`
- Test: `test/unit/pi-readiness.test.ts`
- Test: `test/unit/pi-supervisor.test.ts`
- Test: `test/unit/cli.test.ts`

**Interfaces:**
- Internal env remains:
  - `SHEPHERD_SESSION_ID`
  - `SHEPHERD_GATEWAY_ID`
  - `SHEPHERD_GATEWAY_SOCKET_PATH`

- [ ] **Step 1: Write/adjust tests**

Keep tests that assert `piOpenEnvironment`, `HeadlessPiSupervisor`, and `checkPiReadiness` pass `SHEPHERD_GATEWAY_SOCKET_PATH` to child Pi processes. These env vars are still correct because they are internal process protocol.

Add a unit-like test if a package extension harness exists. If there is no harness, rely on `pnpm pi-package:check` and code inspection for `packages/shepherd-pi/extensions/index.js`.

- [ ] **Step 2: Update package extension default socket**

In `packages/shepherd-pi/extensions/index.js`, replace:

```js
const DEFAULT_SOCKET_PATH = "/tmp/shepherd.sock";
```

with helper functions:

```js
const DEFAULT_HOME_NAME = ".shepherd";

function defaultShepherdHome() {
  return process.env.SHEPHERD_HOME || `${process.env.HOME || ""}/${DEFAULT_HOME_NAME}`;
}

function defaultSocketPath() {
  return `${defaultShepherdHome().replace(/\/$/, "")}/gateway.sock`;
}
```

Then replace uses of `DEFAULT_SOCKET_PATH` with `defaultSocketPath()`.

Do not parse `config.yaml` in the Pi extension. Direct Pi sessions without binding use the home default socket. Sessions launched by Shepherd keep receiving the resolved socket via internal env or binding.

- [ ] **Step 3: Ensure CLI uses resolved socket in internal env**

In `src/cli/shepherd.ts`, ensure `runPiSession` receives `runtime.paths.socketPath` from the caller. `piOpenEnvironment` still sets `SHEPHERD_GATEWAY_SOCKET_PATH` to that resolved path.

- [ ] **Step 4: Run focused checks**

Run:

```bash
pnpm test -- test/unit/cli.test.ts test/unit/pi-readiness.test.ts test/unit/pi-supervisor.test.ts
pnpm pi-package:check
```

Expected: tests pass and package check passes.

- [ ] **Step 5: Commit**

```bash
git add packages/shepherd-pi/extensions/index.js src/cli/shepherd.ts src/gateway/pi-readiness.ts src/gateway/pi-supervisor.ts test/unit/cli.test.ts test/unit/pi-readiness.test.ts test/unit/pi-supervisor.test.ts
git commit -m "feat: align pi bridge with shepherd home defaults"
```

### Task 8: Update README and archived-plan references only where user-facing examples are stale

**Objective:** Make README examples match the new CLI and runtime config model without rewriting unrelated docs.

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes final CLI usage from Tasks 1-7.
- Produces updated user-facing docs.

- [ ] **Step 1: Update configuration section**

Change README to say:

- Shepherd reads `$SHEPHERD_HOME/config.yaml`; default `SHEPHERD_HOME` is `~/.shepherd`.
- Shepherd reads `$SHEPHERD_HOME/.env`; values in this file override shell values for non-`SHEPHERD_*` variables.
- Optional runtime path overrides live under top-level `runtime:`.

Show example:

```yaml
runtime:
  db_path: state.db
  socket_path: gateway.sock
  pid_path: gateway.pid
  log_path: logs/gateway.log

gateway:
  pi:
    idle_timeout_ms: 600000
    readiness_timeout_ms: 10000
```

- [ ] **Step 2: Update usage examples**

Replace command snippets:

```bash
shepherd gateway start
shepherd
shepherd open "$SHEPHERD_SESSION_ID"
shepherd send "$SHEPHERD_SESSION_ID" "continue from here"
shepherd watch "$SHEPHERD_SESSION_ID"
shepherd rename "$SHEPHERD_SESSION_ID" "Review Slack sync"
shepherd audit "$SHEPHERD_SESSION_ID"
shepherd-tools
```

Do not document `SHEPHERD_DB_PATH`, `SHEPHERD_GATEWAY_SOCKET_PATH`, `SHEPHERD_CONFIG`, or `gateway run` as user-facing controls.

- [ ] **Step 3: Run documentation-adjacent checks**

Run:

```bash
rg -n "SHEPHERD_DB_PATH|SHEPHERD_CONFIG|gateway run|--socket|--db|--config|--session|--text|--title|--after|--limit|--json" README.md src/cli test/unit -S
```

Expected: no stale user-facing CLI examples remain. Internal tests may still mention `SHEPHERD_GATEWAY_SOCKET_PATH` only for Pi bridge env assertions.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: update shepherd runtime configuration usage"
```

### Task 9: Final validation and cleanup

**Objective:** Prove the full change works across tests, typecheck, build, lint, and package checks.

**Files:**
- Modify only files needed to fix validation failures caused by this plan.

**Interfaces:**
- Consumes all previous tasks.
- Produces a clean working implementation.

- [ ] **Step 1: Search for removed public surfaces**

Run:

```bash
rg -n "SHEPHERD_DB_PATH|SHEPHERD_CONFIG|gateway run|--socket|--db|--config|--pid|--log|--session|--text|--title|--after|--limit|--json|SHEPHERD_GATEWAY_SOCKET_PATH" src test README.md packages -S
```

Expected:

- No `SHEPHERD_DB_PATH` or `SHEPHERD_CONFIG` in `src`, `test`, or `README.md`.
- No public CLI help/tests/examples for removed flags.
- `SHEPHERD_GATEWAY_SOCKET_PATH` remains only in internal Pi bridge code/tests and `packages/shepherd-pi/extensions/index.js`.

- [ ] **Step 2: Run focused tests**

Run:

```bash
pnpm test -- test/unit/config-runtime.test.ts test/unit/config-schema.test.ts test/unit/config-loader.test.ts test/unit/cli.test.ts test/unit/shepherd-tools.test.ts test/unit/gateway-process-manager.test.ts test/unit/pi-readiness.test.ts test/unit/pi-supervisor.test.ts
```

Expected: all listed tests pass.

- [ ] **Step 3: Run full checks**

Run:

```bash
pnpm check
pnpm build
```

Expected: both commands pass.

- [ ] **Step 4: Optional smoke check after build**

Run with an isolated home:

```bash
SHEPHERD_HOME=/tmp/shepherd-plan-smoke node dist/src/cli/shepherd.js gateway status
```

Expected: JSON status showing `state: "stopped"`, `pidPath` under `/tmp/shepherd-plan-smoke/gateway.pid`, and `socketPath` under `/tmp/shepherd-plan-smoke/gateway.sock`. The command must not create unrelated cwd-local `shepherd.sqlite`.

- [ ] **Step 5: Commit final fixes**

```bash
git add src test packages README.md package.json tsconfig*.json
git commit -m "chore: validate shepherd runtime config cleanup"
```

Only include files that actually changed.

## Validation

- `pnpm test -- test/unit/config-runtime.test.ts test/unit/config-schema.test.ts test/unit/config-loader.test.ts test/unit/cli.test.ts test/unit/shepherd-tools.test.ts test/unit/gateway-process-manager.test.ts test/unit/pi-readiness.test.ts test/unit/pi-supervisor.test.ts` — focused unit coverage passes.
- `pnpm check` — typecheck, tests, Biome, Drizzle check, and Pi package check pass.
- `pnpm build` — TypeScript build and `tsc-alias` import rewriting pass, including the new internal `dist/src/cli/shepherd-gateway.js` entrypoint.
- `SHEPHERD_HOME=/tmp/shepherd-plan-smoke node dist/src/cli/shepherd.js gateway status` — reports stopped status using home-derived pid/socket paths.

## Risks, Tradeoffs, and Open Questions

- Removing CLI path flags means ad-hoc testing must use `SHEPHERD_HOME` or `runtime:` config instead of `--db`/`--socket`. This is intentional for a smaller public surface.
- `SHEPHERD_GATEWAY_SOCKET_PATH` remains in code as internal Pi bridge protocol. Do not document it as a user configuration variable.
- The Pi extension will not parse `config.yaml`; direct Pi launches without Shepherd binding use `$SHEPHERD_HOME/gateway.sock`. Custom `runtime.socket_path` is supported for Pi sessions launched through Shepherd because Shepherd passes the resolved socket internally.
- `.env` values override shell env for non-`SHEPHERD_*` variables. This follows the Hermes-style home/profile reproducibility model, but differs from some dotenv conventions.
- `gateway status` should not create `$SHEPHERD_HOME`. `gateway start`, `shepherd`, and other commands that write state may create required directories with restrictive permissions.
- Windows remains unverified. Use `~/.shepherd` via `os.homedir()` rather than adding partial Windows-native path behavior.
