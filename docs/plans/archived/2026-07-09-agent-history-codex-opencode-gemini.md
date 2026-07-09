# Codex, OpenCode, and Gemini Agent History Implementation Plan

> **For implementers:** Execute this plan task-by-task. Complete each checkbox step, run the listed validation, and commit after each task.

**Status:** Completed

**Completion notes:** Implemented Codex JSONL, OpenCode SQLite, and Gemini CLI JSON discovery and readers behind the existing AgentHistoryService API. Added unit and RPC integration coverage, updated README source support notes, committed and pushed implementation slices, and verified with `pnpm check` and `pnpm build`.

**Goal:** Extend Shepherd agent history so `shepherd agent list/get/read` can discover and parse Codex, OpenCode, and Gemini CLI sessions in addition to Pi and Claude Code.

**Architecture:** Keep the existing `src/agent-history/` layer as the only runtime-specific history reader boundary. Extend discovery to resolve runtime-specific `AgentHistoryRef` records, add one reader per new runtime, and register those readers in `createAgentHistoryService()`. The daemon, RPC, CLI, Pi extension, and Herdr plugin should continue to use the existing `AgentHistoryService` API without runtime-specific branching.

**Tech Stack:** TypeScript ESM with `NodeNext`, Node.js `node:fs/promises`, Node.js `node:sqlite` for OpenCode read-only DB access, Vitest, Biome, existing Shepherd JSON Lines RPC.

## Global Constraints

- Do not add npm dependencies. Shepherd already uses `node:sqlite`; OpenCode DB access must use `DatabaseSync` from `node:sqlite`.
- Preserve existing `AgentHistoryService` public methods: `discover()`, `getCompactHistory()`, and `read()`.
- Preserve CLI/RPC command names and payload shape: `shepherd agent list/get/read` and daemon methods `agent.list`, `agent.get`, `agent.read`.
- Do not return full raw tool output in compact history. Route tool outputs through `compactToolResult()`.
- Keep source-of-truth reads from original runtime data files/DB, not Shepherd DB cache.
- Keep discovery bounded:
  - Codex fallback scans `${homeDir}/.codex/sessions` for `*.jsonl`, prefers CWD match, then latest mtime.
  - OpenCode fallback reads one SQLite DB path: `OPENCODE_DB` when set, otherwise `${homeDir}/.local/share/opencode/opencode.db`.
  - Gemini fallback scans `${homeDir}/.gemini/tmp` for project directories with `.project_root` and `chats/session-*.json`, prefers CWD match, then latest mtime.
- The existing cache key is file-path based. OpenCode has one DB path for many sessions, so cache source keys must include the OpenCode session id to prevent cross-session compact-history collisions.
- Use project TypeScript style: ESM imports, `@/*` alias for `src` imports, no comments unless they explain Why.
- After implementation, run `pnpm check`. If local PATH points at old Node/pnpm, prefix commands with:

```bash
PATH="$HOME/.local/share/mise/installs/node/24.18.0/bin:$HOME/.local/share/mise/installs/pnpm/11.9.0/bin:$PATH"
```

## Current Context

- Current sources are only `"claude-jsonl" | "pi-jsonl" | "unknown"` in `src/observability/contracts.ts`.
- Current reader registry in `src/agent-history/service.ts` is `[new PiHistoryReader(), new ClaudeHistoryReader()]`.
- Current discovery in `src/agent-history/discovery.ts` only scans:
  - `${homeDir}/.pi/agent/sessions`
  - `${homeDir}/.claude/projects`
- ZAM reference implementation paths:
  - Codex: `/Users/ryo.nakae/Dev/private/zellij-agents-manager/crates/zam/src/agents/codex/parser.rs`
  - OpenCode: `/Users/ryo.nakae/Dev/private/zellij-agents-manager/crates/zam/src/worker/process/opencode.rs`
  - Gemini: `/Users/ryo.nakae/Dev/private/zellij-agents-manager/crates/zam/src/worker/process/gemini.rs`
  - Runtime notes: `/Users/ryo.nakae/Dev/private/zellij-agents-manager/docs/agents/agent-logic.md`
- ZAM data-source summary:
  - Codex JSONL: `~/.codex/sessions/YYYY/MM/DD/*.jsonl`; CWD is `session_meta.payload.cwd`; optional task names are in `~/.codex/session_index.jsonl`.
  - OpenCode SQLite: `~/.local/share/opencode/opencode.db` or `OPENCODE_DB`; tables `session`, `message`, `part`; session CWD is `session.directory`.
  - Gemini JSON: `~/.gemini/tmp/<project>/chats/session-*.json`; project CWD is `.project_root`; current JSON shape is object with `messages` array.
- Local shape checks, without exposing message text, confirmed:
  - Codex entries include `session_meta`, `event_msg`, `response_item`; tool outputs use `response_item.payload.type` values such as `function_call_output` and `custom_tool_call_output`.
  - OpenCode `part.data` includes `type="text"` and `type="tool"`; tool state has `state.output`, `state.status`, and sometimes `state.error`.
  - Gemini session JSON object keys include `kind`, `lastUpdated`, `messages`, `projectHash`, `sessionId`, `startTime`; messages include `type="user"`, `type="gemini"`, and `type="info"`.

## File Structure

- Modify: `src/observability/contracts.ts` — add `codex-jsonl`, `opencode-sqlite`, and `gemini-json` history sources.
- Modify: `src/agent-history/discovery.ts` — discover Codex JSONL, OpenCode SQLite session ids, and Gemini session JSON files.
- Modify: `src/agent-history/service.ts` — register new readers and use collision-safe cache source keys.
- Modify: `src/agent-history/text.ts` — add small shared helpers only if a reader would otherwise duplicate content extraction.
- Create: `src/agent-history/codex-reader.ts` — parse Codex JSONL into normalized `AgentHistoryMessage[]`.
- Create: `src/agent-history/opencode-reader.ts` — read OpenCode SQLite session history into normalized messages.
- Create: `src/agent-history/gemini-reader.ts` — parse Gemini CLI session JSON into normalized messages.
- Create: `test/unit/agent-history-discovery.test.ts` — discovery coverage for Pi/Claude regressions plus Codex/OpenCode/Gemini.
- Create: `test/unit/agent-history-readers.test.ts` — reader coverage for Codex/OpenCode/Gemini and selected Pi/Claude smoke cases.
- Create: `test/unit/agent-history-service.test.ts` — service registry and cache-source-key coverage.
- Modify: `test/integration/observability-rpc.test.ts` — add one daemon `agent.read` scenario using new history sources.
- Modify: `README.md` and `README.ja.md` — list supported history sources if the implementation changes user-facing support claims.

## Interfaces

### Extended `AgentHistoryRef.source`

Use this exact union in `src/observability/contracts.ts`:

```ts
export type AgentHistoryRef = {
  kind: "agent_session" | "discovered_file";
  path?: string;
  source: "claude-jsonl" | "codex-jsonl" | "gemini-json" | "opencode-sqlite" | "pi-jsonl" | "unknown";
  value: string;
};
```

### Source conventions

- Codex:
  - `source: "codex-jsonl"`
  - `path: <jsonl path>`
  - `value: <jsonl path>`
- OpenCode:
  - `source: "opencode-sqlite"`
  - `path: <opencode db path>`
  - `value: <session id>`
- Gemini:
  - `source: "gemini-json"`
  - `path: <session json path>`
  - `value: <session json path>`

### Reader contract

New readers must implement the existing `AgentHistoryReader` interface from `src/agent-history/readers.ts`:

```ts
export type AgentHistoryReader = {
  canRead(ref: AgentHistoryRef): boolean;
  read(ref: AgentHistoryRef, options: { limit?: number }): Promise<AgentHistoryMessage[]>;
  readCompact(ref: AgentHistoryRef): Promise<CompactAgentHistory>;
};
```

## Tasks

### Task 1: Extend history source contracts, discovery, and cache keys

**Objective:** Make Shepherd able to resolve Codex, OpenCode, and Gemini history references without reading messages yet, and prevent OpenCode cache collisions.

**Files:**
- Modify: `src/observability/contracts.ts`
- Modify: `src/agent-history/discovery.ts`
- Modify: `src/agent-history/service.ts`
- Create: `test/unit/agent-history-discovery.test.ts`
- Create: `test/unit/agent-history-service.test.ts`

**Interfaces:**
- Consumes: existing `AgentHistoryLookupInput`, `AgentSessionRef`, `AgentHistoryRef`.
- Produces: extended `AgentHistoryRef.source`, updated `discoverAgentHistory()`, exported `cacheSourcePathForRef(ref)` from `src/agent-history/service.ts`.

- [x] **Step 1: Write failing discovery tests**

Create `test/unit/agent-history-discovery.test.ts` with these cases:

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vitest";
import { discoverAgentHistory, historySourceFromSessionRef } from "@/agent-history/discovery.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => import("node:fs/promises").then(({ rm }) => rm(dir, { force: true, recursive: true }))));
});

async function tempHome(name: string) {
  const dir = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(join(tmpdir(), name)));
  tempDirs.push(dir);
  return dir;
}

describe("agent history discovery", () => {
  test("maps session refs for new runtime sources", () => {
    expect(historySourceFromSessionRef({ agent: "codex", kind: "path", source: "herdr:codex", value: "/tmp/c.jsonl" })).toBe("codex-jsonl");
    expect(historySourceFromSessionRef({ agent: "opencode", kind: "id", source: "herdr:opencode", value: "ses_1" })).toBe("opencode-sqlite");
    expect(historySourceFromSessionRef({ agent: "gemini", kind: "path", source: "herdr:gemini", value: "/tmp/g.json" })).toBe("gemini-json");
  });

  test("discovers Codex JSONL by session_meta cwd", async () => {
    const homeDir = await tempHome("shepherd-codex-home-");
    const dir = join(homeDir, ".codex", "sessions", "2026", "07", "09");
    await mkdir(dir, { recursive: true });
    const older = join(dir, "rollout-2026-07-09T10-00-00-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl");
    const newer = join(dir, "rollout-2026-07-09T11-00-00-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl");
    await writeFile(older, JSON.stringify({ type: "session_meta", payload: { cwd: "/other" } }) + "\n");
    await writeFile(newer, JSON.stringify({ type: "session_meta", payload: { cwd: "/repo" } }) + "\n");

    await expect(discoverAgentHistory({ agent: "codex", agentSession: null, cwd: "/repo", foregroundCwd: null, homeDir })).resolves.toMatchObject({
      kind: "discovered_file",
      path: newer,
      source: "codex-jsonl",
      value: newer,
    });
  });

  test("discovers OpenCode DB session by cwd", async () => {
    const homeDir = await tempHome("shepherd-opencode-home-");
    const dbPath = join(homeDir, ".local", "share", "opencode", "opencode.db");
    await mkdir(join(homeDir, ".local", "share", "opencode"), { recursive: true });
    const sqlite = new DatabaseSync(dbPath);
    sqlite.exec("create table session (id text primary key, directory text not null, time_updated integer not null)");
    sqlite.prepare("insert into session (id, directory, time_updated) values (?, ?, ?)").run("s_old", "/repo", 1);
    sqlite.prepare("insert into session (id, directory, time_updated) values (?, ?, ?)").run("s_new", "/repo", 2);
    sqlite.close();

    await expect(discoverAgentHistory({ agent: "opencode", agentSession: null, cwd: "/repo", foregroundCwd: null, homeDir })).resolves.toMatchObject({
      kind: "discovered_file",
      path: dbPath,
      source: "opencode-sqlite",
      value: "s_new",
    });
  });

  test("discovers Gemini session JSON through .project_root", async () => {
    const homeDir = await tempHome("shepherd-gemini-home-");
    const projectDir = join(homeDir, ".gemini", "tmp", "repo-project");
    const chatsDir = join(projectDir, "chats");
    await mkdir(chatsDir, { recursive: true });
    await writeFile(join(projectDir, ".project_root"), "/repo\n");
    const sessionPath = join(chatsDir, "session-2026-07-09T12-00-00abcdef.json");
    await writeFile(sessionPath, JSON.stringify({ messages: [{ type: "user", content: [{ text: "hello" }] }] }));

    await expect(discoverAgentHistory({ agent: "gemini", agentSession: null, cwd: "/repo", foregroundCwd: null, homeDir })).resolves.toMatchObject({
      kind: "discovered_file",
      path: sessionPath,
      source: "gemini-json",
      value: sessionPath,
    });
  });
});
```

- [x] **Step 2: Write failing cache-source-key tests**

Create `test/unit/agent-history-service.test.ts` with this initial test:

```ts
import { describe, expect, test } from "vitest";
import { cacheSourcePathForRef } from "@/agent-history/service.js";
import type { AgentHistoryRef } from "@/observability/contracts.js";

describe("agent history service", () => {
  test("uses session-specific cache keys for OpenCode DB refs", () => {
    const first: AgentHistoryRef = { kind: "discovered_file", path: "/tmp/opencode.db", source: "opencode-sqlite", value: "session-a" };
    const second: AgentHistoryRef = { kind: "discovered_file", path: "/tmp/opencode.db", source: "opencode-sqlite", value: "session-b" };

    expect(cacheSourcePathForRef(first)).toBe("/tmp/opencode.db#session=session-a");
    expect(cacheSourcePathForRef(second)).toBe("/tmp/opencode.db#session=session-b");
  });

  test("uses file path cache keys for file-backed refs", () => {
    expect(cacheSourcePathForRef({ kind: "discovered_file", path: "/tmp/codex.jsonl", source: "codex-jsonl", value: "/tmp/codex.jsonl" })).toBe("/tmp/codex.jsonl");
  });
});
```

- [x] **Step 3: Run tests to verify they fail**

Run:

```bash
pnpm test test/unit/agent-history-discovery.test.ts test/unit/agent-history-service.test.ts
```

Expected:

- TypeScript/Vitest fails because `codex-jsonl`, `opencode-sqlite`, `gemini-json`, and `cacheSourcePathForRef` do not exist.
- Discovery assertions fail because only Pi and Claude fallback scans are implemented.

- [x] **Step 4: Extend contracts**

Update `src/observability/contracts.ts` `AgentHistoryRef.source` to this exact union:

```ts
source: "claude-jsonl" | "codex-jsonl" | "gemini-json" | "opencode-sqlite" | "pi-jsonl" | "unknown";
```

- [x] **Step 5: Extend discovery implementation**

Modify `src/agent-history/discovery.ts` with these implementation details:

1. Add imports:

```ts
import { DatabaseSync } from "node:sqlite";
```

2. Add runtime scans in `discoverAgentHistory()`:

```ts
  if (agent === "codex") {
    candidates.push(...(await scanRoot(join(homeDir, ".codex", "sessions"), "codex-jsonl")));
  }
  if (agent === "gemini") {
    candidates.push(...(await scanGeminiRoot(join(homeDir, ".gemini", "tmp"))));
  }
  if (agent === "opencode") {
    const ref = discoverOpenCodeSession({ cwd, homeDir, sessionId: input.agentSession?.kind === "id" ? input.agentSession.value : null });
    if (ref) return ref;
  }
```

3. Update `historySourceFromSessionRef()`:

```ts
export function historySourceFromSessionRef(ref: AgentSessionRef): AgentHistoryRef["source"] {
  const agent = ref.agent.toLowerCase();
  const source = ref.source.toLowerCase();
  if (agent === "pi" || source.includes("pi")) return "pi-jsonl";
  if (agent === "claude" || source.includes("claude")) return "claude-jsonl";
  if (agent === "codex" || source.includes("codex")) return "codex-jsonl";
  if (agent === "opencode" || source.includes("opencode")) return "opencode-sqlite";
  if (agent === "gemini" || source.includes("gemini")) return "gemini-json";
  return "unknown";
}
```

4. In the existing `agentSession.kind === "path"` branch, keep the current file-exists behavior for file-backed sources. Add a separate branch for OpenCode `id` refs before fallback scan:

```ts
  if (input.agentSession?.kind === "id") {
    const source = historySourceFromSessionRef(input.agentSession);
    if (source === "opencode-sqlite") {
      const ref = discoverOpenCodeSession({
        cwd: input.cwd ?? input.foregroundCwd,
        homeDir: input.homeDir ?? process.env.HOME ?? "",
        sessionId: input.agentSession.value,
      });
      if (ref) return { ...ref, kind: "agent_session" };
    }
  }
```

5. Extend `readCandidateCwd()` so Codex `session_meta.payload.cwd` is recognized:

```ts
      const payload = recordValue(record.payload);
      const payloadCwd = stringValue(payload.cwd) ?? stringValue(payload.foreground_cwd);
      if (payloadCwd) return payloadCwd;
```

6. Add these helper functions in `discovery.ts`:

```ts
async function scanGeminiRoot(root: string): Promise<Candidate[]> {
  if (!existsSync(root)) return [];
  const projectDirs = await listGeminiProjectDirs(root);
  const candidates: Candidate[] = [];
  for (const projectDir of projectDirs) {
    const cwd = (await readFile(join(projectDir, ".project_root"), "utf8").catch(() => "")).trim() || null;
    const sessions = await listGeminiSessionFiles(join(projectDir, "chats"));
    for (const path of sessions) {
      const stats = await stat(path).catch(() => null);
      if (!stats?.isFile()) continue;
      candidates.push({ cwd, mtimeMs: stats.mtimeMs, path, source: "gemini-json" });
    }
  }
  return candidates;
}

async function listGeminiProjectDirs(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const dirs: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (!entry.isDirectory()) continue;
    if (existsSync(join(path, ".project_root"))) dirs.push(path);
  }
  return dirs;
}

async function listGeminiSessionFiles(chatsDir: string): Promise<string[]> {
  const entries = await readdir(chatsDir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && entry.name.startsWith("session-") && entry.name.endsWith(".json"))
    .map((entry) => join(chatsDir, entry.name));
}

function discoverOpenCodeSession(input: { cwd: string | null; homeDir: string; sessionId: string | null }): AgentHistoryRef | null {
  const dbPath = resolveOpenCodeDbPath(input.homeDir);
  if (!existsSync(dbPath)) return null;
  let sqlite: DatabaseSync | null = null;
  try {
    sqlite = new DatabaseSync(dbPath, { readOnly: true });
    if (input.sessionId) {
      const row = sqlite.prepare("select id from session where id = ? limit 1").get(input.sessionId) as { id: string } | undefined;
      return row ? { kind: "discovered_file", path: dbPath, source: "opencode-sqlite", value: row.id } : null;
    }
    if (!input.cwd) return null;
    const row = sqlite
      .prepare("select id from session where directory = ? order by time_updated desc limit 1")
      .get(input.cwd) as { id: string } | undefined;
    return row ? { kind: "discovered_file", path: dbPath, source: "opencode-sqlite", value: row.id } : null;
  } catch {
    return null;
  } finally {
    sqlite?.close();
  }
}

function resolveOpenCodeDbPath(homeDir: string): string {
  const override = process.env.OPENCODE_DB;
  if (override && override !== ":memory:") {
    return override.startsWith("/") ? override : join(homeDir, ".local", "share", "opencode", override);
  }
  return join(homeDir, ".local", "share", "opencode", "opencode.db");
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}
```

- [x] **Step 6: Add cache source key helper**

In `src/agent-history/service.ts`, export this helper and use it for cache lookup/write `sourcePath` values:

```ts
export function cacheSourcePathForRef(historyRef: { path?: string; source: string; value: string }): string {
  const path = historyRef.path ?? historyRef.value;
  return historyRef.source === "opencode-sqlite" ? `${path}#session=${historyRef.value}` : path;
}
```

Then change both cache calls:

```ts
const path = historyRef.path ?? historyRef.value;
const cacheSourcePath = cacheSourcePathForRef(historyRef);
```

Use `path` only for `stat(path)` and `cacheSourcePath` for `sourcePath` in `getFresh()` and `put()`.

- [x] **Step 7: Run tests to verify they pass**

Run:

```bash
pnpm test test/unit/agent-history-discovery.test.ts test/unit/agent-history-service.test.ts
```

Expected: both test files pass.

- [x] **Step 8: Commit**

```bash
git add src/observability/contracts.ts src/agent-history/discovery.ts src/agent-history/service.ts test/unit/agent-history-discovery.test.ts test/unit/agent-history-service.test.ts
git commit -m "history: discover additional agent runtimes"
```

### Task 2: Add Codex JSONL reader

**Objective:** Parse Codex JSONL into normalized user, assistant, and compact tool-result messages.

**Files:**
- Create: `src/agent-history/codex-reader.ts`
- Modify: `src/agent-history/service.ts`
- Modify: `test/unit/agent-history-readers.test.ts`

**Interfaces:**
- Consumes: `readJsonl()`, `compactFromMessages()`, `limitMessages()`, `messageRef()`, `textFromContent()`, `timestampFrom()`, `compactToolResult()`.
- Produces: `CodexHistoryReader` implementing `AgentHistoryReader`.

- [x] **Step 1: Write failing Codex reader tests**

Create or extend `test/unit/agent-history-readers.test.ts`:

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { CodexHistoryReader } from "@/agent-history/codex-reader.js";
import { createAgentHistoryService } from "@/agent-history/service.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => import("node:fs/promises").then(({ rm }) => rm(dir, { force: true, recursive: true }))));
});

async function tempHome(name: string) {
  const dir = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(join(tmpdir(), name)));
  tempDirs.push(dir);
  return dir;
}

describe("CodexHistoryReader", () => {
  test("reads user, assistant, and tool output messages", async () => {
    const homeDir = await tempHome("shepherd-codex-reader-");
    const dir = join(homeDir, ".codex", "sessions", "2026", "07", "09");
    await mkdir(dir, { recursive: true });
    const path = join(dir, "rollout-2026-07-09T12-00-00-cccccccc-cccc-4ccc-8ccc-cccccccccccc.jsonl");
    await writeFile(
      path,
      [
        { type: "session_meta", payload: { cwd: "/repo", timestamp: "2026-07-09T12:00:00.000Z" } },
        { type: "event_msg", payload: { type: "user_message", message: "please inspect", timestamp: "2026-07-09T12:00:01.000Z" } },
        { type: "response_item", payload: { type: "function_call", call_id: "call_1", name: "bash", arguments: "{}" } },
        { type: "response_item", payload: { type: "function_call_output", call_id: "call_1", output: "line 1\nline 2" } },
        { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] } },
      ].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    );

    const messages = await new CodexHistoryReader().read({ kind: "discovered_file", path, source: "codex-jsonl", value: path }, { limit: 20 });

    expect(messages.map((message) => message.role)).toEqual(["user", "tool_result", "assistant"]);
    expect(messages[0]).toMatchObject({ role: "user", text: "please inspect" });
    expect(messages[1]).toMatchObject({ role: "tool_result", toolName: "bash" });
    expect(messages[1]?.compact?.text).toContain("line 1");
    expect(messages[2]).toMatchObject({ role: "assistant", text: "done" });
  });

  test("is registered in the default agent history service", async () => {
    const homeDir = await tempHome("shepherd-codex-service-");
    const dir = join(homeDir, ".codex", "sessions", "2026", "07", "09");
    await mkdir(dir, { recursive: true });
    const path = join(dir, "rollout-2026-07-09T13-00-00-dddddddd-dddd-4ddd-8ddd-dddddddddddd.jsonl");
    await writeFile(path, JSON.stringify({ type: "session_meta", payload: { cwd: "/repo" } }) + "\n" + JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "hello" } }) + "\n");

    const service = createAgentHistoryService({ homeDir });
    await expect(service.read({ agent: "codex", agentSession: null, cwd: "/repo", foregroundCwd: null }, { limit: 10 })).resolves.toMatchObject({
      historyRef: { source: "codex-jsonl", path },
      messages: [expect.objectContaining({ role: "user", text: "hello" })],
    });
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm test test/unit/agent-history-readers.test.ts
```

Expected: fails because `src/agent-history/codex-reader.ts` does not exist and service registry lacks `CodexHistoryReader`.

- [x] **Step 3: Create `CodexHistoryReader`**

Create `src/agent-history/codex-reader.ts` with this complete implementation shape:

```ts
import type { AgentHistoryMessage, AgentHistoryRef } from "@/observability/contracts.js";
import { type AgentHistoryReader, compactFromMessages, limitMessages, readJsonl } from "./readers.js";
import { messageRef, textFromContent, timestampFrom } from "./text.js";
import { compactToolResult } from "./tool-compaction.js";

export class CodexHistoryReader implements AgentHistoryReader {
  canRead(ref: AgentHistoryRef): boolean {
    return ref.source === "codex-jsonl" && Boolean(ref.path ?? ref.value);
  }

  async read(ref: AgentHistoryRef, options: { limit?: number } = {}): Promise<AgentHistoryMessage[]> {
    const path = ref.path ?? ref.value;
    const messages: AgentHistoryMessage[] = [];
    const toolNamesByCallId = new Map<string, string>();

    for (const entry of await readJsonl(path)) {
      const type = stringValue(entry.value.type);
      const payload = record(entry.value.payload);
      const payloadType = stringValue(payload.type);
      const id = stringValue(payload.id) ?? stringValue(payload.call_id) ?? stringValue(entry.value.id);
      const timestamp = timestampFrom(payload.timestamp) ?? timestampFrom(payload.started_at) ?? timestampFrom(entry.value.timestamp);
      const refValue = messageRef(path, id ?? undefined, entry.line);

      if (type === "event_msg") {
        if (payloadType === "user_message") {
          const text = stringValue(payload.message);
          if (text && !isSystemCodexMessage(text)) messages.push({ ref: refValue, role: "user", text, timestamp });
          continue;
        }
        if (payloadType === "agent_message") {
          const text = stringValue(payload.message);
          if (text) messages.push({ ref: refValue, role: "assistant", text, timestamp });
          continue;
        }
        if (payloadType === "task_complete") {
          const text = stringValue(payload.last_agent_message);
          if (text) messages.push({ ref: refValue, role: "assistant", text, timestamp });
          continue;
        }
      }

      if (type !== "response_item") continue;

      if (payloadType === "function_call" || payloadType === "custom_tool_call") {
        const callId = stringValue(payload.call_id);
        const name = stringValue(payload.name);
        if (callId && name) toolNamesByCallId.set(callId, name);
        continue;
      }

      if (payloadType === "function_call_output" || payloadType === "custom_tool_call_output") {
        const callId = stringValue(payload.call_id);
        const toolName = (callId ? toolNamesByCallId.get(callId) : null) ?? "unknown";
        const text = textFromCodexOutput(payload.output);
        const compact = compactToolResult({ isError: false, ref: refValue, text, toolName });
        messages.push({ compact, ref: refValue, role: "tool_result", text: compact.text, timestamp, toolName });
        continue;
      }

      if (payloadType === "message") {
        const role = stringValue(payload.role);
        if (role === "developer") continue;
        if (role === "user") {
          const text = textFromCodexContent(payload.content, "input_text");
          if (text && !isSystemCodexMessage(text)) messages.push({ ref: refValue, role: "user", text, timestamp });
          continue;
        }
        if (role === "assistant") {
          const text = textFromCodexContent(payload.content, "output_text") ?? textFromContent(payload.content);
          if (text) messages.push({ ref: refValue, role: "assistant", text, timestamp });
        }
      }
    }

    return limitMessages(messages, options.limit);
  }

  async readCompact(ref: AgentHistoryRef) {
    return compactFromMessages(ref, await this.read(ref));
  }
}

function textFromCodexContent(content: unknown, blockType: string): string | null {
  if (!Array.isArray(content)) return typeof content === "string" ? content : null;
  const parts = content
    .map((block) => {
      const item = record(block);
      if (item.type !== blockType) return "";
      return stringValue(item.text) ?? "";
    })
    .filter((part) => part.trim().length > 0);
  return parts.length > 0 ? parts.join("\n") : null;
}

function textFromCodexOutput(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value ?? "");
}

function isSystemCodexMessage(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("<environment_context>") || trimmed.startsWith("<user_instructions>");
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
```

- [x] **Step 4: Register Codex reader**

Modify `src/agent-history/service.ts`:

```ts
import { CodexHistoryReader } from "./codex-reader.js";
```

Change the default registry to:

```ts
const readers = options.readers ?? [
  new PiHistoryReader(),
  new ClaudeHistoryReader(),
  new CodexHistoryReader(),
];
```

- [x] **Step 5: Run tests to verify they pass**

Run:

```bash
pnpm test test/unit/agent-history-discovery.test.ts test/unit/agent-history-readers.test.ts test/unit/agent-history-service.test.ts
```

Expected: all tests pass.

- [x] **Step 6: Commit**

```bash
git add src/agent-history/codex-reader.ts src/agent-history/service.ts test/unit/agent-history-readers.test.ts
git commit -m "history: parse codex sessions"
```

### Task 3: Add OpenCode SQLite reader

**Objective:** Read OpenCode session history from SQLite and normalize text/tool parts.

**Files:**
- Create: `src/agent-history/opencode-reader.ts`
- Modify: `src/agent-history/service.ts`
- Modify: `test/unit/agent-history-readers.test.ts`
- Modify: `test/unit/agent-history-service.test.ts` if extra cache assertions are useful after implementation.

**Interfaces:**
- Consumes: OpenCode `AgentHistoryRef` convention where `path` is DB path and `value` is session id.
- Produces: `OpenCodeHistoryReader` implementing `AgentHistoryReader`.

- [x] **Step 1: Write failing OpenCode reader tests**

Append to `test/unit/agent-history-readers.test.ts`:

```ts
import { DatabaseSync } from "node:sqlite";
import { OpenCodeHistoryReader } from "@/agent-history/opencode-reader.js";

describe("OpenCodeHistoryReader", () => {
  test("reads text and tool parts from an OpenCode SQLite session", async () => {
    const homeDir = await tempHome("shepherd-opencode-reader-");
    const dbPath = join(homeDir, "opencode.db");
    const sqlite = new DatabaseSync(dbPath);
    sqlite.exec(`
      create table session (id text primary key, directory text not null, time_updated integer not null);
      create table message (id text primary key, session_id text not null, time_created integer not null, time_updated integer not null, data text not null);
      create table part (id text primary key, message_id text not null, session_id text not null, time_created integer not null, time_updated integer not null, data text not null);
    `);
    sqlite.prepare("insert into session (id, directory, time_updated) values (?, ?, ?)").run("s1", "/repo", 1000);
    sqlite.prepare("insert into message (id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?)").run("m1", "s1", 1000, 1000, JSON.stringify({ role: "user" }));
    sqlite.prepare("insert into part (id, message_id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?)").run("p1", "m1", "s1", 1001, 1001, JSON.stringify({ type: "text", text: "inspect this" }));
    sqlite.prepare("insert into message (id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?)").run("m2", "s1", 2000, 2000, JSON.stringify({ role: "assistant", finish: "tool-calls" }));
    sqlite.prepare("insert into part (id, message_id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?)").run("p2", "m2", "s1", 2001, 2001, JSON.stringify({ type: "tool", tool: "bash", state: { status: "completed", output: "ok" } }));
    sqlite.prepare("insert into part (id, message_id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?)").run("p3", "m2", "s1", 2002, 2002, JSON.stringify({ type: "text", text: "done" }));
    sqlite.close();

    const messages = await new OpenCodeHistoryReader().read({ kind: "discovered_file", path: dbPath, source: "opencode-sqlite", value: "s1" }, { limit: 10 });

    expect(messages.map((message) => message.role)).toEqual(["user", "tool_result", "assistant"]);
    expect(messages[0]).toMatchObject({ role: "user", text: "inspect this" });
    expect(messages[1]).toMatchObject({ role: "tool_result", toolName: "bash" });
    expect(messages[1]?.compact?.text).toContain("ok");
    expect(messages[2]).toMatchObject({ role: "assistant", text: "done" });
  });

  test("returns empty history when the OpenCode DB schema is unreadable", async () => {
    const homeDir = await tempHome("shepherd-opencode-bad-db-");
    const dbPath = join(homeDir, "opencode.db");
    const sqlite = new DatabaseSync(dbPath);
    sqlite.exec("create table unrelated (id text primary key)");
    sqlite.close();

    await expect(new OpenCodeHistoryReader().read({ kind: "discovered_file", path: dbPath, source: "opencode-sqlite", value: "s1" }, { limit: 10 })).resolves.toEqual([]);
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm test test/unit/agent-history-readers.test.ts
```

Expected: fails because `OpenCodeHistoryReader` does not exist.

- [x] **Step 3: Create `OpenCodeHistoryReader`**

Create `src/agent-history/opencode-reader.ts` with this complete implementation shape:

```ts
import { DatabaseSync } from "node:sqlite";
import type { AgentHistoryMessage, AgentHistoryRef } from "@/observability/contracts.js";
import { type AgentHistoryReader, compactFromMessages, limitMessages } from "./readers.js";
import { messageRef, textFromContent, timestampFrom } from "./text.js";
import { compactToolResult } from "./tool-compaction.js";

type OpenCodeRow = {
  message_id: string;
  message_time: number;
  part_data: string | null;
  part_id: string | null;
  part_time: number | null;
  role: string | null;
};

export class OpenCodeHistoryReader implements AgentHistoryReader {
  canRead(ref: AgentHistoryRef): boolean {
    return ref.source === "opencode-sqlite" && Boolean(ref.path) && Boolean(ref.value);
  }

  async read(ref: AgentHistoryRef, options: { limit?: number } = {}): Promise<AgentHistoryMessage[]> {
    const dbPath = ref.path;
    if (!dbPath) return [];
    let sqlite: DatabaseSync | null = null;
    try {
      sqlite = new DatabaseSync(dbPath, { readOnly: true });
      const rows = sqlite
        .prepare(`
          select
            m.id as message_id,
            m.time_created as message_time,
            json_extract(m.data, '$.role') as role,
            p.id as part_id,
            p.time_created as part_time,
            p.data as part_data
          from message m
          left join part p on p.message_id = m.id
          where m.session_id = ?
          order by m.time_created asc, p.time_created asc, p.id asc
        `)
        .all(ref.value) as OpenCodeRow[];

      const messages: AgentHistoryMessage[] = [];
      for (const row of rows) {
        if (!row.part_data) continue;
        const part = parseJsonRecord(row.part_data);
        const partType = stringValue(part.type);
        const timestamp = timestampFrom(row.part_time ?? row.message_time);
        const refValue = messageRef(dbPath, row.part_id ?? row.message_id, 0);

        if (partType === "text") {
          const role = row.role === "assistant" || row.role === "user" ? row.role : null;
          const text = stringValue(part.text) ?? textFromContent(part.content);
          if (role && text) messages.push({ ref: refValue, role, text, timestamp });
          continue;
        }

        if (partType === "tool") {
          const toolName = stringValue(part.tool) ?? "unknown";
          const state = record(part.state);
          const output = state.output ?? state.error ?? part.output ?? part.content ?? part;
          const text = typeof output === "string" ? output : JSON.stringify(output);
          const isError = Boolean(state.error) || stringValue(state.status) === "error";
          const compact = compactToolResult({ isError, ref: refValue, text, toolName });
          messages.push({ compact, ref: refValue, role: "tool_result", text: compact.text, timestamp, toolName });
        }
      }
      return limitMessages(messages, options.limit);
    } catch {
      return [];
    } finally {
      sqlite?.close();
    }
  }

  async readCompact(ref: AgentHistoryRef) {
    return compactFromMessages(ref, await this.read(ref));
  }
}

function parseJsonRecord(value: string): Record<string, unknown> {
  try {
    return record(JSON.parse(value) as unknown);
  } catch {
    return {};
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
```

- [x] **Step 4: Register OpenCode reader**

Modify `src/agent-history/service.ts`:

```ts
import { OpenCodeHistoryReader } from "./opencode-reader.js";
```

Add it to the default registry after `CodexHistoryReader`:

```ts
new OpenCodeHistoryReader(),
```

- [x] **Step 5: Run tests to verify they pass**

Run:

```bash
pnpm test test/unit/agent-history-discovery.test.ts test/unit/agent-history-readers.test.ts test/unit/agent-history-service.test.ts
```

Expected: all tests pass, including OpenCode discovery and reader cases.

- [x] **Step 6: Commit**

```bash
git add src/agent-history/opencode-reader.ts src/agent-history/service.ts test/unit/agent-history-readers.test.ts test/unit/agent-history-service.test.ts
git commit -m "history: parse opencode sessions"
```

### Task 4: Add Gemini CLI session JSON reader

**Objective:** Parse Gemini CLI session JSON into normalized messages and discover the correct session through `.project_root` + `chats/session-*.json`.

**Files:**
- Create: `src/agent-history/gemini-reader.ts`
- Modify: `src/agent-history/service.ts`
- Modify: `test/unit/agent-history-readers.test.ts`

**Interfaces:**
- Consumes: Gemini `AgentHistoryRef` convention where `path` and `value` are session JSON path.
- Produces: `GeminiHistoryReader` implementing `AgentHistoryReader`.

- [x] **Step 1: Write failing Gemini reader tests**

Append to `test/unit/agent-history-readers.test.ts`:

```ts
import { GeminiHistoryReader } from "@/agent-history/gemini-reader.js";

describe("GeminiHistoryReader", () => {
  test("reads user and gemini assistant messages from object-shaped session JSON", async () => {
    const homeDir = await tempHome("shepherd-gemini-reader-");
    const projectDir = join(homeDir, ".gemini", "tmp", "repo-project");
    const chatsDir = join(projectDir, "chats");
    await mkdir(chatsDir, { recursive: true });
    const sessionPath = join(chatsDir, "session-2026-07-09T12-00-00abcdef.json");
    await writeFile(
      sessionPath,
      JSON.stringify({
        sessionId: "g1",
        messages: [
          { id: "u1", timestamp: "2026-07-09T12:00:00.000Z", type: "user", content: [{ text: "please check" }] },
          { id: "a1", timestamp: "2026-07-09T12:00:01.000Z", type: "gemini", content: "checked" },
          { id: "i1", timestamp: "2026-07-09T12:00:02.000Z", type: "info", content: "ignored" },
        ],
      }),
    );

    const messages = await new GeminiHistoryReader().read({ kind: "discovered_file", path: sessionPath, source: "gemini-json", value: sessionPath }, { limit: 10 });

    expect(messages).toEqual([
      expect.objectContaining({ role: "user", text: "please check", timestamp: "2026-07-09T12:00:00.000Z" }),
      expect.objectContaining({ role: "assistant", text: "checked", timestamp: "2026-07-09T12:00:01.000Z" }),
    ]);
  });

  test("reads tool result messages when Gemini session records tool output", async () => {
    const homeDir = await tempHome("shepherd-gemini-tool-");
    const sessionPath = join(homeDir, "session.json");
    await writeFile(
      sessionPath,
      JSON.stringify({
        messages: [
          { id: "t1", timestamp: "2026-07-09T12:00:03.000Z", type: "tool", tool: "shell", content: "ok" },
        ],
      }),
    );

    const messages = await new GeminiHistoryReader().read({ kind: "discovered_file", path: sessionPath, source: "gemini-json", value: sessionPath }, { limit: 10 });

    expect(messages).toEqual([expect.objectContaining({ role: "tool_result", toolName: "shell" })]);
    expect(messages[0]?.compact?.text).toContain("ok");
  });

  test("returns empty history when Gemini session JSON is malformed", async () => {
    const homeDir = await tempHome("shepherd-gemini-bad-json-");
    const sessionPath = join(homeDir, "session.json");
    await writeFile(sessionPath, "{not-json");

    await expect(new GeminiHistoryReader().read({ kind: "discovered_file", path: sessionPath, source: "gemini-json", value: sessionPath }, { limit: 10 })).resolves.toEqual([]);
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm test test/unit/agent-history-readers.test.ts
```

Expected: fails because `GeminiHistoryReader` does not exist.

- [x] **Step 3: Create `GeminiHistoryReader`**

Create `src/agent-history/gemini-reader.ts` with this complete implementation shape:

```ts
import { readFile } from "node:fs/promises";
import type { AgentHistoryMessage, AgentHistoryRef } from "@/observability/contracts.js";
import { type AgentHistoryReader, compactFromMessages, limitMessages } from "./readers.js";
import { messageRef, textFromContent, timestampFrom } from "./text.js";
import { compactToolResult } from "./tool-compaction.js";

export class GeminiHistoryReader implements AgentHistoryReader {
  canRead(ref: AgentHistoryRef): boolean {
    return ref.source === "gemini-json" && Boolean(ref.path ?? ref.value);
  }

  async read(ref: AgentHistoryRef, options: { limit?: number } = {}): Promise<AgentHistoryMessage[]> {
    const path = ref.path ?? ref.value;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    } catch {
      return [];
    }
    const records = geminiMessages(parsed);
    const messages: AgentHistoryMessage[] = [];

    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      const type = stringValue(record.type);
      const id = stringValue(record.id);
      const timestamp = timestampFrom(record.timestamp) ?? timestampFrom(record.time) ?? timestampFrom(record.createdAt);
      const refValue = messageRef(path, id ?? undefined, index + 1);

      if (type === "user") {
        const text = geminiText(record.content);
        if (text) messages.push({ ref: refValue, role: "user", text, timestamp });
        continue;
      }

      if (type === "gemini" || type === "assistant" || type === "model") {
        const text = geminiText(record.content);
        if (text) messages.push({ ref: refValue, role: "assistant", text, timestamp });
        continue;
      }

      if (type === "tool" || type === "tool_result" || type === "tool_response") {
        const toolName = stringValue(record.tool) ?? stringValue(record.name) ?? "unknown";
        const output = record.output ?? record.response ?? record.content ?? record.result ?? record;
        const text = typeof output === "string" ? output : JSON.stringify(output);
        const isError = record.isError === true || record.error !== undefined;
        const compact = compactToolResult({ isError, ref: refValue, text, toolName });
        messages.push({ compact, ref: refValue, role: "tool_result", text: compact.text, timestamp, toolName });
      }
    }

    return limitMessages(messages, options.limit);
  }

  async readCompact(ref: AgentHistoryRef) {
    return compactFromMessages(ref, await this.read(ref));
  }
}

function geminiMessages(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.map(record).filter((item) => Object.keys(item).length > 0);
  const root = record(value);
  const messages = root.messages;
  return Array.isArray(messages) ? messages.map(record).filter((item) => Object.keys(item).length > 0) : [];
}

function geminiText(value: unknown): string | null {
  if (typeof value === "string") return value;
  const text = textFromContent(value);
  if (text) return text;
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => {
        const block = record(item);
        return stringValue(block.text) ?? stringValue(block.content) ?? "";
      })
      .filter((part) => part.trim().length > 0);
    return parts.length > 0 ? parts.join("\n") : null;
  }
  return null;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
```

- [x] **Step 4: Register Gemini reader**

Modify `src/agent-history/service.ts`:

```ts
import { GeminiHistoryReader } from "./gemini-reader.js";
```

Add it to the default registry after `OpenCodeHistoryReader`:

```ts
new GeminiHistoryReader(),
```

- [x] **Step 5: Run tests to verify they pass**

Run:

```bash
pnpm test test/unit/agent-history-discovery.test.ts test/unit/agent-history-readers.test.ts test/unit/agent-history-service.test.ts
```

Expected: all tests pass, including Gemini discovery and reader cases.

- [x] **Step 6: Commit**

```bash
git add src/agent-history/gemini-reader.ts src/agent-history/service.ts test/unit/agent-history-readers.test.ts
git commit -m "history: parse gemini sessions"
```

### Task 5: Add RPC integration coverage and update user-facing source docs

**Objective:** Prove the daemon uses the new history sources through existing `agent.read` RPC and update user-facing docs only where they describe supported history sources.

**Files:**
- Modify: `test/integration/observability-rpc.test.ts`
- Modify: `README.md`
- Modify: `README.ja.md`

**Interfaces:**
- Consumes: registered default readers in `createAgentHistoryService()`.
- Produces: integration proof that runtime-specific parsing is hidden behind existing RPC.

- [x] **Step 1: Write failing RPC integration tests**

In `test/integration/observability-rpc.test.ts`, add a new test in `describe("ObservabilityRpcServer", ...)` that creates three history fixtures under the temp `homeDir` used by `openServerWithoutClient()` and seeds three agents.

First update the test helper so the caller can access that temp home directory:

```ts
async function openServerWithoutClient() {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-agent-rpc-"));
  tempDirs.push(dir);
  const socketPath = join(dir, "rpc.sock");
  if (existsSync(socketPath)) unlinkSync(socketPath);
  const harness = openObservabilityDbHarness();
  const server = new ObservabilityRpcServer({
    history: createAgentHistoryService({ cache: harness.agentHistoryCache, homeDir: dir }),
    notifications: new AgentNotificationService({ cursors: harness.agentNotificationCursors }),
    socketPath,
    stores: {
      agentEvents: harness.agentEvents,
      agents: harness.agents,
      herdrWorkspaces: harness.herdrWorkspaces,
    },
  });
  servers.push(server);
  await server.start();
  return { dir, harness, server, socketPath };
}
```

Use this exact fixture strategy:

1. For Codex:
   - Create `${dir}/.codex/sessions/2026/07/09/rollout-2026-07-09T12-00-00-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.jsonl`.
   - Include `session_meta.payload.cwd = "/repo-codex"` and one `event_msg.user_message`.
2. For OpenCode:
   - Create `${dir}/.local/share/opencode/opencode.db`.
   - Create `session`, `message`, and `part` tables as in Task 3.
   - Insert session `oc_1` with `directory = "/repo-opencode"` and one user text part.
3. For Gemini:
   - Create `${dir}/.gemini/tmp/repo-gemini/.project_root` containing `/repo-gemini`.
   - Create `${dir}/.gemini/tmp/repo-gemini/chats/session-2026-07-09T12-00-00abcdef.json` with one `type="user"` message.

Seed agents with `harness.agents.replaceForSession()`:

```ts
harness.agents.replaceForSession({
  herdrSessionName: "default",
  agents: [
    { agent: "codex", agent_status: "idle", cwd: "/repo-codex", pane_id: "wB:p-codex", terminal_id: "term_codex", workspace_id: "wB" },
    { agent: "opencode", agent_status: "idle", cwd: "/repo-opencode", pane_id: "wB:p-opencode", terminal_id: "term_opencode", workspace_id: "wB" },
    { agent: "gemini", agent_status: "idle", cwd: "/repo-gemini", pane_id: "wB:p-gemini", terminal_id: "term_gemini", workspace_id: "wB" },
  ],
});
```

Assert these RPC calls:

```ts
await expect(client.request("agent.read", { limit: 10, target: "codex", workspaceId: "wB" })).resolves.toMatchObject({
  agent: { historyRef: { source: "codex-jsonl" }, messages: [expect.objectContaining({ role: "user" })] },
});
await expect(client.request("agent.read", { limit: 10, target: "opencode", workspaceId: "wB" })).resolves.toMatchObject({
  agent: { historyRef: { source: "opencode-sqlite", value: "oc_1" }, messages: [expect.objectContaining({ role: "user" })] },
});
await expect(client.request("agent.read", { limit: 10, target: "gemini", workspaceId: "wB" })).resolves.toMatchObject({
  agent: { historyRef: { source: "gemini-json" }, messages: [expect.objectContaining({ role: "user" })] },
});
```

- [x] **Step 2: Run integration test**

Run:

```bash
pnpm test test/integration/observability-rpc.test.ts
```

Expected: passes if Tasks 1-4 are complete. If it fails, fix the reader/discovery integration instead of adding RPC-specific runtime branching.

- [x] **Step 3: Update README files**

Update `README.md` near the feature list with one concise sentence:

```md
Shepherd currently reads compact history from Pi, Claude Code, Codex, OpenCode, and Gemini CLI sessions when Herdr identifies those agents or their history can be discovered from the workspace directory.
```

Update `README.ja.md` with the matching Japanese sentence:

```md
Shepherd は現在、Herdr が agent を識別できる場合、または workspace directory から履歴を発見できる場合に、Pi、Claude Code、Codex、OpenCode、Gemini CLI の短い履歴を読み取れます。
```

Do not update package READMEs unless their current wording claims a narrower supported runtime list. The current package READMEs describe the Pi extension/plugin behavior and do not need runtime-source lists.

- [x] **Step 4: Run targeted checks**

Run:

```bash
pnpm test test/unit/agent-history-discovery.test.ts test/unit/agent-history-readers.test.ts test/unit/agent-history-service.test.ts test/integration/observability-rpc.test.ts
pnpm lint
pnpm format:check
```

Expected: all commands pass.

- [x] **Step 5: Commit**

```bash
git add test/integration/observability-rpc.test.ts README.md README.ja.md
git commit -m "test: cover additional history runtimes"
```

### Task 6: Run full validation and fix type/lint drift

**Objective:** Verify the whole repository after the new runtime readers are in place.

**Files:**
- Modify only files touched by Tasks 1-5 if validation finds type, lint, or format issues.

**Interfaces:**
- Consumes: all completed tasks.
- Produces: repository-wide validation result.

- [x] **Step 1: Run full check**

Run:

```bash
pnpm check
```

Expected: typecheck, Vitest, Biome, Drizzle, Pi package, and Herdr plugin package checks all pass.

- [x] **Step 2: Run build if CLI import resolution changed**

Because this plan adds new files imported by `src/agent-history/service.ts`, run:

```bash
pnpm build
```

Expected: TypeScript builds `dist`, and `tsc-alias` resolves `@/*` imports without errors.

- [x] **Step 3: Fix any validation failures within scope**

If validation fails:

- Type errors in new source unions: update exhaustive source annotations and tests in the same task branch.
- Biome import ordering/formatting failures: run `pnpm lint:fix`, inspect the diff, and keep only formatting/import-order changes in touched files.
- Reader parsing failures: fix the specific reader; do not add special cases to daemon/RPC/CLI layers.

Then rerun:

```bash
pnpm check
pnpm build
```

Expected: both commands pass.

- [x] **Step 4: Commit validation fixes**

If Step 3 changed files:

```bash
git add src/agent-history src/observability/contracts.ts test README.md README.ja.md
git commit -m "chore: validate history runtime support"
```

If Step 3 did not change files, do not create an empty commit.

## Validation

Run these after all tasks:

```bash
pnpm test test/unit/agent-history-discovery.test.ts test/unit/agent-history-readers.test.ts test/unit/agent-history-service.test.ts test/integration/observability-rpc.test.ts
pnpm check
pnpm build
```

Expected:

- Unit tests prove discovery and parsing for Codex, OpenCode, and Gemini.
- Integration tests prove `agent.read` returns messages for the new runtime sources through the existing daemon RPC.
- `pnpm check` passes all repository gates.
- `pnpm build` succeeds with the new service imports.

Manual smoke check after build, when a real Herdr workspace has these agents:

```bash
shepherd daemon start
shepherd agent list --all --json
shepherd agent read codex --limit 10 --json
shepherd agent read opencode --limit 10 --json
shepherd agent read gemini --limit 10 --json
```

Expected:

- `agent list --all --json` shows compact last user/assistant messages for supported panes when history is discoverable.
- `agent read` for each target returns `historyRef.source` equal to `codex-jsonl`, `opencode-sqlite`, or `gemini-json` and returns recent normalized messages.
- Tool outputs appear as compact `tool_result` messages and do not expose full raw outputs in compact history.

## Risks, Tradeoffs, and Open Questions

- **OpenCode cache collision:** One DB contains many sessions. This plan changes only the cache source key string and does not require a DB migration because `agent_history_cache.source_path` already stores arbitrary text.
- **OpenCode DB schema drift:** Tests use the observed tables `session`, `message`, and `part`. If OpenCode changes table names, discovery/read should fail closed by returning no history rather than throwing from daemon operations. Catch SQLite prepare/query errors in discovery and reader if validation with real DB shows schema mismatch.
- **Gemini JSON shape drift:** Current observed shape is object with `messages`. The reader also accepts an array root. Unsupported message types are ignored.
- **Codex duplicate assistant text:** Codex can record both `event_msg.agent_message` and `response_item.message` for assistant text. The initial reader keeps both normalized messages if both exist. If real output is too noisy, add a follow-up dedupe rule keyed by same text + close timestamp; do not add it in the first implementation without a failing test.
- **Discovery ambiguity:** For multiple sessions with the same CWD, discovery picks latest mtime/time_updated. This matches current Pi/Claude fallback style and ZAM behavior. Herdr `agent_session` should be preferred when available.
- **Task names are out of scope:** ZAM uses Codex `session_index.jsonl` and Gemini title/session detail to display task names. Shepherd history currently exposes messages, not task names. This plan does not add task fields to contracts.
