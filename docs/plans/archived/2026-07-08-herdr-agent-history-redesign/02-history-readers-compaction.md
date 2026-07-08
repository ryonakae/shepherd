# Agent History Discovery, Readers, and Compaction Plan

> **For implementers:** Execute this plan task-by-task. Complete each checkbox step, run the listed validation, and commit after each task.

**Goal:** Discover Pi and Claude agent history files, parse user/assistant/tool_result messages, and compact tool results without returning raw full tool output.

**Architecture:** Add a new `src/agent-history/` layer independent of daemon and DB. It resolves an `AgentHistoryRef` from Herdr `agent_session` first, then built-in runtime discovery from agent name and cwd. Readers parse JSONL into normalized `AgentHistoryMessage[]`; a compactor turns tool results into bounded, source-aware summaries with explicit compaction metadata.

**Tech Stack:** TypeScript, Node.js fs/path APIs, Vitest.

## Global Constraints

- Source of truth is the original agent history file, not DB cache.
- Built-in discovery must require no user-installed adapters or config.
- Support at least Pi and Claude Code histories in this rewrite.
- `read` messages include `tool_result` because assistant messages can depend on tool output.
- Tool result text must be compact by default and include `compaction.mode`, `originalChars`, and `returnedChars`.
- Do not include hidden thinking or full raw tool outputs in default output.
- History readers must be deterministic structured extraction only. Do not call an LLM for digest/summary.

## Current Context

- Current `src/observability/pi-transcript-adapter.ts` only returns last assistant and last tool hints. It should be replaced or moved into the new agent history layer.
- Observed Pi history path example: `~/.pi/agent/sessions/--Users-ryo.nakae-Dev-_sandbox-shepherd-test--/*.jsonl`.
- Observed Claude history path example: `~/.claude/projects/-Users-ryo-nakae-Dev--sandbox-shepherd-test/*.jsonl`.
- Pi JSONL entries use `type: "message"` with `message.role` equal to `user`, `assistant`, or `toolResult`.
- Claude JSONL entries use top-level `type` values such as `user` and `assistant`, with nested `message.role` and `message.content`.
- RTK reference: compaction should prefer tool-specific extraction/failure focus and fallback with explicit marker.

## File Structure

- Create: `src/agent-history/discovery.ts` — resolve history refs from agent metadata and filesystem.
- Create: `src/agent-history/readers.ts` — reader registry and common JSONL utilities.
- Create: `src/agent-history/pi-reader.ts` — parse Pi JSONL.
- Create: `src/agent-history/claude-reader.ts` — parse Claude JSONL.
- Create: `src/agent-history/text.ts` — text extraction, redaction, truncation, ref helpers.
- Create: `src/agent-history/tool-compaction.ts` — compact tool result content.
- Create: `src/agent-history/service.ts` — high-level `getCompactHistory()` and `readAgentHistory()` facade.
- Delete or replace: `src/observability/pi-transcript-adapter.ts` after call sites move.
- Test: `test/unit/agent-history-discovery.test.ts`
- Test: `test/unit/agent-history-readers.test.ts`
- Test: `test/unit/tool-compaction.test.ts`

## Interfaces

Create these interfaces in `src/agent-history/service.ts` or re-export them from `contracts.ts`:

```ts
export type AgentHistoryLookupInput = {
  agent: string | null;
  agentSession: AgentSessionRef | null;
  cwd: string | null;
  foregroundCwd: string | null;
  homeDir?: string;
};

export type AgentHistoryReader = {
  canRead(ref: AgentHistoryRef): boolean;
  read(ref: AgentHistoryRef, options: { limit?: number }): Promise<AgentHistoryMessage[]>;
  readCompact(ref: AgentHistoryRef): Promise<CompactAgentHistory>;
};

export type AgentHistoryService = {
  discover(input: AgentHistoryLookupInput): Promise<AgentHistoryRef | null>;
  getCompactHistory(input: AgentHistoryLookupInput): Promise<CompactAgentHistory>;
  read(input: AgentHistoryLookupInput, options: { limit: number }): Promise<{ historyRef: AgentHistoryRef | null; messages: AgentHistoryMessage[] }>;
};
```

## Tasks

### Task 1: Build history discovery for Herdr agent_session, Pi, and Claude

**Objective:** Resolve an agent history reference without user config.

**Files:**
- Create: `src/agent-history/discovery.ts`
- Create: `src/agent-history/text.ts`
- Test: `test/unit/agent-history-discovery.test.ts`

**Interfaces:**
- Consumes: `AgentIndexRecord`-like metadata fields and `AgentSessionRef`.
- Produces: `discoverAgentHistory(input): Promise<AgentHistoryRef | null>`.

- [x] **Step 1: Write the failing tests**

Create temp HOME directories and test these cases:

1. If `agentSession` is `{ source: "herdr:pi", agent: "pi", kind: "path", value: "/tmp/pi.jsonl" }` and the file exists, discovery returns `{ kind: "agent_session", source: "pi-jsonl", value: "/tmp/pi.jsonl", path: "/tmp/pi.jsonl" }`.
2. If `agentSession.kind === "path"` but file is missing, discovery falls back to built-in scanning.
3. Pi fallback scans `HOME/.pi/agent/sessions/**.jsonl`, prefers files whose session entry cwd equals the agent cwd, then latest mtime.
4. Claude fallback scans `HOME/.claude/projects/**/*.jsonl`, prefers files whose top-level `cwd` or first message cwd metadata equals the agent cwd when present, then latest mtime.
5. If no candidate matches, discovery returns `null`.
6. Discovery uses `foregroundCwd` when `cwd` is null.

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm test test/unit/agent-history-discovery.test.ts`

Expected: Import fails because discovery module does not exist.

- [x] **Step 3: Write minimal implementation**

Implement `discoverAgentHistory()` with this precedence:

1. Existing `agentSession.kind === "path"` and file exists.
2. Runtime-specific scan for `agent === "pi"`.
3. Runtime-specific scan for `agent === "claude"`.
4. Return `null`.

Use filesystem scanning with bounded traversal:

- Pi root: `${homeDir}/.pi/agent/sessions`.
- Claude root: `${homeDir}/.claude/projects`.
- Only inspect `*.jsonl` files.
- For each candidate, read at most the first 100 non-empty lines and record `cwd` if present in a `session` entry or top-level field.
- If cwd cannot be verified, keep candidate as fallback but rank below cwd matches.
- Sort by: cwd match desc, mtime desc, path asc.

Implement `historySourceFromSessionRef()`:

```ts
function historySourceFromSessionRef(ref: AgentSessionRef): "claude-jsonl" | "pi-jsonl" | "unknown" {
  if (ref.agent === "pi" || ref.source.includes("pi")) return "pi-jsonl";
  if (ref.agent === "claude" || ref.source.includes("claude")) return "claude-jsonl";
  return "unknown";
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm test test/unit/agent-history-discovery.test.ts`

Expected: All discovery tests pass.

- [x] **Step 5: Commit**

```bash
git add src/agent-history/discovery.ts src/agent-history/text.ts test/unit/agent-history-discovery.test.ts
git commit -m "history: discover agent history files"
```

### Task 2: Implement RTK-style compact tool results

**Objective:** Return useful tool_result context without raw full output.

**Files:**
- Create: `src/agent-history/tool-compaction.ts`
- Modify: `src/agent-history/text.ts`
- Test: `test/unit/tool-compaction.test.ts`

**Interfaces:**
- Produces: `compactToolResult(input): CompactToolResult`.

- [x] **Step 1: Write the failing tests**

Create tests for these cases:

1. `bash` output containing Vitest/Pnpm failure lines returns `mode: "failure_focus"`, keeps failed test names and error lines, and omits passing test noise.
2. `bash` output containing repeated identical log lines returns a text that collapses repeats with counts and `mode: "grouped_matches"`.
3. `web_search` or fetch/search tool output returns titles/URLs/snippets and `mode: "web_sources"`.
4. JSON output longer than 2,000 chars returns top-level keys/types and `mode: "structured_summary"`.
5. Unknown long output returns first bounded chars plus `[SHEPHERD:TRUNCATED_TOOL_RESULT]` and `mode: "truncated_passthrough"`.
6. `originalChars` equals raw input length in characters and `returnedChars` equals compact text length in characters.
7. Redaction replaces bearer tokens, `token=`, `password=`, `secret=`, and `api_key=` values before compaction.

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm test test/unit/tool-compaction.test.ts`

Expected: Import fails because compaction module does not exist.

- [x] **Step 3: Write minimal implementation**

Implement:

```ts
export function compactToolResult(input: {
  isError: boolean;
  ref: string;
  text: string;
  toolName: string;
}): CompactToolResult;
```

Use constants:

```ts
const maxToolResultChars = 1600;
const passthroughMarker = "[SHEPHERD:TRUNCATED_TOOL_RESULT]";
```

Compaction order:

1. Redact secrets.
2. If output matches test failure markers (`FAIL`, `Failed`, `AssertionError`, `Test Files`, `Tests`, `ERR_PNPM`, `expected ... received`), extract up to 20 failure-focused lines plus neighboring indented lines.
3. If tool name is `web_search`, `fetch_content`, `mcp`, or output contains `http://` / `https://`, extract up to 10 URLs and surrounding title/snippet lines.
4. If trimmed text starts with `{` or `[`, parse JSON and emit top-level key/type summary. If parsing fails, continue.
5. Deduplicate repeated normalized lines and append `(xN)` counts when repetitions occur.
6. Fallback to bounded passthrough with marker.

Never return more than `maxToolResultChars + marker.length + 80` chars.

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm test test/unit/tool-compaction.test.ts`

Expected: All compaction tests pass.

- [x] **Step 5: Commit**

```bash
git add src/agent-history/tool-compaction.ts src/agent-history/text.ts test/unit/tool-compaction.test.ts
git commit -m "history: compact tool results"
```

### Task 3: Parse Pi and Claude JSONL into normalized messages

**Objective:** Produce normalized user/assistant/tool_result messages with compact tool outputs.

**Files:**
- Create: `src/agent-history/readers.ts`
- Create: `src/agent-history/pi-reader.ts`
- Create: `src/agent-history/claude-reader.ts`
- Test: `test/unit/agent-history-readers.test.ts`

**Interfaces:**
- Consumes: `compactToolResult()` from Task 2.
- Produces: `PiHistoryReader`, `ClaudeHistoryReader`, `readJsonlMessages()` helpers.

- [x] **Step 1: Write the failing tests**

Create fixtures inline in the test for both Pi and Claude:

Pi cases:
1. Extract user text from `message.role: "user"` string content and array content blocks.
2. Extract assistant text from `message.role: "assistant"` array text blocks and ignore `thinking` blocks.
3. Extract tool result from `message.role: "toolResult"`, compact it, and set `role: "tool_result"`.
4. `limit: 3` returns the last 3 normalized messages in chronological order.
5. `readCompact()` returns last user, last assistant, last tool result, message count, source, and updatedAt.

Claude cases:
1. Extract top-level `type: "user"` with nested `message.content` string.
2. Extract top-level `type: "assistant"` with nested content blocks including text and tool_use blocks; keep text, omit tool_use as assistant text unless no text exists.
3. Extract tool result entries when Claude records tool results in user/tool result blocks; compact content and set toolName when available.
4. Ignore `attachment`, `mode`, `permission-mode`, and `file-history-snapshot` entries.

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm test test/unit/agent-history-readers.test.ts`

Expected: Import fails because reader modules do not exist.

- [x] **Step 3: Write minimal implementation**

Implement common JSONL parsing in `readers.ts`:

```ts
export async function readJsonl(path: string): Promise<Array<{ line: number; value: unknown }>>;
export function messageRef(path: string, id: string | undefined, line: number): string;
export function textFromContent(content: unknown): string | null;
```

Implementation rules:

- Ignore invalid JSON lines, but do not throw for a single malformed line.
- Use entry `timestamp` if a string, otherwise nested `message.timestamp` if number convert to ISO string, otherwise `null`.
- Build refs as `${path}#entry=${id}` when id/uuid exists, otherwise `${path}#line=${line}`.
- Strip hidden thinking/reasoning blocks from assistant text.
- For Claude tool result formats that are not recognized, preserve a compact `tool_result` only when content clearly represents tool output; otherwise treat as user text.

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm test test/unit/agent-history-readers.test.ts`

Expected: All reader tests pass.

- [x] **Step 5: Commit**

```bash
git add src/agent-history/readers.ts src/agent-history/pi-reader.ts src/agent-history/claude-reader.ts test/unit/agent-history-readers.test.ts
git commit -m "history: parse agent messages"
```

### Task 4: Add high-level AgentHistoryService and cache hooks

**Objective:** Provide one API for daemon/RPC to get compact history and recent messages, with optional DB cache.

**Files:**
- Create: `src/agent-history/service.ts`
- Test: `test/unit/agent-history-service.test.ts`

**Interfaces:**
- Consumes: discovery, readers, compaction, optional `AgentHistoryCacheStore`.
- Produces: `createAgentHistoryService(options)`.

- [x] **Step 1: Write the failing tests**

Tests:

1. `getCompactHistory()` returns empty compact history when discovery returns `null`.
2. `getCompactHistory()` uses cache when `mtimeMs`, `size`, and `formatterVersion` match.
3. `getCompactHistory()` regenerates cache when file mtime changes.
4. `read({ limit: 2 })` bypasses compact-only cache and returns recent messages.
5. Unknown history source returns empty compact history, not an exception.

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm test test/unit/agent-history-service.test.ts`

Expected: Import fails because service module does not exist.

- [x] **Step 3: Write minimal implementation**

Implement:

```ts
export const agentHistoryFormatterVersion = "agent-history-v1";

export function createAgentHistoryService(options: {
  cache?: Pick<AgentHistoryCacheStore, "getFresh" | "put">;
  homeDir?: string;
  readers?: AgentHistoryReader[];
}): AgentHistoryService;
```

Use reader registry order: Pi, Claude. `getCompactHistory()` should:

1. Discover history ref.
2. If no ref, return empty compact history with `messageCount: 0`.
3. Stat file if `ref.path` exists.
4. Check cache with formatter version.
5. Read compact history and write cache.
6. Return compact history.

`read()` should discover ref and return last `limit` messages via the matching reader.

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm test test/unit/agent-history-service.test.ts`

Expected: All service tests pass.

- [x] **Step 5: Commit**

```bash
git add src/agent-history/service.ts test/unit/agent-history-service.test.ts
git commit -m "history: add agent history service"
```

## Validation

- `pnpm test test/unit/agent-history-discovery.test.ts`
- `pnpm test test/unit/tool-compaction.test.ts`
- `pnpm test test/unit/agent-history-readers.test.ts`
- `pnpm test test/unit/agent-history-service.test.ts`

## Risks, Tradeoffs, and Open Questions

- Claude JSONL formats can vary by version. Tests should cover observed fixtures and parser should degrade gracefully.
- Pi directory slug format should not be treated as the only discovery mechanism; scan + cwd matching prevents fragile coupling.
- Tool compaction can remove details that later turn out useful. `ref` must always point back to the original history line.
- This child plan does not implement search or archived stopped sessions.
