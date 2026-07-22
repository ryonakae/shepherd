# Named Agent Surfaces Implementation Plan

> **For implementers:** Execute this plan task-by-task. Complete each checkbox step, run the listed validation, and commit after each task.

**Status:** Completed

**Goal:** Expose Herdr live agent names consistently in CLI, Herdr plugin, Pi hidden context, wake evidence, and visible update cards while retaining runtime kind.

**Architecture:** Root CLI and plugin render separate raw `name` and `agent` fields. The Pi package adds one pure display helper that applies product casing to runtime kinds and combines a live role name with the kind as `reviewer · Codex`. Pi wire types carry nullable name from cached context and event payloads; wake outcomes preserve both fields so hidden evidence and visible cards use the same label.

**Tech Stack:** TypeScript, JavaScript Herdr plugin, Pi extension/TUI APIs, Vitest.

## Global Constraints

- Inherit every constraint from the parent plan.
- Consume `AgentIndexRecord.name` and event payload `name` produced by child 01. Do not derive names from pane labels, terminal titles, history titles, or agent session IDs.
- CLI and plugin list output must use columns in this order: `status`, `name`, `agent`, `pane`, then existing history/timestamp columns.
- CLI `agent get` and `agent read` must expose name and kind separately. Use `unnamed` for a missing human-readable name and `unknown` for a missing kind.
- Pi display must be exactly `reviewer · Codex` when both fields exist and `Codex` when name is null.
- Before inserting identity into provider context or visible Pi UI, accept live names and kinds only when they match Herdr's `[a-z][a-z0-9_-]{0,31}` grammar. Invalid/control-bearing names fall back to kind; invalid kinds become `unknown`.
- Keep the existing product-casing map for `claude`, `codex`, `gemini`, `opencode`, and `pi`; unknown kinds retain their source spelling.
- Keep event classification, excerpt normalization, 2,000-character bound, wake policy, card colors, collapsed row limit, pending counts, and acknowledgement behavior unchanged.
- Do not change daemon RPC method names or add a new display-only RPC.
- Keep JSON output additive: existing `agent` remains; `name` appears beside it.
- Keep the Herdr plugin. Herdr v0.7.5 Agent view filters/sorts live state but does not expose Shepherd's structured history excerpts.

## Current Context

- `src/cli/shepherd.ts` list/get/read output currently displays only `agent` kind.
- `packages/shepherd-herdr-plugin/index.mjs` has a local JSDoc `AgentListItem` and a five-column history table.
- `packages/shepherd-pi/src/daemon-client.ts` defines reduced context/event wire types and lacks `name`.
- `packages/shepherd-pi/src/agent-update-ui.ts` owns `AGENT_DISPLAY_NAMES` and `agentDisplayName()`.
- `packages/shepherd-pi/src/wake.ts` projects one `agent` string from event payloads and formats hidden wake evidence.
- `packages/shepherd-pi/src/index.ts` formats cached context and legacy hidden event updates from raw kind.
- `README.md` and `README.ja.md` currently say target can be an agent name but do not distinguish live name from kind fallback.
- `SKILL.md` tells agents to select a pane ID, terminal ID, or unique name but does not document the new priority.

## File Structure

- Modify: `src/cli/shepherd.ts` — separate name/kind in list, get, and read output.
- Modify: `test/unit/cli.test.ts` — exact human output columns and fallback values.
- Modify: `packages/shepherd-herdr-plugin/index.mjs` — name-aware JSDoc and table.
- Modify: `test/unit/herdr-plugin-package.test.ts` — named and unnamed rows.
- Create: `packages/shepherd-pi/src/agent-display.ts` — shared runtime casing and identity label.
- Modify: `packages/shepherd-pi/src/daemon-client.ts` — nullable name on context items.
- Modify: `packages/shepherd-pi/src/wake.ts` — carry name through outcome projection and hidden wake format.
- Modify: `packages/shepherd-pi/src/agent-update-ui.ts` — use the shared identity label.
- Modify: `packages/shepherd-pi/src/index.ts` — name-aware cached/legacy hidden context.
- Modify: `test/unit/shepherd-pi-wake.test.ts` — event name projection and wake label.
- Modify: `test/unit/shepherd-pi-agent-update-ui.test.ts` — combined/fallback card labels.
- Modify: `test/unit/shepherd-pi-extension.test.ts` — combined/fallback hidden context and wake flow.
- Modify: `packages/shepherd-pi/README.md` — describe named labels in context/update UI if the current examples discuss agent identity.
- Modify: `README.md` and `README.ja.md` — two product capabilities, name/kind fields, and target priority.
- Modify: `SKILL.md` — document exact ID, live name, then kind fallback priority.
- Modify: `packages/shepherd-herdr-plugin/README.md` — state that rows show live name, runtime kind, and history excerpts.

## Interfaces

Create this shared Pi display module:

```ts
const HERDR_AGENT_TOKEN = /^[a-z][a-z0-9_-]{0,31}$/;

const AGENT_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
  opencode: "OpenCode",
  pi: "Pi",
};

function safeAgentToken(value: string): string | null {
  return HERDR_AGENT_TOKEN.test(value) ? value : null;
}

export function agentDisplayName(agent: string): string {
  const safeAgent = safeAgentToken(agent) ?? "unknown";
  return AGENT_DISPLAY_NAMES[safeAgent] ?? safeAgent;
}

export function agentIdentityLabel(input: {
  agent: string;
  name?: string | null;
}): string {
  const kind = agentDisplayName(input.agent);
  const name = input.name ? safeAgentToken(input.name) : null;
  return name ? `${name} · ${kind}` : kind;
}
```

Extend Pi context wire data:

```ts
export type AgentContextListItem = {
  agent?: string | null;
  agentStatus?: string;
  history?: CompactAgentHistory;
  name?: string | null;
  paneId?: string;
  terminalId?: string | null;
};
```

Extend projected outcomes:

```ts
export type AgentOutcome = {
  agent: string;
  eventId: number;
  kind: "blocked" | "completed";
  /** Missing only on custom-message details persisted before named-agent support. */
  name?: string | null;
  paneId: string | null;
  terminalId: string;
  text: string;
  truncated: boolean;
};
```

## Tasks

### Task 1: Update CLI and Herdr Plugin Output

**Objective:** Show live name and runtime kind as separate fields on every human inspection surface while keeping JSON additive.

**Files:**
- Modify: `src/cli/shepherd.ts`
- Modify: `test/unit/cli.test.ts`
- Modify: `packages/shepherd-herdr-plugin/index.mjs`
- Modify: `test/unit/herdr-plugin-package.test.ts`

**Interfaces:**
- Consumes: `AgentListItem.name`, `AgentGetResult.name`, and `AgentReadResult.name` from child 01.
- Produces: stable tabular/human output used by people and the optional Herdr pane.

- [x] **Step 1: Write failing CLI tests**

Change the fake list result in `test/unit/cli.test.ts` to:

```ts
{
  agent: "codex",
  agentStatus: "idle",
  name: "reviewer",
  history: {
    lastAssistantMessage: { text: "done", timestamp: null, ref: "r2" },
    lastUserMessage: { text: "fix bug", timestamp: null, ref: "r1" },
    source: "codex-jsonl",
    updatedAt: "2026-07-22T00:00:00.000Z",
  },
  paneId: "wB:p1",
}
```

Assert the exact list prefix and row:

```ts
expect(output[0]).toContain(
  "status\tname\tagent\tpane\tlast user\tlast assistant\tupdated",
);
expect(output[0]).toContain("idle\treviewer\tcodex\twB:p1\tfix bug\tdone");
```

Add human `agent-get` and `agent-read` cases. Their expected identity lines are:

```text
name: reviewer
agent: codex
```

For an unnamed fixture, assert:

```text
name: unnamed
agent: codex
```

and ensure list output leaves the name cell empty rather than writing `unnamed` into a table:

```text
idle\t\tcodex\twB:p1
```

- [x] **Step 2: Write failing plugin tests**

Update `test/unit/herdr-plugin-package.test.ts` so the daemon fixture returns one named agent and one unnamed agent:

```js
{
  agent: "codex",
  agentStatus: "done",
  name: "reviewer",
  paneId: "wB:p2",
  history: {
    lastUserMessage: { text: "Review the diff" },
    lastAssistantMessage: { text: "No blocking issues" },
  },
}
```

Assert:

```ts
expect(output[0]).toContain("status\tname\tagent\tpane\tlast user\tlast assistant");
expect(output[0]).toContain(
  "done\treviewer\tcodex\twB:p2\tReview the diff\tNo blocking issues",
);
```

Add an unnamed row assertion with an empty name cell.

- [x] **Step 3: Run tests to verify red**

Run:

```bash
pnpm test test/unit/cli.test.ts test/unit/herdr-plugin-package.test.ts
```

Expected: current output lacks the `name` column/line and renders only kind.

- [x] **Step 4: Implement CLI output**

Change list headers and row fields to:

```ts
const lines = [
  ["status", "name", "agent", "pane", "last user", "last assistant", "updated"].join("\t"),
];
```

```ts
[
  agent.agentStatus,
  agent.name ?? "",
  agent.agent ?? "unknown",
  agent.paneId,
  oneLine(agent.history.lastUserMessage?.text ?? ""),
  oneLine(agent.history.lastAssistantMessage?.text ?? ""),
  agent.history.updatedAt ?? "",
].join("\t");
```

In `formatAgentGet()`, put these lines before status:

```ts
`name: ${agent.name ?? "unnamed"}`,
`agent: ${agent.agent ?? "unknown"}`,
```

Remove the old kind-only `agent:` line so it appears once.

In `formatAgentRead()`, replace the combined kind/pane heading with separate lines:

```ts
const lines = [
  `name: ${agent.name ?? "unnamed"}`,
  `agent: ${agent.agent ?? "unknown"}`,
  `pane: ${agent.paneId}`,
  "",
];
```

- [x] **Step 5: Implement plugin output**

Extend the JSDoc record with:

```js
name?: string | null,
```

Use the exact columns:

```js
["status", "name", "agent", "pane", "last user", "last assistant"]
```

and row fields:

```js
[
  agent.agentStatus ?? "unknown",
  agent.name ?? "",
  agent.agent ?? "unknown",
  agent.paneId ?? "unknown",
  oneLine(agent.history?.lastUserMessage?.text ?? ""),
  oneLine(agent.history?.lastAssistantMessage?.text ?? ""),
]
```

- [x] **Step 6: Run tests to verify green**

Run:

```bash
pnpm test test/unit/cli.test.ts test/unit/herdr-plugin-package.test.ts
```

Expected: named and unnamed list/get/read/plugin formats pass without changing JSON dispatch.

- [x] **Step 7: Commit**

```bash
git add src/cli/shepherd.ts test/unit/cli.test.ts packages/shepherd-herdr-plugin/index.mjs test/unit/herdr-plugin-package.test.ts
git commit -m "feat(ui): show named agents in CLI and Herdr"
```

### Task 2: Carry Name Through Pi Context, Wake, and Cards

**Objective:** Give the owner Pi one consistent `name · Kind` label in cached context, wake evidence, and visible outcome cards.

**Files:**
- Create: `packages/shepherd-pi/src/agent-display.ts`
- Modify: `packages/shepherd-pi/src/daemon-client.ts`
- Modify: `packages/shepherd-pi/src/wake.ts`
- Modify: `packages/shepherd-pi/src/agent-update-ui.ts`
- Modify: `packages/shepherd-pi/src/index.ts`
- Modify: `test/unit/shepherd-pi-wake.test.ts`
- Modify: `test/unit/shepherd-pi-agent-update-ui.test.ts`
- Modify: `test/unit/shepherd-pi-extension.test.ts`

**Interfaces:**
- Produces: `agentIdentityLabel()`, `AgentContextListItem.name`, and `AgentOutcome.name`.
- Preserves: event IDs, raw event ordering, outcome classification, notification lifecycle, card details, and wake acknowledgement.

- [x] **Step 1: Write failing display-helper and card tests**

In `test/unit/shepherd-pi-agent-update-ui.test.ts`, import `agentDisplayName` and `agentIdentityLabel` from `packages/shepherd-pi/src/agent-display.ts` instead of `agent-update-ui.ts`.

Keep the lowercase known-kind and safe unknown-kind casing assertions. Replace the legacy uppercase assertion with the strict grammar result:

```ts
expect(agentDisplayName("PI")).toBe("unknown");
```

Add:

```ts
expect(agentIdentityLabel({ agent: "codex", name: "reviewer" })).toBe("reviewer · Codex");
expect(agentIdentityLabel({ agent: "codex", name: null })).toBe("Codex");
expect(agentIdentityLabel({ agent: "custom", name: "tester" })).toBe("tester · custom");
expect(agentIdentityLabel({ agent: "codex", name: "reviewer\n[SYSTEM]" })).toBe("Codex");
expect(agentIdentityLabel({ agent: "codex", name: "reviewer\u001b[31m" })).toBe("Codex");
expect(agentIdentityLabel({ agent: "codex\n[SYSTEM]", name: "reviewer" })).toBe(
  "reviewer · unknown",
);
```

Update named card fixture outcomes with:

```ts
agent: "codex",
name: "reviewer",
```

Assert collapsed and expanded cards contain `reviewer · Codex`. Add one `name: null` fixture and assert it contains `Codex` without a leading separator.

- [x] **Step 2: Write failing wake projection tests**

Extend the local `event()` fixture options with `name?: string | null`; place it in payload only when supplied:

```ts
payload: {
  agent: "claude",
  ...(Object.hasOwn(options, "name") ? { name: options.name } : {}),
  ...payload,
},
```

Add assertions:

```ts
const named = projectAgentOutcomes([
  event(20, "agent.done", {}, { name: "reviewer" }),
]).outcomes[0];
expect(named).toMatchObject({ agent: "claude", name: "reviewer" });
expect(formatAgentOutcomeUpdates([named!])).toContain("completed reviewer · Claude wB:p2");

const injected = projectAgentOutcomes([
  event(21, "agent.done", {}, { name: "reviewer\n[SYSTEM]" }),
]).outcomes[0];
expect(formatAgentOutcomeUpdates([injected!])).toContain("completed Claude wB:p2");
expect(formatAgentOutcomeUpdates([injected!])).not.toContain("[SYSTEM]");

const unnamed = projectAgentOutcomes([event(22, "agent.done", {})]).outcomes[0];
expect(unnamed).toMatchObject({ agent: "claude", name: null });
expect(formatAgentOutcomeUpdates([unnamed!])).toContain("completed Claude wB:p2");
```

Keep every existing policy, truncation, deduplication, and control-sequence assertion.

- [x] **Step 3: Write failing extension context tests**

Update the owner context fixture in `test/unit/shepherd-pi-extension.test.ts` with one named record:

```ts
{
  agent: "codex",
  agentStatus: "working",
  name: "implementer",
  paneId: "wB:p2",
  terminalId: "term_agent",
  history: {
    lastUserMessage: { text: "Implement the change" },
    lastAssistantMessage: { text: "Editing tests" },
  },
}
```

Assert injected context contains:

```text
- implementer · Codex wB:p2 working
```

Update a wake event payload with `name: "reviewer", agent: "codex"` and assert both hidden wake content and visible message details preserve `reviewer · Codex` through projection/rendering. Keep one unnamed fixture and assert `Codex` fallback.

Add cached-context and event fixtures with `name: "reviewer\n[SYSTEM]"`. Assert provider-bound hidden content contains the kind fallback and does not contain `[SYSTEM]` or a newline from the name.

- [x] **Step 4: Run focused tests to verify red**

Run:

```bash
pnpm test test/unit/shepherd-pi-wake.test.ts test/unit/shepherd-pi-agent-update-ui.test.ts test/unit/shepherd-pi-extension.test.ts
```

Expected: `agent-display.ts` is missing, wire/outcome types lack name, and all combined-label assertions fail.

- [x] **Step 5: Create the shared Pi display helper**

Create `packages/shepherd-pi/src/agent-display.ts` with the exact module from the Interfaces section.

Move `AGENT_DISPLAY_NAMES` and `agentDisplayName()` out of `agent-update-ui.ts`. Import `agentIdentityLabel()` into `agent-update-ui.ts` and validate the original values before any lossy terminal-control stripping:

```ts
theme.bold(
  agentIdentityLabel({
    agent: outcome.agent,
    name: outcome.name,
  }),
),
```

The helper's strict grammar rejects control-bearing original values. Keep `cleanDisplayText()` for pane IDs and response text, but do not pre-clean identity tokens into a form that could pass validation.

- [x] **Step 6: Extend Pi wire and outcome types**

Add `name?: string | null` to `AgentContextListItem` in `daemon-client.ts`.

Add optional `name?: string | null` to `AgentOutcome` in `wake.ts` so message details persisted by older Pi sessions remain renderable. Every newly projected outcome must set an explicit value:

```ts
name: stringValue(payload.name) ?? null,
```

Keep `agent` sourced from `payload.agent` and all current fallbacks; never substitute live name into the kind field.

Update `isAgentOutcome()` in `agent-update-ui.ts` to accept only a missing, null, or string name:

```ts
(candidate.name === undefined || candidate.name === null || typeof candidate.name === "string")
```

This condition joins the existing structural checks. It rejects malformed persisted details without rejecting legacy details that predate the field.

Use `agentIdentityLabel({ agent: outcome.agent, name: outcome.name })` in `formatAgentOutcomeUpdates()`.

- [x] **Step 7: Update hidden cached and legacy context**

Import `agentIdentityLabel()` into `packages/shepherd-pi/src/index.ts`.

In `formatHiddenAgentContext()`, calculate:

```ts
const identity = agentIdentityLabel({
  agent: agent.agent ?? "unknown",
  name: agent.name ?? null,
});
```

and render:

```ts
`- ${identity} ${agent.paneId ?? "unknown"} ${agent.agentStatus ?? "unknown"}`
```

In `formatHiddenAgentUpdates()`, read both payload fields:

```ts
const identity = agentIdentityLabel({
  agent: stringValue(payload.agent) ?? "unknown",
  name: stringValue(payload.name) ?? null,
});
```

and use `identity` in the event line. Do not change markers, policy text, or message custom types.

- [x] **Step 8: Run focused tests and Pi package typecheck**

Run:

```bash
pnpm test test/unit/shepherd-pi-wake.test.ts test/unit/shepherd-pi-agent-update-ui.test.ts test/unit/shepherd-pi-extension.test.ts
pnpm --dir packages/shepherd-pi typecheck
```

Expected: named and unnamed labels pass across pure helper, hidden context, wake projection, and visible cards; all existing wake/ack/reconnect tests remain green.

- [x] **Step 9: Commit**

```bash
git add packages/shepherd-pi/src/agent-display.ts packages/shepherd-pi/src/daemon-client.ts packages/shepherd-pi/src/wake.ts packages/shepherd-pi/src/agent-update-ui.ts packages/shepherd-pi/src/index.ts test/unit/shepherd-pi-wake.test.ts test/unit/shepherd-pi-agent-update-ui.test.ts test/unit/shepherd-pi-extension.test.ts
git commit -m "feat(pi): label named Herdr agents"
```

### Task 3: Update Product and Target Documentation

**Objective:** Describe Shepherd's two retained capabilities and distinguish live name from runtime kind without duplicating Herdr control documentation.

**Files:**
- Modify: `README.md`
- Modify: `README.ja.md`
- Modify: `SKILL.md`
- Modify: `packages/shepherd-pi/README.md`
- Modify: `packages/shepherd-herdr-plugin/README.md`

**Interfaces:**
- Consumes: final CLI/Pi behavior from Tasks 1-2.
- Produces: user-facing installation, target, and display guidance.

- [x] **Step 1: Replace the root README product description**

Replace the first two prose paragraphs after the title in `README.md` with text that states both capabilities directly:

```markdown
Shepherd adds structured agent history and owner-scoped Pi updates to agents running in Herdr.

The daemon reads native Claude Code, Codex, Gemini CLI, OpenCode, and Pi session data. `shepherd agent list/get/read` returns compact status, messages, and tool results without relying on terminal scrollback. The optional Pi extension gives one `/shepherd on` owner cached context about other agents and starts a visible turn when an agent completes or blocks.

Use the official Herdr CLI or skill to create panes, start agents, submit prompts, send keys, focus targets, and wait for lifecycle state. Shepherd does not wrap those control operations.
```

Write the equivalent natural Japanese text in `README.ja.md`; do not translate identifiers or commands.

Keep requirements at `Herdr >= 0.7.0`.

- [x] **Step 2: Document name, kind, and target priority**

Replace the target paragraph in both root READMEs with behavior equivalent to:

```markdown
`<target>` first matches an exact pane id, terminal id, or Shepherd agent id in the selected scope. It then matches a Herdr live agent name such as `reviewer`; when no live name matches, it falls back to a unique agent kind such as `codex`. Use `--session <name>` when a target is ambiguous across running Herdr sessions.
```

Add one sentence near the command output description:

```markdown
Human output shows the optional live `name` separately from the runtime `agent` kind; JSON returns both fields.
```

Use equivalent Japanese wording in `README.ja.md`.

- [x] **Step 3: Update the Shepherd skill boundary and selection instructions**

In `SKILL.md`:

- state that `agent list` returns optional Herdr live `name` and runtime `agent` kind;
- document the resolver order as exact pane ID, terminal ID, or Shepherd ID first; exact live name second; unique kind fallback third;
- retain exact pane/terminal selection when names or kind fallbacks are ambiguous;
- keep the official Herdr skill as the source of truth for all control operations;
- do not copy Herdr v0.7.5 command syntax into Shepherd's skill.

Use this target guidance:

```markdown
Start with `agent list`. Use an exact pane id or terminal id when the caller already selected a row. Otherwise use its exact live `name` when present. A runtime kind such as `claude` is only a fallback and must be unique in the selected scope.
```

- [x] **Step 4: Update package READMEs**

In `packages/shepherd-pi/README.md`, describe named outcome labels as `reviewer · Codex` and unnamed fallback as `Codex`. Do not alter owner/wake semantics.

In `packages/shepherd-herdr-plugin/README.md`, state that the table includes status, optional live name, runtime kind, pane, and last user/assistant excerpts. Do not claim integration with Herdr's built-in Agent view.

- [x] **Step 5: Review documentation consistency**

Run:

```bash
rg -n "Herdr >=|agent name|live name|agent kind|agent start|agent prompt|agent wait|reviewer" README.md README.ja.md SKILL.md packages/shepherd-pi/README.md packages/shepherd-herdr-plugin/README.md
```

Expected:

- both root READMEs still state `Herdr >= 0.7.0`;
- both distinguish live name from agent kind;
- Shepherd docs delegate control to Herdr rather than advertising Shepherd control commands;
- package docs match actual labels.

Review Markdown links and command blocks manually. Markdown is outside the Biome gate.

- [x] **Step 6: Run nearby package checks**

Run:

```bash
pnpm test test/unit/cli.test.ts test/unit/herdr-plugin-package.test.ts test/unit/shepherd-pi-wake.test.ts test/unit/shepherd-pi-agent-update-ui.test.ts test/unit/shepherd-pi-extension.test.ts
pnpm pi-package:check
pnpm herdr-plugin:check
```

Expected: UI tests and both package checks pass.

- [x] **Step 7: Commit**

```bash
git add README.md README.ja.md SKILL.md packages/shepherd-pi/README.md packages/shepherd-herdr-plugin/README.md
git commit -m "docs: define Shepherd's Herdr v0.7.5 boundary"
```

## Validation

- `pnpm test test/unit/cli.test.ts test/unit/herdr-plugin-package.test.ts` — CLI/plugin named and unnamed formats pass.
- `pnpm test test/unit/shepherd-pi-wake.test.ts test/unit/shepherd-pi-agent-update-ui.test.ts test/unit/shepherd-pi-extension.test.ts` — Pi labels and all existing notification behavior pass.
- `pnpm pi-package:check` — Pi source package typechecks and packs.
- `pnpm herdr-plugin:check` — plugin type/package checks pass.
- Manual docs review confirms all links, install commands, requirements, and examples remain accurate.
- `git diff --check` — no whitespace errors.

## Completion Evidence

- Verified separate `name` and `agent` output in CLI and Herdr plugin list/detail surfaces.
- Verified `reviewer · Codex` and unnamed fallback across Pi cached context, wake evidence, and visible cards.
- Verified malformed/control-bearing identity tokens fall back before provider/UI insertion.
- Surface validation passed 87 focused tests plus Pi and Herdr package checks; `pnpm check` passed with 226 tests.
- Updated English/Japanese README, Shepherd skill, and Herdr plugin README.

## Risks, Tradeoffs, and Open Questions

- CLI table consumers should use `--json`; the human table gains one column by design.
- Event payloads created before this change lack `name`. Pi maps missing values to null and displays runtime kind.
- Live names are untrusted display data at the Pi boundary. The renderer and wake formatter retain current control-character stripping before display/provider injection.
- The middle dot is a display separator only. Target commands continue to use the raw live name, not the combined label.
- No open questions remain.
