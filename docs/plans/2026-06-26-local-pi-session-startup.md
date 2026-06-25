# Local Pi Session Startup Implementation Plan

> **For implementers:** Execute this plan task-by-task. Complete each checkbox step, run the listed validation, and commit after each task.

**Goal:** Make `shepherd` with no arguments create a new Shepherd session for the current working directory, ensure a matching Pi session file through the Gateway, and open Pi without successful-path CLI output.

**Architecture:** Keep the Gateway as the owner of Shepherd session state and Pi metadata. The CLI becomes a thin local launcher that calls Gateway RPCs, then spawns `pi --session <file>`. Working contexts are resolved by the Gateway from an explicit `workingContextPath`; Pi and Shepherd session names stay synchronized only through explicit rename paths.

**Tech Stack:** TypeScript ESM with NodeNext, Node.js `node:net`/`node:child_process`, SQLite through `node:sqlite`, Drizzle schema/migrations, Vitest, Biome, and the JavaScript `packages/shepherd-pi` Pi extension.

**Status:** In progress

**Progress:**
- Done — Task 1 changed working context identity to path-first storage and passed `pnpm test -- test/integration/working-contexts.test.ts`.
- Done — Task 2 added `session.create` `workingContextPath`, `pi.ensure_session`, TUI client support, and passed `pnpm check`.
- Done — Task 3 made no-argument `shepherd` launch local Pi sessions through Gateway RPC and moved `open --session` to `pi.ensure_session`; `pnpm check` passed.
- Pending — Tasks 4 through 6 still need implementation and validation.

**Next steps:**
- Start Task 4 by adding explicit Shepherd/Pi session rename synchronization in the Pi extension.
- Commit after each task as listed in the task sections.

## Global Constraints

- Do not add `shepherd new` or `shepherd here` commands.
- `shepherd` with no args creates a new session every time; resume/continue is out of scope.
- `process.cwd()` is the working context path exactly. Do not detect git roots or rewrite the path.
- If `context.allowed_roots` is configured, `workingContextPath` must be inside one allowed root. If no `allowed_roots` are configured, local RPC clients may create a working context for any explicit path.
- The Gateway must not be auto-started. Socket connection failure should show a fixed startup hint.
- Successful `shepherd` no-arg startup prints nothing before Pi takes over stdio.
- Initial Shepherd `title` is `null`; initial Pi session name is unset.
- Do not implement automatic title generation.
- Session name synchronization is explicit only:
  - Shepherd -> Pi: `session.renamed` event sets `pi.setSessionName(title ?? "")`. This uses a string for both named and cleared Shepherd titles.
  - Pi -> Shepherd: `/shepherd rename <title>` in `shepherd-pi` sets Pi session name and calls `session.rename`.
  - External extensions that call `pi.setSessionName()` directly are not synchronized.
- `shepherd open --session <id>` should also require Gateway RPC and use `pi.ensure_session`; do not keep DB direct-write behavior for open.
- Use path-based working context identity: same path reuses one context; same basename at a different path creates a distinct context with a disambiguated slug.
- After implementation changes, run `pnpm check`. If DB schema changes, run `pnpm db:generate` and inspect the generated SQL before `pnpm check`.

## Current Context

- `src/cli/shepherd.ts` currently parses no args as `{ command: "help" }` and `open --session` directly opens SQLite, applies migrations, uses `PiSessionMetadataStore.ensureForSession()`, then spawns `pi --session <file>`.
- `src/tui/client.ts` already has `createSession`, `renameSession`, `subscribe`, `listTools`, and `runTool`, but does not expose `pi.ensure_session`.
- `src/gateway/server.ts` currently handles `session.create`, `session.rename`, `pi.handshake`, `pi.attach`, `pi.heartbeat`, Gateway run queue RPCs, and tool RPCs. It does not handle `workingContextPath` or `pi.ensure_session`.
- `src/gateway/pi-sessions.ts` already has `PiSessionMetadataStore.ensureForSession(sessionId)` and should be reused by the new RPC.
- `src/db/working-contexts.ts` currently deduplicates by slug in `upsert()`, which can incorrectly merge `/repo/api` and `/other/api`.
- `src/db/schema.ts` defines a unique index on `working_contexts.slug` only. Path uniqueness requires a schema change and generated migration.
- `packages/shepherd-pi/extensions/index.js` already subscribes to Shepherd events after `pi.attach`, registers Shepherd tools, and has `/shepherd attach`, `detach`, and status behavior.
- Pi extension docs confirm `pi.setSessionName(name)` and `pi.getSessionName()` exist; there is no documented session-name-changed event.

## File Structure

- Modify: `src/db/schema.ts` — add a unique index for `working_contexts.path`.
- Modify: `src/db/working-contexts.ts` — add path lookup and slug disambiguation; make upsert path-first.
- Modify: `src/gateway/working-contexts.ts` — support the local path rule for Gateway `session.create` while keeping scan behavior tied to configured roots.
- Modify: `src/gateway/server.ts` — support `workingContextPath` in `session.create`; add `pi.ensure_session`; publish `session.renamed` reliably to subscribers.
- Modify: `src/tui/client.ts` — add typed inputs/results for `workingContextPath` and `ensurePiSession`.
- Modify: `src/cli/shepherd.ts` — parse no args as a local Pi startup command; route no-arg startup and `open --session` through Gateway RPCs; emit Gateway-start hint on connection failure.
- Modify: `packages/shepherd-pi/extensions/index.js` — add `/shepherd rename`, react to `session.renamed`, and keep existing attach/queue behavior.
- Modify: `README.md` and `README.ja.md` — document `shepherd` no-arg startup and Gateway-first requirement.
- Generate: `drizzle/0004_*.sql` and `drizzle/meta/0004_snapshot.json` — migration for `working_contexts.path` uniqueness.
- Test: `test/integration/working-contexts.test.ts` — path identity and slug collision behavior.
- Test: `test/integration/gateway-rpc.test.ts` — `session.create` with `workingContextPath`, `pi.ensure_session`, and rename event behavior.
- Test: `test/integration/tui-client.test.ts` — typed client methods.
- Test: `test/unit/cli.test.ts` — no-arg parsing, open parsing, Gateway hint, and Pi spawn argument construction.
- Test: add `test/unit/shepherd-pi-extension.test.js` only if the project already has a JS extension test harness by implementation time. If no harness exists, validate the extension by `pnpm pi-package:check` and targeted manual review in this plan's final validation.

## Tasks

### Task 1: Make working contexts path-first and migration-backed

**Objective:** Prevent two different directories with the same basename from sharing one working context.

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/db/working-contexts.ts`
- Test: `test/integration/working-contexts.test.ts`
- Generate: `drizzle/0004_*.sql`, `drizzle/meta/0004_snapshot.json`, `drizzle/meta/_journal.json`

**Interfaces:**
- Produces: `WorkingContextStore.findByPath(path: string): WorkingContextRecord | undefined`
- Produces: `WorkingContextStore.upsert(input)` reuses by resolved path first and disambiguates slug collisions for different paths.
- Consumed by: Task 2 Gateway local session creation.

- [ ] **Step 1: Write the failing tests**

Add these cases to `test/integration/working-contexts.test.ts`:

```ts
test("reuses working contexts by resolved path", () => {
  const { root, store } = openHarness();
  const project = join(root, "api");
  mkdirSync(project);
  const resolver = new WorkingContextResolver({ allowedRoots: [root], store });

  const first = resolver.resolve({ path: project });
  const second = resolver.resolve({ label: "Different Label", path: project });

  expect(second.id).toBe(first.id);
  expect(second.path).toBe(project);
});

test("keeps same basename projects as distinct working contexts", () => {
  const { root, store } = openHarness();
  const firstProject = join(root, "team-a", "api");
  const secondProject = join(root, "team-b", "api");
  mkdirSync(firstProject, { recursive: true });
  mkdirSync(secondProject, { recursive: true });
  const resolver = new WorkingContextResolver({ allowedRoots: [root], store });

  const first = resolver.resolve({ path: firstProject });
  const second = resolver.resolve({ path: secondProject });

  expect(second.id).not.toBe(first.id);
  expect(second.path).toBe(secondProject);
  expect(second.slug).not.toBe(first.slug);
  expect(second.slug.startsWith("api")).toBe(true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- test/integration/working-contexts.test.ts`

Expected: the same-path test fails because `upsert()` updates by slug and may overwrite label/path, and the same-basename test fails because both paths resolve to slug `api`.

- [ ] **Step 3: Update schema**

In `src/db/schema.ts`, change the `workingContexts` index list from one index to two:

```ts
(table) => [
  uniqueIndex("working_contexts_slug_idx").on(table.slug),
  uniqueIndex("working_contexts_path_idx").on(table.path),
],
```

Run migration generation:

```bash
pnpm db:generate
```

Expected: a new `drizzle/0004_*.sql` is created with a unique index on `working_contexts.path`, and `drizzle/meta/_journal.json` plus a `0004_snapshot.json` are updated.

Inspect the generated SQL. It must create an index equivalent to:

```sql
CREATE UNIQUE INDEX `working_contexts_path_idx` ON `working_contexts` (`path`);
```

- [ ] **Step 4: Implement path-first working context storage**

In `src/db/working-contexts.ts`, add `findByPath`, `findBySlug` reuse helpers, and a deterministic slug allocator. The implementation must resolve input paths before lookup.

Use this structure:

```ts
  findByPath(path: string): WorkingContextRecord | undefined {
    const resolvedPath = resolve(path);
    const row = this.#sqlite.prepare("select * from working_contexts where path = ?").get(resolvedPath) as
      | WorkingContextRow
      | undefined;

    return row ? mapWorkingContext(row) : undefined;
  }
```

Rewrite `upsert(input)` so it:

1. Resolves `input.path`.
2. Looks up `existingByPath`.
3. Uses `input.slug` when provided; otherwise computes `slugifyHerdrName(label)`.
4. If there is no path match and the desired slug belongs to a different path, appends a short deterministic suffix derived from the new record id. Use a helper such as `disambiguateSlug(baseSlug, id)` that returns `${baseSlug}-${id.slice(0, 8)}`.
5. Inserts with `on conflict(path) do update`, not `on conflict(slug)`.
6. Returns `this.findByPath(path)`.

The code path must keep existing path records stable: do not change their `id` when the label changes.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test -- test/integration/working-contexts.test.ts`

Expected: all working context integration tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.ts src/db/working-contexts.ts test/integration/working-contexts.test.ts drizzle
git commit -m "db: make working contexts path based"
```

### Task 2: Extend Gateway RPC for local session creation and Pi session metadata

**Objective:** Let the Gateway create sessions for explicit local paths and ensure Pi metadata without CLI DB writes.

**Files:**
- Modify: `src/gateway/server.ts`
- Modify: `src/gateway/working-contexts.ts`
- Modify: `src/tui/client.ts`
- Test: `test/integration/gateway-rpc.test.ts`
- Test: `test/integration/tui-client.test.ts`
- Test: `test/integration/working-contexts.test.ts`

**Interfaces:**
- Extends: `session.create` params with `workingContextPath?: string`.
- Adds RPC: `pi.ensure_session` with input `{ sessionId: string }` and output `{ pi: PiSessionMetadata }`.
- Adds client method: `ensurePiSession(input: { sessionId: string }): Promise<{ pi: PiSessionMetadata }>`.

- [ ] **Step 1: Write failing Gateway RPC tests**

In `test/integration/gateway-rpc.test.ts`, add server harness options:

```ts
allowedRoots?: string[];
enableLocalWorkingContexts?: boolean;
enablePiSessionStore?: boolean;
```

When `enableLocalWorkingContexts` is true, the harness must pass a real `WorkingContextResolver` backed by `new WorkingContextStore(sqlite)` to `ShepherdGatewayServer`. When `allowedRoots` is omitted, pass `allowedRoots: []` and `allowUnconfiguredLocalPaths: true`. When `enablePiSessionStore` is true, the harness must pass `new PiSessionMetadataStore({ events: store, sessionDir: join(dir, "pi-sessions") })` to `ShepherdGatewayServer`.

Add a test for `session.create` path resolution inside configured roots:

```ts
test("creates sessions with a local working context path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-local-context-"));
  tempDirs.push(dir);
  const project = join(dir, "project");
  mkdirSync(project);
  const { server, socketPath, store } = await openServer({
    allowedRoots: [dir],
    enableLocalWorkingContexts: true,
  });
  servers.push(server);
  const client = await connect(socketPath);

  client.write(
    encodeJsonLine({
      id: "create-local-1",
      method: "session.create",
      params: { workingContextPath: project, title: null },
    }),
  );

  const [response] = await readMessages(client, 1);
  expect(response).toMatchObject({
    id: "create-local-1",
    result: {
      session: {
        title: null,
      },
    },
  });
  const sessionId = (response as { result: { session: { id: string; workingContextId: string } } }).result.session.id;
  expect(store.getSession(sessionId).workingContextId).toBeTruthy();
});
```

Add a test for the no-`allowed_roots` local rule:

```ts
test("creates local working contexts when allowed roots are unconfigured", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-local-context-"));
  tempDirs.push(dir);
  const project = join(dir, "unconfigured-project");
  mkdirSync(project);
  const { server, socketPath, store } = await openServer({ enableLocalWorkingContexts: true });
  servers.push(server);
  const client = await connect(socketPath);

  client.write(
    encodeJsonLine({
      id: "create-local-unconfigured-1",
      method: "session.create",
      params: { workingContextPath: project },
    }),
  );

  const [response] = await readMessages(client, 1);
  const session = (response as { result: { session: { id: string; workingContextId: string | null } } }).result.session;
  expect(session.workingContextId).toEqual(expect.any(String));
  expect(store.getSession(session.id).workingContextId).toBe(session.workingContextId);
});
```

Add a rejection test:

```ts
test("rejects local working context paths outside configured allowed roots", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-local-context-"));
  tempDirs.push(dir);
  const outside = join(dir, "outside");
  mkdirSync(outside);
  const { server, socketPath } = await openServer({
    allowedRoots: [join(dir, "allowed")],
    enableLocalWorkingContexts: true,
  });
  servers.push(server);
  const client = await connect(socketPath);

  client.write(
    encodeJsonLine({
      id: "create-local-denied-1",
      method: "session.create",
      params: { workingContextPath: outside },
    }),
  );

  await expect(readMessages(client, 1)).resolves.toMatchObject([
    { error: { message: expect.stringContaining("outside allowed roots") }, id: "create-local-denied-1" },
  ]);
});
```

Add a `pi.ensure_session` test:

```ts
test("ensures Pi metadata for an existing session", async () => {
  const { server, socketPath, store } = await openServer({ enablePiSessionStore: true });
  servers.push(server);
  const session = store.createSession({ id: "session-1" });
  const client = await connect(socketPath);

  client.write(
    encodeJsonLine({
      id: "pi-ensure-1",
      method: "pi.ensure_session",
      params: { sessionId: session.id },
    }),
  );

  const [response] = await readMessages(client, 1);
  expect(response).toMatchObject({
    id: "pi-ensure-1",
    result: {
      pi: {
        sessionFile: expect.stringContaining("session-1.jsonl"),
        sessionId: expect.any(String),
      },
    },
  });
  expect(store.getSession(session.id).metadata.pi).toMatchObject(
    (response as { result: { pi: unknown } }).result.pi,
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- test/integration/gateway-rpc.test.ts`

Expected: tests fail because `workingContextPath`, local resolver wiring, the no-`allowed_roots` local rule, and `pi.ensure_session` do not exist.

- [ ] **Step 3: Add explicit local working context resolver behavior**

In `src/gateway/working-contexts.ts`, extend `WorkingContextResolverOptions` with an explicit local-startup override:

```ts
export type WorkingContextResolverOptions = {
  allowedRoots?: readonly string[];
  allowUnconfiguredLocalPaths?: boolean;
  store: WorkingContextStore;
};
```

Store it in a private field:

```ts
readonly #allowUnconfiguredLocalPaths: boolean;
```

Set it in the constructor:

```ts
this.#allowUnconfiguredLocalPaths = options.allowUnconfiguredLocalPaths ?? false;
```

Update `#assertAllowed(path)` to keep scan/discovery unchanged while allowing explicit local paths only when no roots are configured:

```ts
#assertAllowed(path: string): void {
  if (this.#allowedRoots.length === 0) {
    if (this.#allowUnconfiguredLocalPaths) {
      return;
    }
    throw new Error("No working context allowed roots are configured");
  }

  if (!this.#allowedRoots.some((root) => isInsideOrEqual(root, path))) {
    throw new Error(`Working context path is outside allowed roots: ${path}`);
  }
}
```

Do not change `discover({ scanAllowedRoots: true })`: with no allowed roots it still scans no directories and returns an empty candidate list.

- [ ] **Step 4: Add server dependencies**

In `src/gateway/server.ts`, extend `ShepherdGatewayServerOptions` with optional local-context and Pi metadata dependencies:

```ts
type LocalWorkingContextResolver = {
  resolve(input: { label?: string; path?: string; slug?: string }): { id: string };
};

type PiSessionMetadataService = {
  ensureForSession(sessionId: string): NonNullable<SessionMetadata["pi"]>;
};
```

Add private fields:

```ts
readonly #localWorkingContexts: LocalWorkingContextResolver | undefined;
readonly #piSessions: PiSessionMetadataService | undefined;
```

Set them in the constructor from `options.localWorkingContexts` and `options.piSessions`.

- [ ] **Step 5: Implement `workingContextPath` in `session.create`**

Update `#createSession` params to include `workingContextPath?: unknown`.

Validation rules:

- If `workingContextPath` is present and is not a non-empty string, return error `workingContextPath must be a string`.
- If `workingContextPath` is present and `#localWorkingContexts` is undefined, return error `Local working context resolver is not configured`.
- Resolve context before `createSession()` and pass `workingContextId`.
- Keep existing `workingContextId` support. If both `workingContextId` and `workingContextPath` are present, return error `workingContextId and workingContextPath are mutually exclusive`.

Use this flow:

```ts
let workingContextId = typeof params?.workingContextId === "string" ? params.workingContextId : undefined;
if (typeof params?.workingContextPath === "string") {
  if (workingContextId !== undefined) {
    this.#write(socket, { error: { message: "workingContextId and workingContextPath are mutually exclusive" }, id: request.id });
    return;
  }
  if (!this.#localWorkingContexts) {
    this.#write(socket, { error: { message: "Local working context resolver is not configured" }, id: request.id });
    return;
  }
  workingContextId = this.#localWorkingContexts.resolve({ path: params.workingContextPath }).id;
}
```

Wrap resolver errors and return them as RPC errors with the original message.

- [ ] **Step 6: Implement `pi.ensure_session` RPC**

In `#handleMessage`, add:

```ts
if (request.method === "pi.ensure_session") {
  this.#ensurePiSession(socket, request);
  return;
}
```

Implement:

```ts
#ensurePiSession(socket: Socket, request: RpcRequest): void {
  const params = request.params as { sessionId?: unknown };
  if (typeof params?.sessionId !== "string") {
    this.#write(socket, { error: { message: "sessionId is required" }, id: request.id });
    return;
  }
  if (!this.#piSessions) {
    this.#write(socket, { error: { message: "Pi session metadata store is not configured" }, id: request.id });
    return;
  }

  try {
    const pi = this.#piSessions.ensureForSession(params.sessionId);
    this.#write(socket, { id: request.id, result: { pi } });
  } catch (error) {
    this.#write(socket, {
      error: { message: error instanceof Error ? error.message : String(error) },
      id: request.id,
    });
  }
}
```

- [ ] **Step 7: Wire production runtime dependencies**

In `src/cli/shepherd.ts`, where `ShepherdGatewayServer` is constructed for `gateway run`, create one `WorkingContextResolver` and one `PiSessionMetadataStore` for the server regardless of whether a config file was provided:

```ts
const workingContexts = new WorkingContextResolver({
  allowedRoots: config?.context?.allowed_roots ?? [],
  allowUnconfiguredLocalPaths: true,
  store: new WorkingContextStore(sqlite),
});
const piSessions = new PiSessionMetadataStore({
  events,
  sessionDir: resolve(stateDir, "pi-sessions"),
});
```

This preserves the requirement that `allowed_roots` is enforced when configured and explicit local paths are allowed when no roots are configured. Pass both to `new ShepherdGatewayServer({ localWorkingContexts: workingContexts, piSessions, ... })`.

- [ ] **Step 8: Update typed TUI client**

In `src/tui/client.ts`:

- Add `workingContextPath?: string` to `CreateSessionInput`.
- Add a `PiSessionWireRecord` type equal to `SessionMetadata["pi"]` non-null.
- Add:

```ts
async ensurePiSession(input: { sessionId: string }): Promise<{ pi: PiSessionWireRecord }> {
  return (await this.#request("pi.ensure_session", input)) as { pi: PiSessionWireRecord };
}
```

Add integration tests in `test/integration/tui-client.test.ts` for `createSession({ workingContextPath })` and `ensurePiSession()`.

- [ ] **Step 9: Run tests to verify they pass**

Run: `pnpm test -- test/integration/gateway-rpc.test.ts test/integration/tui-client.test.ts test/integration/working-contexts.test.ts`

Expected: all listed tests pass.

- [ ] **Step 10: Commit**

```bash
git add src/gateway/server.ts src/gateway/working-contexts.ts src/tui/client.ts src/cli/shepherd.ts test/integration/gateway-rpc.test.ts test/integration/tui-client.test.ts test/integration/working-contexts.test.ts
git commit -m "gateway: create local sessions through rpc"
```

### Task 3: Implement no-argument CLI startup and Gateway-first `open`

**Objective:** Make `shepherd` with no args create a local session through Gateway RPC and open Pi; make `open --session` use `pi.ensure_session`.

**Files:**
- Modify: `src/cli/shepherd.ts`
- Test: `test/unit/cli.test.ts`

**Interfaces:**
- Adds CLI command variant `{ command: "start-local"; dbPath: string; socketPath: string; workingContextPath: string }`.
- Reuses `runPiSession`, `piOpenArgs`, and `piOpenEnvironment`.
- Adds exported helper `gatewayStartHint(environment?: NodeJS.ProcessEnv): string`.
- Adds exported helper `runLocalPiStartup(input)` and `runOpenPiSession(input)` so unit tests can verify RPC calls and spawn arguments without launching real Pi.

- [ ] **Step 1: Write failing CLI parser tests**

In `test/unit/cli.test.ts`, add:

```ts
test("parses no args as local Pi startup", () => {
  expect(
    parseCliArgs([], {
      SHEPHERD_DB_PATH: "/tmp/shepherd.sqlite",
      SHEPHERD_GATEWAY_SOCKET_PATH: "/tmp/shepherd.sock",
      PWD: "/repo/shepherd",
    }),
  ).toEqual({
    command: "start-local",
    dbPath: "/tmp/shepherd.sqlite",
    socketPath: "/tmp/shepherd.sock",
    workingContextPath: process.cwd(),
  });
});
```

Do not use `environment.PWD` for behavior unless the implementation already trusts it. The expected `workingContextPath` should be `process.cwd()` because the requirement is `process.cwd()` exactly.

Update existing help test to assert `parseCliArgs(["--help"])` still returns `{ command: "help" }`.

Add a test for `open` no longer requiring `dbPath` in its command type if you remove it from the parser output. If you keep `dbPath` only for `readOrCreateGatewayId` in `piOpenEnvironment`, assert the command still parses but is not used for metadata writes.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- test/unit/cli.test.ts`

Expected: no-arg parser currently returns help.

- [ ] **Step 3: Extend CLI command model**

In `src/cli/shepherd.ts`, add a `start-local` command variant:

```ts
| {
    command: "start-local";
    dbPath: string;
    socketPath: string;
    workingContextPath: string;
  }
```

Change `parseCliArgs`:

```ts
if (!command) {
  return {
    command: "start-local",
    dbPath: environment.SHEPHERD_DB_PATH ?? "shepherd.sqlite",
    socketPath: environment.SHEPHERD_GATEWAY_SOCKET_PATH ?? "/tmp/shepherd.sock",
    workingContextPath: process.cwd(),
  };
}

if (command === "--help" || command === "-h" || command === "help") {
  return { command: "help" };
}
```

Keep all existing explicit commands.

- [ ] **Step 4: Add Gateway connection error hint and exported runner helpers**

Add this exported helper. It always prints the same command shape and substitutes only the config argument value:

```ts
export function gatewayStartHint(environment: NodeJS.ProcessEnv = env): string {
  return `Shepherd Gateway is not reachable. Start the Gateway first:\n  shepherd gateway start --config ${environment.SHEPHERD_CONFIG ?? "<path>"}`;
}
```

Add testable runner dependency types near the CLI helpers:

```ts
type ShepherdClientLike = Pick<ShepherdSessionClient, "close" | "createSession" | "ensurePiSession">;

type LocalPiStartupDeps = {
  connect(socketPath: string): Promise<ShepherdClientLike>;
  readGatewayId(stateDir: string): string;
  runPi(input: {
    gatewayId: string;
    piSessionFile: string;
    sessionId: string;
    socketPath: string;
  }): Promise<number>;
};
```

Add a typed connection error so RPC errors are not collapsed into the Gateway-start hint:

```ts
export class GatewayConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayConnectionError";
  }
}
```

Add `defaultLocalPiStartupDeps`:

```ts
const defaultLocalPiStartupDeps: LocalPiStartupDeps = {
  async connect(socketPath) {
    try {
      return await ShepherdSessionClient.connect(socketPath);
    } catch (error) {
      throw new GatewayConnectionError(error instanceof Error ? error.message : String(error));
    }
  },
  readGatewayId: (stateDir) => readOrCreateGatewayId(stateDir),
  runPi: (input) => runPiSession(input),
};
```

Add exported helpers:

```ts
export async function runLocalPiStartup(
  command: Extract<CliCommand, { command: "start-local" }>,
  deps: LocalPiStartupDeps = defaultLocalPiStartupDeps,
): Promise<number> {
  const stateDir = dirname(resolve(command.dbPath));
  const client = await deps.connect(command.socketPath);
  try {
    const { session } = await client.createSession({
      title: null,
      workingContextPath: command.workingContextPath,
    });
    const { pi } = await client.ensurePiSession({ sessionId: session.id });
    return await deps.runPi({
      gatewayId: deps.readGatewayId(stateDir),
      piSessionFile: pi.sessionFile,
      sessionId: session.id,
      socketPath: command.socketPath,
    });
  } finally {
    await client.close();
  }
}

export async function runOpenPiSession(
  command: Extract<CliCommand, { command: "open" }>,
  deps: LocalPiStartupDeps = defaultLocalPiStartupDeps,
): Promise<number> {
  const stateDir = dirname(resolve(command.dbPath));
  const client = await deps.connect(command.socketPath);
  try {
    const { pi } = await client.ensurePiSession({ sessionId: command.sessionId });
    return await deps.runPi({
      gatewayId: deps.readGatewayId(stateDir),
      piSessionFile: pi.sessionFile,
      sessionId: command.sessionId,
      socketPath: command.socketPath,
    });
  } finally {
    await client.close();
  }
}
```

- [ ] **Step 5: Write failing runner tests**

In `test/unit/cli.test.ts`, import `GatewayConnectionError`, `gatewayStartHint`, `runLocalPiStartup`, and `runOpenPiSession`.

Add a test that proves no-arg startup calls Gateway RPCs and Pi spawn dependency without printing success output:

```ts
test("local startup creates a session, ensures Pi metadata, and runs Pi", async () => {
  const calls: unknown[] = [];
  const client = {
    async close() {
      calls.push(["close"]);
    },
    async createSession(input: unknown) {
      calls.push(["createSession", input]);
      return { session: { id: "session-1" } };
    },
    async ensurePiSession(input: unknown) {
      calls.push(["ensurePiSession", input]);
      return { pi: { sessionFile: "/tmp/pi-session.jsonl", sessionId: "pi-1" } };
    },
  };

  await expect(
    runLocalPiStartup(
      {
        command: "start-local",
        dbPath: "/tmp/state/shepherd.sqlite",
        socketPath: "/tmp/shepherd.sock",
        workingContextPath: "/repo/app",
      },
      {
        async connect(socketPath) {
          calls.push(["connect", socketPath]);
          return client;
        },
        readGatewayId(stateDir) {
          calls.push(["readGatewayId", stateDir]);
          return "gateway-1";
        },
        async runPi(input) {
          calls.push(["runPi", input]);
          return 0;
        },
      },
    ),
  ).resolves.toBe(0);

  expect(calls).toEqual([
    ["connect", "/tmp/shepherd.sock"],
    ["createSession", { title: null, workingContextPath: "/repo/app" }],
    ["ensurePiSession", { sessionId: "session-1" }],
    ["readGatewayId", "/tmp/state"],
    [
      "runPi",
      {
        gatewayId: "gateway-1",
        piSessionFile: "/tmp/pi-session.jsonl",
        sessionId: "session-1",
        socketPath: "/tmp/shepherd.sock",
      },
    ],
    ["close"],
  ]);
});
```

Add a test that proves `open --session` only ensures Pi metadata and runs Pi:

```ts
test("open uses Gateway pi.ensure_session instead of DB metadata writes", async () => {
  const calls: unknown[] = [];
  const client = {
    async close() {
      calls.push(["close"]);
    },
    async createSession() {
      throw new Error("createSession must not be called by open");
    },
    async ensurePiSession(input: unknown) {
      calls.push(["ensurePiSession", input]);
      return { pi: { sessionFile: "/tmp/pi-session.jsonl", sessionId: "pi-1" } };
    },
  };

  await expect(
    runOpenPiSession(
      {
        command: "open",
        dbPath: "/tmp/state/shepherd.sqlite",
        sessionId: "session-1",
        socketPath: "/tmp/shepherd.sock",
      },
      {
        async connect(socketPath) {
          calls.push(["connect", socketPath]);
          return client;
        },
        readGatewayId(stateDir) {
          calls.push(["readGatewayId", stateDir]);
          return "gateway-1";
        },
        async runPi(input) {
          calls.push(["runPi", input]);
          return 0;
        },
      },
    ),
  ).resolves.toBe(0);

  expect(calls).toMatchObject([
    ["connect", "/tmp/shepherd.sock"],
    ["ensurePiSession", { sessionId: "session-1" }],
    ["readGatewayId", "/tmp/state"],
    ["runPi", { sessionId: "session-1", piSessionFile: "/tmp/pi-session.jsonl" }],
    ["close"],
  ]);
});
```

Add a hint test:

```ts
test("renders Gateway startup hint", () => {
  expect(gatewayStartHint({ SHEPHERD_CONFIG: "/tmp/shepherd.yaml" })).toBe(
    "Shepherd Gateway is not reachable. Start the Gateway first:\n  shepherd gateway start --config /tmp/shepherd.yaml",
  );
  expect(gatewayStartHint({})).toContain("shepherd gateway start --config <path>");
});
```

Add a connection error test:

```ts
test("local startup exposes Gateway connection failures as GatewayConnectionError", async () => {
  await expect(
    runLocalPiStartup(
      {
        command: "start-local",
        dbPath: "/tmp/state/shepherd.sqlite",
        socketPath: "/tmp/missing.sock",
        workingContextPath: "/repo/app",
      },
      {
        async connect() {
          throw new GatewayConnectionError("connect ENOENT");
        },
        readGatewayId() {
          return "gateway-1";
        },
        async runPi() {
          throw new Error("runPi must not be called");
        },
      },
    ),
  ).rejects.toBeInstanceOf(GatewayConnectionError);
});
```

- [ ] **Step 6: Implement `start-local` and `open` main flow**

In `main()` before `send/open/watch/rename` handling, call the exported helpers and handle connection failure consistently:

```ts
if (command.command === "start-local") {
  try {
    exit(await runLocalPiStartup(command));
  } catch (error) {
    if (error instanceof GatewayConnectionError) {
      console.error(gatewayStartHint());
    } else {
      console.error(error instanceof Error ? error.message : String(error));
    }
    exit(1);
  }
}

if (command.command === "open") {
  try {
    exit(await runOpenPiSession(command));
  } catch (error) {
    if (error instanceof GatewayConnectionError) {
      console.error(gatewayStartHint());
    } else {
      console.error(error instanceof Error ? error.message : String(error));
    }
    exit(1);
  }
}
```

Do not `console.log()` on success. If `session.create` rejects because `workingContextPath` is outside `allowed_roots`, the user must see that RPC error message, not the Gateway-start hint. Remove the old DB direct-write `open` branch. Remove the now-unused CLI imports `applyMigrations` and `PiSessionMetadataStore` if they are only used by the old `open` branch. Keep DB imports used by `audit` and `gateway run`.

- [ ] **Step 7: Run CLI tests**

Run: `pnpm test -- test/unit/cli.test.ts`

Expected: all CLI unit tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/cli/shepherd.ts test/unit/cli.test.ts
git commit -m "cli: launch local pi sessions by default"
```

### Task 4: Synchronize explicit Shepherd and Pi session renames

**Objective:** Keep session names equal when the rename occurs through Shepherd events or the shepherd-pi extension.

**Files:**
- Modify: `packages/shepherd-pi/extensions/index.js`
- Test: no existing JS unit harness is present in the repo; validate by `pnpm pi-package:check` and the extension package syntax check.

**Interfaces:**
- Adds `/shepherd rename <title>`.
- Adds event handling for `session.renamed`.
- Uses existing Gateway RPC `session.rename`.

- [ ] **Step 1: Update `/shepherd` command behavior**

In `packages/shepherd-pi/extensions/index.js`, update the command description to:

```js
description:
  "Attach, rename, or inspect a Shepherd session: /shepherd attach <session-id> | rename <title> | status | detach",
```

Change argument parsing so `rename` preserves spaces in the title:

```js
const trimmed = args.trim();
const [command, ...rest] = trimmed.split(/\s+/);
const value = rest.join(" ");
```

Add a branch:

```js
if (command === "rename" && value) {
  if (!state.sessionId) {
    ctx.ui.notify?.("Not attached to a Shepherd session. Use /shepherd attach <session-id>.", "warning");
    return;
  }
  await ensureClient(state, ctx);
  pi.setSessionName(value);
  await state.client.request("session.rename", { sessionId: state.sessionId, title: value });
  ctx.ui.notify?.(`Renamed Shepherd session: ${value}`, "info");
  return;
}
```

Keep `detach` and status behavior unchanged.

- [ ] **Step 2: React to `session.renamed` events**

In `attachAndSubscribe`, extend the `state.client.onEvent` handler:

```js
if (event.type === "session.renamed") {
  const title = event.payload?.title;
  if (typeof title === "string" && title.length > 0) {
    pi.setSessionName(title);
  }
}
```

Do not try to sync external `pi.setSessionName()` calls.

Handle cleared Shepherd titles by passing an empty string, which keeps the call within Pi's documented string-shaped API:

```js
if (title === null) {
  pi.setSessionName("");
}
```

- [ ] **Step 3: Run package syntax validation**

Run: `pnpm pi-package:check`

Expected: `node --check packages/shepherd-pi/extensions/index.js` passes and `npm pack --dry-run` for `packages/shepherd-pi` succeeds.

- [ ] **Step 4: Commit**

```bash
git add packages/shepherd-pi/extensions/index.js
git commit -m "pi: sync explicit shepherd session renames"
```

### Task 5: Update README usage and command list

**Objective:** Document the no-argument local startup, Gateway-first requirement, and `open --session` behavior.

**Files:**
- Modify: `README.md`
- Modify: `README.ja.md`

**Interfaces:**
- User-facing CLI contract only.

- [ ] **Step 1: Update English README**

In `README.md` Usage section, add the local startup flow after Gateway startup:

```md
Start a new local Shepherd session from the current directory and open Pi:

```bash
shepherd
```

The Gateway must already be running. `shepherd` does not auto-start it. The current working directory becomes the Shepherd working context exactly as invoked.
```

Update the existing create-session Node snippet to either remove it or label it as low-level RPC verification. Keep `open --session` documented for Slack-created sessions:

```md
Open an existing Shepherd session, for example one created from Slack:

```bash
shepherd open --session "$SHEPHERD_SESSION_ID"
```
```

- [ ] **Step 2: Update Japanese README**

Mirror the English changes in `README.ja.md` using Japanese wording. Preserve existing command examples for `send`, `watch`, `rename`, and `audit`.

- [ ] **Step 3: Manual doc check**

Run: `rg "createSession|shepherd open|shepherd$" README.md README.ja.md`

Expected: README examples show `shepherd` as the primary local startup path and keep `open --session` only for existing sessions.

- [ ] **Step 4: Commit**

```bash
git add README.md README.ja.md
git commit -m "docs: document local shepherd startup"
```

### Task 6: Full validation and cleanup

**Objective:** Prove the implementation works across DB, Gateway RPC, CLI parsing, Pi package packaging, and docs.

**Files:**
- No planned source changes unless validation exposes a defect.

**Interfaces:**
- Consumes all previous tasks.
- Produces the final verified state.

- [ ] **Step 1: Run targeted tests**

Run:

```bash
pnpm test -- test/integration/working-contexts.test.ts test/integration/gateway-rpc.test.ts test/integration/tui-client.test.ts test/unit/cli.test.ts
```

Expected: all targeted tests pass.

- [ ] **Step 2: Run DB checks**

Run:

```bash
pnpm db:check
```

Expected: Drizzle reports the generated migrations match `src/db/schema.ts`.

- [ ] **Step 3: Run package check for Pi extension**

Run:

```bash
pnpm pi-package:check
```

Expected: JS syntax check and package dry-run pass.

- [ ] **Step 4: Run full project gate**

Run:

```bash
pnpm check
```

Expected: typecheck, Vitest, Biome lint, format check, Drizzle check, and Pi package check all pass.

- [ ] **Step 5: Optional local smoke test**

Only run this when a real Gateway and Pi are available in the developer environment.

Terminal 1:

```bash
export SHEPHERD_DB_PATH=/tmp/shepherd.sqlite
export SHEPHERD_GATEWAY_SOCKET_PATH=/tmp/shepherd.sock
shepherd gateway start --db "$SHEPHERD_DB_PATH" --socket "$SHEPHERD_GATEWAY_SOCKET_PATH" --config /tmp/shepherd.local.yaml
```

Terminal 2:

```bash
cd /path/inside/allowed/root
shepherd
```

Expected: Pi TUI opens without a preceding success log line; `/shepherd` reports an attached Shepherd session; `shepherd audit --session <id> --db "$SHEPHERD_DB_PATH"` can read events after interaction.

- [ ] **Step 6: Commit validation-only fixes if needed**

If validation required source changes, commit only those files:

```bash
git add <changed-files>
git commit -m "fix: stabilize local shepherd startup"
```

## Validation

- `pnpm test -- test/integration/working-contexts.test.ts test/integration/gateway-rpc.test.ts test/integration/tui-client.test.ts test/unit/cli.test.ts` — targeted tests for new behavior pass.
- `pnpm db:check` — generated migration state matches schema.
- `pnpm pi-package:check` — Pi extension syntax and package dry-run pass.
- `pnpm check` — full repository quality gate passes.
- Optional manual smoke test with a real Gateway and Pi confirms `shepherd` opens Pi silently on success and Gateway connection errors show the fixed startup hint.

## Risks, Tradeoffs, and Open Questions

- Adding a unique path index can fail on existing user databases that already contain duplicate `working_contexts.path` rows. Before applying the migration to a long-lived database, inspect duplicates with `select path, count(*) from working_contexts group by path having count(*) > 1;`. If duplicates exist, clean them manually before migration.
- `pi.setSessionName("")` may display an empty name instead of restoring Pi's first-message fallback. This is accepted for this implementation because it keeps explicit Shepherd title clearing deterministic and avoids undocumented non-string calls.
- `shepherd` no-arg startup depends on a running Gateway by design. This keeps behavior simple but makes the first-run error path important.
- This plan does not remove the legacy provider runner. The local startup work should not expand or refactor provider selection.
- This plan does not implement session resume/continue, session picker, automatic title generation, or Gateway autostart.
