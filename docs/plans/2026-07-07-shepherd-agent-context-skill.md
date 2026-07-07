# Shepherd Agent Context and Skill Implementation Plan

> **For implementers:** Execute this plan task-by-task. Complete each checkbox step and run the listed validation. Do not commit, push, or move tags unless the user explicitly asks for that step.

**Status:** Active

**Progress:** Planned. No implementation has started for this plan.

**Next steps:** Implement Task 1, then continue in order. Do not move the `v0.1.0` tag until every validation and smoke step in this plan passes.

**Goal:** Add a simple agent-facing `shepherd context` command, align the Herdr plugin and Agent Skill around that command, update README guidance, and force-move `v0.1.0` only after validation.

**Architecture:** Keep Shepherd daemon as the source of truth. The CLI should compose existing daemon RPC methods into a single `context` view; it should not add a new daemon RPC method. The Herdr plugin should call the daemon socket directly as it does now, but expose `context` instead of `observe-workspace`. The official Agent Skill should teach agents to run one command first: `shepherd context --json`.

**Tech Stack:** TypeScript ESM (`NodeNext`), Node.js 24.18.0+, pnpm 11.9.0+, Vitest, Biome, Drizzle, Pi package skills, Herdr plugin manifest and Node `.mjs` runtime.

## Global Constraints

- Do not auto-start the Shepherd daemon from `context`. If the daemon socket is unavailable, fail and tell the user to run `shepherd daemon start`.
- Add `shepherd context [--json] [--subscriber <id>] [--observed-workspace <id>]`.
- Add `shepherd observe --current [--json]`.
- Remove `shepherd observe-current` from CLI parsing, help, README, and tests.
- `context` without `--observed-workspace` requires `HERDR_ENV=1`, `HERDR_SOCKET_PATH`, and `HERDR_WORKSPACE_ID`.
- The exact error text for missing Herdr context is: `--current requires HERDR_ENV=1, HERDR_SOCKET_PATH, and HERDR_WORKSPACE_ID. Run it inside a Herdr-managed pane or plugin command.`
- `context --observed-workspace <id>` must work outside Herdr and must not call `workspace.observe`.
- `context --subscriber <id>` may create or reuse a notification subscription and return pending events. It must not ack events.
- `context` without `--subscriber` must return `notifications: { subscription: null, events: [] }`.
- `context --json` must return this stable shape:

```json
{
  "observedWorkspace": {
    "id": "ow_123",
    "liveWorkspaceId": "w1",
    "status": "active"
  },
  "workers": [],
  "notifications": {
    "subscription": null,
    "events": []
  }
}
```

- Human `context` output must follow this shape:

```text
Observed workspace: ow_123
Workers: 0
Notifications: 0
```

For workers:

```text
Observed workspace: ow_123
Workers: 2
Notifications: 1

status	agent	worker	summary	action
done	pi	wk_1	completed	review
```

- Herdr plugin manifest should replace `observe-workspace` with `context`; no backwards compatibility is required before release.
- Root `SKILL.md` and `packages/shepherd-pi/skills/shepherd/SKILL.md` should use the same Herdr-style, agent-facing guidance.
- In the Skill, if `HERDR_ENV=1`, tell the agent to run `shepherd context --json`. If not in Herdr, only use `shepherd context --observed-workspace <id> --json` when the user supplied an observed workspace id. Otherwise stop and explain the missing context.
- README should use `shepherd context --json` as the main agent-facing command and mention the Herdr plugin `context` action as a human/UI helper.
- Use stop-slop for English README/SKILL prose and stop-slop-ja for Japanese README prose.
- Existing `v0.1.0` has already been pushed. After all changes and smoke checks pass, force-move the annotated `v0.1.0` tag to the final commit and push it with force only when the user confirms the release/tag step.

## Current Context

- `src/cli/shepherd.ts` currently has separate `observe` and `observe-current` commands.
- `runCliCommand` already composes daemon RPC requests through `ObservabilityRpcClient`.
- Existing RPC methods are enough for `context`: `workspace.observe`, `workspace.snapshot`, and `notification.subscribe`.
- `packages/shepherd-herdr-plugin/index.mjs` already connects directly to the Shepherd daemon socket and reads `$SHEPHERD_HOME/runtime.json` to find the socket path.
- `packages/shepherd-herdr-plugin/herdr-plugin.toml` currently exposes `observe-workspace` and `dashboard`.
- `packages/shepherd-pi/skills/shepherd/SKILL.md` currently describes Pi bridge behavior and has `disable-model-invocation: true`; it is not yet an agent workflow skill.
- `README.md` and `README.ja.md` currently mention `observe-current`; both must move to `context`.
- The project already has public GitHub metadata, public repository visibility, and pushed commits through `a1d6b50` plus later work. Verify the current HEAD before moving the tag.

## File Structure

- Modify: `src/cli/shepherd.ts` — add `context`, add `observe --current`, remove `observe-current`, format context output.
- Modify: `test/unit/cli.test.ts` — cover parsing, RPC composition, JSON output, human output, and error text.
- Modify: `packages/shepherd-herdr-plugin/index.mjs` — replace `observe-workspace` command with `context` command and compose context output through daemon RPC.
- Modify: `packages/shepherd-herdr-plugin/herdr-plugin.toml` — replace action `observe-workspace` with action `context`.
- Modify: `test/unit/herdr-plugin-package.test.ts` — update manifest expectations and plugin runtime tests for `context`.
- Create: `SKILL.md` — official Shepherd Agent Skill at repo root.
- Modify: `packages/shepherd-pi/skills/shepherd/SKILL.md` — align package skill with root skill and keep Pi-specific notes short.
- Modify: `README.md` — document daemon startup, `shepherd context --json`, and Herdr plugin `context` action.
- Modify: `README.ja.md` — same content in Japanese, with natural wording.
- Verify: `package.json`, `packages/shepherd-pi/package.json`, `packages/shepherd-herdr-plugin/package.json` — only change if package checks require manifest paths or metadata updates.

## Interfaces

### CLI command type additions

Add these `CliCommand` variants in `src/cli/shepherd.ts`:

```ts
| {
    command: "context";
    json: boolean;
    observedWorkspaceId?: string;
    socketPath?: string;
    subscriberId?: string;
    workspaceId?: string;
  }
```

Change the existing observe command shape to include current mode:

```ts
| {
    command: "observe";
    current: boolean;
    herdrSessionName?: string;
    json: boolean;
    socketPath?: string;
    workspaceId?: string;
  }
```

### Context result shape

Create local types in `src/cli/shepherd.ts`:

```ts
type ContextResult = {
  notifications: {
    events: unknown[];
    subscription: unknown | null;
  };
  observedWorkspace: {
    id?: string;
    liveWorkspaceId?: string;
    status?: string;
  };
  workers: Array<{
    agent?: string | null;
    recommendedAction?: string | null;
    status?: string;
    summary?: string | null;
    id?: string;
    workerId?: string | null;
  }>;
};
```

Use `unknown` for notification event/subscription internals unless existing exported DB types are already imported in the file; this plan does not require adding cross-layer imports. `workspace.snapshot` returns `WorkerSnapshot[]`; use `WorkerSnapshot.id` for the displayed worker id. Keep `workerId?: string | null` only as an optional compatibility fallback for plugin-local test fixtures, and prefer `worker.id` in formatter code.

### CLI context flow

Implement `buildContext(command, client): Promise<ContextResult>` with this behavior:

1. If `command.observedWorkspaceId` exists, set `observedWorkspace = { id: command.observedWorkspaceId }` and skip `workspace.observe`.
2. Otherwise require `command.socketPath` and `command.workspaceId`, which `parseCliArgs` must copy from `HERDR_SOCKET_PATH` and `HERDR_WORKSPACE_ID`, and call `workspace.observe`. Do not read `process.env` inside `buildContext`.
3. Call `workspace.snapshot` with `observedWorkspace.id`.
4. If `command.subscriberId` exists, call `notification.subscribe` with `{ autoResume: false, observedWorkspaceId, subscriberId, subscriberKind: "cli" }`.
5. Return `notifications.subscription` and `notifications.events` from subscribe result, or `null` and `[]` when no subscriber exists. Construct the object in `subscription`, then `events` order so JSON snapshots match the documented shape.
6. Do not call `notification.ack`.

## Tasks

### Task 1: Add CLI parsing for `context` and `observe --current`

**Objective:** Make the CLI accept the new command names and reject the old name.

**Files:**
- Modify: `src/cli/shepherd.ts`
- Modify: `test/unit/cli.test.ts`

**Interfaces:**
- Consumes: existing `parseCliArgs`, `takeFlag`, `takeOption`, `rejectExtra`.
- Produces: new `context` command variant and revised `observe` command variant.

- [ ] **Step 1: Write failing parser tests**

Add or update tests in `test/unit/cli.test.ts`:

```ts
expect(
  parseCliArgs(["observe", "--current", "--json"], {
    HERDR_ENV: "1",
    HERDR_SOCKET_PATH: "/tmp/herdr.sock",
    HERDR_WORKSPACE_ID: "w1",
  }),
).toEqual({
  command: "observe",
  current: true,
  json: true,
  socketPath: "/tmp/herdr.sock",
  workspaceId: "w1",
});

expect(parseCliArgs(["context", "--json"], {
  HERDR_ENV: "1",
  HERDR_SOCKET_PATH: "/tmp/herdr.sock",
  HERDR_WORKSPACE_ID: "w1",
})).toEqual({
  command: "context",
  json: true,
  socketPath: "/tmp/herdr.sock",
  workspaceId: "w1",
});

expect(parseCliArgs(["context", "--observed-workspace", "ow_1", "--subscriber", "shepherd-agent", "--json"], {})).toEqual({
  command: "context",
  json: true,
  observedWorkspaceId: "ow_1",
  subscriberId: "shepherd-agent",
});

expect(() => parseCliArgs(["observe-current"], {})).toThrow("Unknown command: observe-current");
expect(() => parseCliArgs(["observe", "--current"], {})).toThrow(
  "--current requires HERDR_ENV=1, HERDR_SOCKET_PATH, and HERDR_WORKSPACE_ID. Run it inside a Herdr-managed pane or plugin command.",
);
expect(() => parseCliArgs(["context"], {})).toThrow(
  "--current requires HERDR_ENV=1, HERDR_SOCKET_PATH, and HERDR_WORKSPACE_ID. Run it inside a Herdr-managed pane or plugin command.",
);
```

- [ ] **Step 2: Run the parser test and verify failure**

Run: `PATH="$HOME/.local/share/mise/installs/node/24.18.0/bin:$HOME/.local/share/mise/installs/pnpm/11.9.0/bin:$PATH" pnpm vitest run test/unit/cli.test.ts`

Expected: failures showing `context` and `observe --current` are unknown or not parsed.

- [ ] **Step 3: Implement parser changes**

In `src/cli/shepherd.ts`:

1. Add constant:

```ts
const CURRENT_HERDR_CONTEXT_ERROR =
  "--current requires HERDR_ENV=1, HERDR_SOCKET_PATH, and HERDR_WORKSPACE_ID. Run it inside a Herdr-managed pane or plugin command.";
```

2. Add helper:

```ts
function currentHerdrContext(environment: NodeJS.ProcessEnv): {
  socketPath: string;
  workspaceId: string;
} {
  if (
    environment.HERDR_ENV !== "1" ||
    !environment.HERDR_SOCKET_PATH ||
    !environment.HERDR_WORKSPACE_ID
  ) {
    throw new Error(CURRENT_HERDR_CONTEXT_ERROR);
  }
  return {
    socketPath: environment.HERDR_SOCKET_PATH,
    workspaceId: environment.HERDR_WORKSPACE_ID,
  };
}
```

3. In the `observe` branch, read `const current = takeFlag(rest, "--current");`. If `current` is true, reject `--herdr-session`, `--socket`, and `--workspace` combinations by checking those options after parsing and throwing `observe --current cannot be combined with --herdr-session, --socket, or --workspace`. Return current env values from `currentHerdrContext(environment)`.
4. Remove the `observe-current` branch.
5. Add a `context` branch before `snapshot`:

```ts
if (command === "context") {
  const json = takeFlag(rest, "--json");
  const observedWorkspaceId = takeOption(rest, "--observed-workspace");
  const subscriberId = takeOption(rest, "--subscriber");
  rejectExtra(rest);
  const current = observedWorkspaceId ? undefined : currentHerdrContext(environment);
  return {
    command: "context",
    json,
    ...(observedWorkspaceId ? { observedWorkspaceId } : {}),
    ...(current ? { socketPath: current.socketPath, workspaceId: current.workspaceId } : {}),
    ...(subscriberId ? { subscriberId } : {}),
  };
}
```

- [ ] **Step 4: Run the parser test and verify success**

Run: `PATH="$HOME/.local/share/mise/installs/node/24.18.0/bin:$HOME/.local/share/mise/installs/pnpm/11.9.0/bin:$PATH" pnpm vitest run test/unit/cli.test.ts`

Expected: parser assertions pass or only runtime dispatch tests fail because implementation is still missing.

- [ ] **Step 5: Checkpoint files**

Files expected to change in this task: `src/cli/shepherd.ts`, `test/unit/cli.test.ts`. Do not commit unless the user explicitly asks for a commit.

### Task 2: Compose `context` output in the CLI

**Objective:** Make `shepherd context` call existing daemon RPC methods and return stable JSON/human output.

**Files:**
- Modify: `src/cli/shepherd.ts`
- Modify: `test/unit/cli.test.ts`

**Interfaces:**
- Consumes: parser output from Task 1.
- Produces: JSON/human context output and revised `observe` dispatch.

- [ ] **Step 1: Write failing dispatch tests**

In `test/unit/cli.test.ts`, add a test that uses fake RPC responses:

```ts
await runCliCommand(
  { command: "context", json: true, socketPath: "/tmp/herdr.sock", workspaceId: "w1" },
  {
    connect: async () => client,
    output: (line) => output.push(line),
    socketPath: "/tmp/shepherd.sock",
  },
);
```

Set `client.request` to return:

```ts
if (method === "workspace.observe") {
  return { observedWorkspace: { id: "ow_1", liveWorkspaceId: "w1", status: "active" } };
}
if (method === "workspace.snapshot") {
  return { workers: [{ id: "wk_1", status: "done", agent: "pi", summary: "completed", recommendedAction: "review" }] };
}
if (method === "notification.subscribe") {
  return { events: [{ id: 7, type: "worker.completed" }], subscription: { id: "ns_1" } };
}
```

Parse the JSON output with `JSON.parse(output[0])` and expect:

```ts
expect(JSON.parse(output[0])).toEqual({
  observedWorkspace: { id: "ow_1", liveWorkspaceId: "w1", status: "active" },
  workers: [
    { id: "wk_1", status: "done", agent: "pi", summary: "completed", recommendedAction: "review" },
  ],
  notifications: { subscription: null, events: [] },
});
```

Do not compare raw JSON strings in this test.

Add a second test for `context --observed-workspace ow_1 --subscriber shepherd-agent --json` by passing the `CliCommand` object directly to `runCliCommand`:

```ts
{
  command: "context",
  json: true,
  observedWorkspaceId: "ow_1",
  subscriberId: "shepherd-agent",
}
```

Expected RPC calls:

```ts
[
  ["workspace.snapshot", { observedWorkspaceId: "ow_1" }],
  ["notification.subscribe", {
    autoResume: false,
    observedWorkspaceId: "ow_1",
    subscriberId: "shepherd-agent",
    subscriberKind: "cli",
  }],
  ["close"],
]
```

Add a human output test expecting:

```text
Observed workspace: ow_1
Workers: 1
Notifications: 0

status	agent	worker	summary	action
done	pi	wk_1	completed	review
```

- [ ] **Step 2: Run dispatch tests and verify failure**

Run: `PATH="$HOME/.local/share/mise/installs/node/24.18.0/bin:$HOME/.local/share/mise/installs/pnpm/11.9.0/bin:$PATH" pnpm vitest run test/unit/cli.test.ts`

Expected: failures for missing context dispatch or output formatting.

- [ ] **Step 3: Implement `buildContext` and output formatting**

In `dispatchRpcCommand`, add `case "context": return buildContext(command, client);`.

Add this implementation in `src/cli/shepherd.ts`:

```ts
async function buildContext(
  command: Extract<CliCommand, { command: "context" }>,
  client: RpcClientLike,
): Promise<ContextResult> {
  let observedWorkspace: ContextResult["observedWorkspace"];
  if (command.observedWorkspaceId) {
    observedWorkspace = { id: command.observedWorkspaceId };
  } else {
    if (!command.socketPath || !command.workspaceId) {
      throw new Error(CURRENT_HERDR_CONTEXT_ERROR);
    }
    const observed = (await client.request("workspace.observe", {
      socketPath: command.socketPath,
      workspaceId: command.workspaceId,
    })) as { observedWorkspace?: ContextResult["observedWorkspace"] };
    observedWorkspace = observed.observedWorkspace ?? {};
  }

  if (!observedWorkspace.id) {
    throw new Error("context requires an observed workspace id");
  }

  const snapshot = (await client.request("workspace.snapshot", {
    observedWorkspaceId: observedWorkspace.id,
  })) as { workers?: ContextResult["workers"] };

  let notifications: ContextResult["notifications"] = { subscription: null, events: [] };
  if (command.subscriberId) {
    const subscribed = (await client.request("notification.subscribe", {
      autoResume: false,
      observedWorkspaceId: observedWorkspace.id,
      subscriberId: command.subscriberId,
      subscriberKind: "cli",
    })) as ContextResult["notifications"];
    notifications = {
      subscription: subscribed.subscription ?? null,
      events: subscribed.events ?? [],
    };
  }

  return {
    observedWorkspace,
    workers: snapshot.workers ?? [],
    notifications,
  };
}
```

`buildContext` must not read `process.env`; `parseCliArgs` already copied Herdr context into `command.socketPath` and `command.workspaceId`. The resulting JSON must match the required shape.

Update `formatHumanResult`:

```ts
if (command.command === "context") {
  return formatContextResult(result as ContextResult);
}
```

Add formatter:

```ts
function formatContextResult(result: ContextResult): string {
  const lines = [
    `Observed workspace: ${result.observedWorkspace.id ?? "unknown"}`,
    `Workers: ${result.workers.length}`,
    `Notifications: ${result.notifications.events.length}`,
  ];
  if (result.workers.length === 0) return lines.join("\n");
  lines.push("", ["status", "agent", "worker", "summary", "action"].join("\t"));
  for (const worker of result.workers) {
    lines.push(
      [
        worker.status ?? "unknown",
        worker.agent ?? "unknown",
        worker.id ?? worker.workerId ?? "workspace",
        worker.summary ?? "",
        worker.recommendedAction ?? "",
      ].join("\t"),
    );
  }
  return lines.join("\n");
}
```

- [ ] **Step 4: Update help text**

Change help text to include:

```text
  shepherd context [--observed-workspace <id>] [--subscriber <id>] [--json]
  shepherd observe --current [--json]
```

Remove:

```text
  shepherd observe-current [--json]
```

- [ ] **Step 5: Run CLI tests and verify success**

Run: `PATH="$HOME/.local/share/mise/installs/node/24.18.0/bin:$HOME/.local/share/mise/installs/pnpm/11.9.0/bin:$PATH" pnpm vitest run test/unit/cli.test.ts`

Expected: all CLI unit tests pass.

- [ ] **Step 6: Checkpoint files**

Files expected to change in this task: `src/cli/shepherd.ts`, `test/unit/cli.test.ts`. Do not commit unless the user explicitly asks for a commit.

### Task 3: Replace Herdr plugin `observe-workspace` action with `context`

**Objective:** Make the Herdr plugin expose one short `context` action and share the CLI context output style.

**Files:**
- Modify: `packages/shepherd-herdr-plugin/herdr-plugin.toml`
- Modify: `packages/shepherd-herdr-plugin/index.mjs`
- Modify: `test/unit/herdr-plugin-package.test.ts`

**Interfaces:**
- Consumes: daemon RPC methods `workspace.observe`, `workspace.snapshot`, `notification.subscribe`.
- Produces: Herdr action `context` with command `node index.mjs context`.

- [ ] **Step 1: Write failing plugin tests**

Update manifest test expectations:

```ts
expect(manifest).toContain('id = "context"');
expect(manifest).toContain('command = ["node", "index.mjs", "context"]');
expect(manifest).not.toContain('id = "observe-workspace"');
```

Replace `observes Herdr context over Shepherd daemon RPC` with a `context` test:

```ts
await expect(
  runPluginCommand(["context"], {
    clientFactory: () => client,
    env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/herdr.sock", HERDR_WORKSPACE_ID: "w1" },
    output: (line) => output.push(line),
  }),
).resolves.toBe(0);
expect(client.calls).toEqual([
  ["workspace.observe", { socketPath: "/tmp/herdr.sock", workspaceId: "w1" }],
  ["workspace.snapshot", { observedWorkspaceId: "ow_1" }],
  ["close"],
]);
expect(output.join("\n")).toContain("Observed workspace: ow_1");
expect(output.join("\n")).toContain("done\tpi\twk_1\tcompleted\treview");
```

Add a subscriber test:

```ts
await runPluginCommand(["context", "--subscriber", "shepherd-agent"], ...);
expect(client.calls).toContainEqual(["notification.subscribe", {
  autoResume: false,
  observedWorkspaceId: "ow_1",
  subscriberId: "shepherd-agent",
  subscriberKind: "cli",
}]);
```

- [ ] **Step 2: Run plugin tests and verify failure**

Run: `PATH="$HOME/.local/share/mise/installs/node/24.18.0/bin:$HOME/.local/share/mise/installs/pnpm/11.9.0/bin:$PATH" pnpm vitest run test/unit/herdr-plugin-package.test.ts`

Expected: failures for manifest/action name and missing `context` command.

- [ ] **Step 3: Update Herdr manifest**

Change `packages/shepherd-herdr-plugin/herdr-plugin.toml`:

```toml
[[actions]]
id = "context"
title = "Show Shepherd context"
contexts = ["workspace"]
command = ["node", "index.mjs", "context"]
```

Remove the `observe-workspace` action block.

- [ ] **Step 4: Update plugin runtime**

In `packages/shepherd-herdr-plugin/index.mjs`:

1. Replace the `observe-workspace` branch with `context`.
2. Add option parsing for `--subscriber <id>` only. If any other argument remains, print `context accepts only --subscriber <id>` and return `2`.
3. Reuse the same context flow and human output as CLI:
   - require Herdr env values for current context
   - call `workspace.observe`
   - call `workspace.snapshot`
   - if subscriber exists, call `notification.subscribe` with `subscriberKind: "cli"` and `autoResume: false`
   - print `Observed workspace`, `Workers`, `Notifications`, and worker rows
4. Keep `dashboard` for the pane command.
5. Replace error text for missing Herdr context with the exact global constraint string.

- [ ] **Step 5: Run plugin checks**

Run:

```bash
PATH="$HOME/.local/share/mise/installs/node/24.18.0/bin:$HOME/.local/share/mise/installs/pnpm/11.9.0/bin:$PATH" pnpm --dir packages/shepherd-herdr-plugin typecheck
PATH="$HOME/.local/share/mise/installs/node/24.18.0/bin:$HOME/.local/share/mise/installs/pnpm/11.9.0/bin:$PATH" pnpm vitest run test/unit/herdr-plugin-package.test.ts
PATH="$HOME/.local/share/mise/installs/node/24.18.0/bin:$HOME/.local/share/mise/installs/pnpm/11.9.0/bin:$PATH" pnpm herdr-plugin:check
```

Expected: all pass, package dry-run still contains `index.mjs` and `herdr-plugin.toml` only.

- [ ] **Step 6: Checkpoint files**

Files expected to change in this task: `packages/shepherd-herdr-plugin/herdr-plugin.toml`, `packages/shepherd-herdr-plugin/index.mjs`, `test/unit/herdr-plugin-package.test.ts`. Do not commit unless the user explicitly asks for a commit.

### Task 4: Add official Agent Skill files

**Objective:** Provide a Herdr-style official Shepherd Agent Skill at repo root and in the Pi package.

**Files:**
- Create: `SKILL.md`
- Modify: `packages/shepherd-pi/skills/shepherd/SKILL.md`

**Interfaces:**
- Consumes: `shepherd context --json`, `shepherd context --observed-workspace <id> --json`, optional `--subscriber shepherd-agent`.
- Produces: Agent-facing instructions for Shepherd usage.

- [ ] **Step 1: Write root `SKILL.md`**

Create `SKILL.md` with this complete content:

````markdown
---
name: shepherd
description: "Use Shepherd inside Herdr to read worker snapshots, worker events, and notifications for coding agents. Use when HERDR_ENV=1 or when the user gives you an observed workspace id."
---

# shepherd — agent skill

before using this skill, check whether `HERDR_ENV=1`.

if `HERDR_ENV=1`, run:

```bash
shepherd context --json
```

if `HERDR_ENV` is not `1`, only use Shepherd when the user gives you an observed workspace id. then run:

```bash
shepherd context --observed-workspace ow_123 --json
```

if you are not inside Herdr and the user did not give an observed workspace id, say Shepherd needs a Herdr-managed pane or an observed workspace id. stop there. do not guess a workspace.

Shepherd stores worker state for coding agents that run in Herdr. It does not control panes, tabs, or agents. Use Herdr for terminal control. Use Shepherd for worker snapshots, worker events, and notification context.

## daemon requirement

Shepherd commands talk to the Shepherd daemon. if `shepherd context --json` cannot connect to the daemon, ask the user to start it:

```bash
shepherd daemon start
```

Do not start the daemon yourself unless the user asks.

## read current worker context

Inside Herdr, start with:

```bash
shepherd context --json
```

The result has this shape:

```json
{
  "observedWorkspace": { "id": "ow_123" },
  "workers": [],
  "notifications": { "subscription": null, "events": [] }
}
```

Use `workers` to see current worker status, summaries, blocked reasons, recommended actions, and evidence. Use notification events only when the user asks about unread worker notifications.

## read unread notifications

Do not create a notification subscription unless you need unread worker notifications. When you need them, use a separate subscriber id for agent reads:

```bash
shepherd context --json --subscriber shepherd-agent
```

This reads pending events. It does not ack them.

## read a known observed workspace

Outside Herdr, use an id the user gave you:

```bash
shepherd context --observed-workspace ow_123 --json
```

Add `--subscriber shepherd-agent` only when you need pending notifications for that workspace.

## boundaries

- use Shepherd for durable worker state, snapshots, worker events, and notifications
- use Herdr for workspace, tab, pane, output, wait, and agent control
- do not send hidden thinking, full transcripts, or full tool outputs to Shepherd
- do not ack notifications unless the user asks you to ack a specific event
- do not assume worker ids or observed workspace ids; read them from Shepherd output
````

- [ ] **Step 2: Update Pi package skill**

Replace `packages/shepherd-pi/skills/shepherd/SKILL.md` with the same workflow. Keep Pi-specific notes after the boundaries section:

````markdown
## pi extension notes

When the `shepherd-pi` extension is active, Pi sends bounded, redacted tool and final message excerpts to Shepherd. Pi also receives worker notifications and may inject them into the next turn as hidden context.

This skill does not grant access to hidden thinking, full tool results, or full transcripts.
````

Remove `disable-model-invocation: true` so Pi can offer the skill when the task matches. Keep the frontmatter name `shepherd` and description within 1024 characters.

- [ ] **Step 3: Validate skill files**

Run:

```bash
rg -n "disable-model-invocation|TODO|TBD" SKILL.md packages/shepherd-pi/skills/shepherd/SKILL.md
PATH="$HOME/.local/share/mise/installs/node/24.18.0/bin:$HOME/.local/share/mise/installs/pnpm/11.9.0/bin:$PATH" pnpm pi-package:check
```

Expected: `rg` should not find `disable-model-invocation`, `TODO`, or `TBD`; `pnpm pi-package:check` passes.

- [ ] **Step 4: Checkpoint files**

Files expected to change in this task: `SKILL.md`, `packages/shepherd-pi/skills/shepherd/SKILL.md`. Do not commit unless the user explicitly asks for a commit.

### Task 5: Update README for `context` and the Skill

**Objective:** Make README human-oriented and point agents to one command and the official Skill.

**Files:**
- Modify: `README.md`
- Modify: `README.ja.md`

**Interfaces:**
- Consumes: CLI `context`, Herdr plugin `context` action, root `SKILL.md`.
- Produces: README that no longer teaches `observe-current` as the main path.

- [ ] **Step 1: Update English README**

In `README.md`:

1. Replace the "Observe a Herdr workspace" section with "Read worker context".
2. Use this command as the main agent-facing command:

```bash
node dist/src/cli/shepherd.js context --json
```

3. If using source checkout path is too long, include both:

```bash
node dist/src/cli/shepherd.js context --json
# or, if shepherd is on PATH:
shepherd context --json
```

4. Add Herdr plugin action as a human/UI helper:

```bash
herdr plugin action invoke context --plugin shepherd.observability
```

5. Add a short "Agent Skill" paragraph:

```md
Agents should read [`SKILL.md`](SKILL.md). The skill tells agents to use `shepherd context --json` inside Herdr and to avoid guessing workspace ids outside Herdr.
```

6. Replace help wording to mention `context` and `observe --current`, not `observe-current`.

- [ ] **Step 2: Update Japanese README**

Mirror the English changes in natural Japanese. Avoid translationese and AI-style filler. Use these terms consistently: `daemon`, `worker`, `snapshot`, `notification`, `Herdr plugin`, `Pi extension`, `Agent Skill`.

- [ ] **Step 3: Stop-slop checks**

Run:

```bash
wc -l README.md README.ja.md
rg -n "observe-current|TODO|TBD|foo|bar|example|重要なのは|本質的|実は|まさに|—|——|ではなく|以下に|ここでは|することができる|両輪|示唆" README.md README.ja.md || true
PATH="$HOME/.local/share/mise/installs/node/24.18.0/bin:$HOME/.local/share/mise/installs/pnpm/11.9.0/bin:$PATH" pnpm format:check
```

Expected: `observe-current` is absent, no TODO/TBD/filler terms appear, and `pnpm format:check` passes. If the README exceeds 100 lines, either shorten it or add a table of contents.

- [ ] **Step 4: Checkpoint files**

Files expected to change in this task: `README.md`, `README.ja.md`. Do not commit unless the user explicitly asks for a commit.

### Task 6: Full validation and smoke checks

**Objective:** Prove CLI, plugin, skills, docs, and package checks work together before moving the release tag.

**Files:**
- No planned source edits. Fix issues found by validation before moving to Task 7.

**Interfaces:**
- Consumes: all earlier tasks.
- Produces: validation evidence for tag movement.

- [ ] **Step 1: Run full static checks**

Run:

```bash
PATH="$HOME/.local/share/mise/installs/node/24.18.0/bin:$HOME/.local/share/mise/installs/pnpm/11.9.0/bin:$PATH" pnpm check
PATH="$HOME/.local/share/mise/installs/node/24.18.0/bin:$HOME/.local/share/mise/installs/pnpm/11.9.0/bin:$PATH" pnpm build
```

Expected: both commands exit 0. `pnpm check` should report 26 test files and the updated test count.

- [ ] **Step 2: Smoke CLI context from a real Herdr-managed pane**

This smoke must run inside a Herdr-managed pane so `HERDR_SOCKET_PATH` points to a live Herdr socket. Do not fake `HERDR_SOCKET_PATH`.

Run inside Herdr:

```bash
rm -rf /tmp/shepherd-context-smoke
SHEPHERD_HOME=/tmp/shepherd-context-smoke node dist/src/cli/shepherd.js daemon start
SHEPHERD_HOME=/tmp/shepherd-context-smoke node dist/src/cli/shepherd.js context --json
SHEPHERD_HOME=/tmp/shepherd-context-smoke node dist/src/cli/shepherd.js daemon stop
```

Expected: `context --json` prints JSON with `observedWorkspace`, `workers`, and `notifications`; daemon stops after the test. If the implementer is not currently inside Herdr, skip this manual smoke and rely on Task 6 Step 3 plus unit/integration tests until a Herdr pane is available.

- [ ] **Step 3: Smoke Herdr plugin from local checkout**

This runtime smoke must run inside a Herdr-managed pane so the plugin receives real `HERDR_*` environment values. Do not fake `HERDR_SOCKET_PATH`.

Run inside Herdr:

```bash
herdr plugin link ./packages/shepherd-herdr-plugin
rm -rf /tmp/shepherd-context-smoke
SHEPHERD_HOME=/tmp/shepherd-context-smoke node dist/src/cli/shepherd.js daemon start
SHEPHERD_HOME=/tmp/shepherd-context-smoke node packages/shepherd-herdr-plugin/index.mjs context
SHEPHERD_HOME=/tmp/shepherd-context-smoke node dist/src/cli/shepherd.js daemon stop
herdr plugin list --plugin shepherd.observability --json
```

Expected: direct plugin runtime output contains `Observed workspace:`. `herdr plugin list` shows action `context` and no action `observe-workspace`.

- [ ] **Step 4: Smoke Pi package load**

Run:

```bash
PI_OFFLINE=1 pi -e ./packages/shepherd-pi --list-models __no_such_model__
```

Expected: command exits 0 and prints `No models matching "__no_such_model__"`.

- [ ] **Step 5: Apply fixes if validation required changes**

If any smoke step requires source or doc changes, apply the fixes and rerun the failed validation. Do not commit unless the user explicitly asks for a commit.

### Task 7: Move `v0.1.0` tag and verify release install

**Objective:** Force-move the already pushed `v0.1.0` tag to the final validated commit and confirm public GitHub install works. Run this task only after the user explicitly approves the release/tag step and the final implementation commit exists.

**Files:**
- No file edits.

**Interfaces:**
- Consumes: final validated `main` commit.
- Produces: remote `v0.1.0` tag pointing at final commit.

- [ ] **Step 1: Confirm clean state and final commit**

Run:

```bash
git status --short --branch
git rev-parse HEAD
git rev-parse origin/main
```

Expected: worktree clean; `HEAD` equals `origin/main`. If implementation changes are not committed and pushed yet, stop here and ask the user whether to run the project commit/push workflow before moving the tag.

- [ ] **Step 2: Force-move annotated tag locally**

Run:

```bash
git tag -f -a v0.1.0 -m "v0.1.0"
```

Expected: local tag `v0.1.0` points to `HEAD`.

- [ ] **Step 3: Force-push tag**

Run:

```bash
git push --force origin v0.1.0
```

Expected: remote tag updates successfully.

- [ ] **Step 4: Install Herdr plugin from `v0.1.0`**

Run:

```bash
herdr plugin install ryonakae/shepherd/packages/shepherd-herdr-plugin --ref v0.1.0 --yes
herdr plugin list --plugin shepherd.observability --json
```

Expected: install succeeds; plugin source shows `requested_ref: "v0.1.0"`; action list includes `context`; action list does not include `observe-workspace`.

- [ ] **Step 5: Smoke installed Herdr plugin runtime**

Run inside a Herdr-managed pane:

```bash
PLUGIN_ROOT=$(herdr plugin list --plugin shepherd.observability --json | node -e 'let s=""; process.stdin.on("data", d => s += d); process.stdin.on("end", () => { const j = JSON.parse(s); console.log(j.result.plugins[0].plugin_root); });')
rm -rf /tmp/shepherd-context-smoke
SHEPHERD_HOME=/tmp/shepherd-context-smoke node dist/src/cli/shepherd.js daemon start
SHEPHERD_HOME=/tmp/shepherd-context-smoke node "$PLUGIN_ROOT/index.mjs" context
SHEPHERD_HOME=/tmp/shepherd-context-smoke node dist/src/cli/shepherd.js daemon stop
```

Expected: installed plugin runtime output contains `Observed workspace:` and exits 0. Daemon stops.

## Validation

Run these after all implementation tasks and before moving the tag:

```bash
PATH="$HOME/.local/share/mise/installs/node/24.18.0/bin:$HOME/.local/share/mise/installs/pnpm/11.9.0/bin:$PATH" pnpm check
PATH="$HOME/.local/share/mise/installs/node/24.18.0/bin:$HOME/.local/share/mise/installs/pnpm/11.9.0/bin:$PATH" pnpm build
PATH="$HOME/.local/share/mise/installs/node/24.18.0/bin:$HOME/.local/share/mise/installs/pnpm/11.9.0/bin:$PATH" pnpm herdr-plugin:check
PATH="$HOME/.local/share/mise/installs/node/24.18.0/bin:$HOME/.local/share/mise/installs/pnpm/11.9.0/bin:$PATH" pnpm pi-package:check
```

Expected: every command exits 0.

Manual smoke required before tag movement:

From a Herdr-managed pane:

```bash
rm -rf /tmp/shepherd-context-smoke
SHEPHERD_HOME=/tmp/shepherd-context-smoke node dist/src/cli/shepherd.js daemon start
SHEPHERD_HOME=/tmp/shepherd-context-smoke node dist/src/cli/shepherd.js context --json
SHEPHERD_HOME=/tmp/shepherd-context-smoke node dist/src/cli/shepherd.js daemon stop
```

From any shell:

```bash
PI_OFFLINE=1 pi -e ./packages/shepherd-pi --list-models __no_such_model__
```

Expected: the Herdr-pane context command prints JSON containing `observedWorkspace`, `workers`, `notifications`; Pi command reports no matching model and exits 0.

## Risks, Tradeoffs, and Open Questions

- The plan removes `observe-current` before the first public release. This is acceptable because the user explicitly said compatibility can be ignored before release.
- The plan does not add daemon auto-start. This prevents agents from starting long-running processes without user intent.
- `context` composes existing RPC calls client-side. This avoids new server surface area but duplicates a small amount of composition logic in the CLI and Herdr plugin.
- `--subscriber` creates or reuses a notification subscription and reads pending events without acking. Repeated use with different subscriber ids can create cursor rows, so README and Skill should recommend no subscriber for the default path.
- Force-moving `v0.1.0` rewrites a pushed tag. The user approved force-moving the tag as the release approach, but the command should still run only during the explicit release/tag step.
- Herdr plugin action `context` runs asynchronously through Herdr action logs when invoked via `herdr plugin action invoke`. The direct `node index.mjs context` smoke proves runtime behavior; Herdr UI/log review may still be useful before release notes.

## Self-Review

- Specification coverage: every dig decision appears in Global Constraints or a task.
- Placeholder check: no TODO/TBD placeholders remain in the plan. Angle-bracket syntax appears only where CLI help documents required arguments.
- Type/name consistency: `context`, `observe --current`, `--observed-workspace`, `--subscriber`, `ContextResult`, and `CURRENT_HERDR_CONTEXT_ERROR` are used consistently.
- Testability: every implementation task has a failing test step, passing test step, and command with expected outcome.
- Scope: no new daemon RPC method, no auto-start, no compatibility alias beyond what the user approved.
- DRY: CLI and Herdr plugin share behavior conceptually; if implementation grows, extract small local helpers in each file rather than adding cross-package imports.
