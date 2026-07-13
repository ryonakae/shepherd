# Shepherd Root Skill and Running-Session Contract Implementation Plan

> **For implementers:** Execute this plan task-by-task. Complete each checkbox step, run the listed validation, and commit after each task. Use the named skills where required; do not replace those reviews with an informal prose pass.

**Status:** Completed

**Goal:** Make Shepherd expose agents only from running Herdr sessions, focus the root Agent Skill on structured agent status/history and cross-agent understanding, delegate Herdr control to the official `herdr` skill, and document the bilingual installation flow without changing the existing README structure.

**Architecture:** `AgentStore.list()` becomes the public running-session boundary by joining `agents` to `herdr_sessions` and filtering `running = 1`; stored agent rows remain available for identity reuse when a session returns. The root `SKILL.md` teaches Shepherd inspection only and routes mixed coordination tasks to the independently installed official Herdr skill instead of duplicating Herdr commands. README changes add one Agent Skill section to the existing English structure, then synchronize the Japanese sibling through the required README and anti-slop skills.

**Tech Stack:** TypeScript ESM + NodeNext, Node.js >= 24.18.0, pnpm 11.9.0, SQLite via `node:sqlite`, Vitest, Agent Skills frontmatter, Claude Code 2.1.206, Codex CLI 0.142.5, skill-creator evaluation scripts, Markdown.

## Global Constraints

- Follow TDD for the running-session fix: Red, Green, then refactor only if the focused tests remain green.
- Public repository code, docs, skill instructions, and commit messages remain in English. Chat updates remain in Japanese.
- Modify the root `SKILL.md`; do not modify `packages/shepherd-pi/skills/shepherd/SKILL.md` in this plan.
- Shepherd remains useful without the official Herdr skill. It provides structured agent status, compact history, and recent compact tool results.
- Pure workspace, tab, pane, terminal input/output, spawn, focus, and wait operations belong to the official `herdr` skill. Do not duplicate Herdr CLI recipes in the root Shepherd skill.
- The Shepherd skill triggers for understanding another Herdr-managed coding agent and for mixed coordination tasks that require that understanding. Pure Herdr control requests must rely on the `herdr` skill alone.
- If a mixed task needs Herdr control and the `herdr` skill is unavailable, stop that control portion and ask the user to install the official skill with `npx skills add ogulcancelik/herdr --skill herdr -g`. Do not fetch, vendor, or auto-install it.
- Support explicit Shepherd `--workspace` and `--session` scopes outside Herdr.
- Current-workspace inference requires both `HERDR_ENV=1` and `HERDR_WORKSPACE_ID`. Do not fall back to `--all`, another workspace, or Herdr topology inference when either value is absent.
- Before Shepherd inspection, run `shepherd daemon status`; start the daemon only when it reports `state: "stopped"`. Do not automatically restart or stop it.
- Treat the Shepherd CLI itself as a compatibility requirement. Do not add CLI clone/build/global-install recovery instructions to `SKILL.md`; README owns CLI installation.
- Keep the skill description positive and Herdr-specific. Do not add negative keyword lists for tmux, Zellij, Shepherd.js, generic subagents, or unrelated products.
- Keep all skill eval prompts, fixtures, transcripts, timing, benchmark data, HTML viewers, and Codex smoke artifacts under the sibling `../shepherd-workspace/`; do not add `evals/`, generated reports, or runner scripts to this repository or npm package.
- Use `/skill-creator` for behavioral comparison, grading, viewer generation, description trigger evaluation, and iteration. Static review alone is not sufficient.
- Update README content with `/readme-creator` and `/readme-i18n`. Apply `/stop-slop` to changed English prose and `/stop-slop-ja` to changed Japanese prose.
- Preserve the current README layout: cover image, H1, existing `README-I18N` selector, introduction, section order, examples, Pi section, Herdr plugin section, packages table, development section, and license. Insert one new Agent Skill section after Main commands; do not rewrite or reorder the rest of the file and do not add a table of contents.
- README literal tokens take precedence over generic prose rules. Preserve inline code, fenced code, commands, flags, paths, environment variables, URLs, HTML markers, and selector comments even when `/stop-slop` or `/stop-slop-ja` flags them.
- Keep agent rows in SQLite when a Herdr session stops. Filter them from public list/target resolution instead of deleting them. No DB schema or migration change is required.
- Do not alter user changes outside the files listed in this plan.

## Current Context

- `README.md`, `README.ja.md`, the archived agent-history redesign plan, and the current root skill all state that Shepherd indexes running Herdr sessions only.
- `HerdrSessionWatchManager.rescanNow()` marks missing sessions `running = false`, but `AgentStore.list()` currently selects directly from `agents`; stale rows can therefore appear in `agent.list`, `agent.get`, and `agent.read`.
- `ObservabilityRpcServer` implements `agent.get` and `agent.read` through `AgentStore.resolveTarget()`, which already calls `AgentStore.list()`. A single query-boundary fix covers all three public methods.
- `AgentStore.replaceForSession()` calls `listForHerdrSession()` while refreshing. `HerdrSessionWatchManager` and `AgentIndexService` upsert the session as running before replacing rows, so the running-session join preserves the existing refresh path.
- `SKILL.md` has an uncommitted broad draft that contains Herdr workspace/tab/pane commands. The implementation should replace that draft with the final Shepherd-focused content below. Preserve the committed `HEAD:SKILL.md` as the skill-creator baseline before rewriting the file.
- The root README files are both 101 lines and have matching structure and one existing `README-I18N` selector. The user explicitly requires preserving that structure, so the README Creator table-of-contents checklist item is overridden for this constrained update.
- The project is consumed primarily as a CLI (`package.json#bin` points to `dist/src/cli/shepherd.js`) with optional Pi and Herdr plugin packages.
- `skill-creator/scripts/run_eval.py` evaluates Claude Code triggering by creating transient command files. Run it from the sibling evaluation workspace so `.claude/commands` never appears in this repository.
- `skill-creator/scripts/quick_validate.py` imports PyYAML, which is not installed in the project environment. Run it through `uv run --with pyyaml`.
- `pnpm check` is the repository-wide validation gate. Run `pnpm build` as a final CLI/package smoke test even though this change does not alter entrypoint imports.

## File Structure

- Modify: `src/db/agents.ts` — restrict `AgentStore.list()` and `resolveTarget()` candidates to running Herdr sessions while retaining stored rows.
- Modify: `test/integration/observability-rpc.test.ts` — prove stopped-session agents are hidden from `agent.list/get/read` but remain stored.
- Modify: `SKILL.md` — replace the broad Herdr wrapper draft with the Shepherd inspection and delegation workflow.
- Modify: `README.md` — add the English Agent Skill installation and companion-skill section without reordering existing sections.
- Modify: `README.ja.md` — synchronize the new section and preserve the established bilingual structure.
- Create during implementation, outside the repository: `../shepherd-workspace/skill-snapshot/SKILL.md` — committed baseline from `HEAD`.
- Create during implementation, outside the repository: `../shepherd-workspace/candidate/SKILL.md` — candidate used by skill-creator and Codex.
- Create during implementation, outside the repository: `../shepherd-workspace/trigger-eval.json` — 20 reviewed trigger cases.
- Create during implementation, outside the repository: `../shepherd-workspace/behavior-evals/evals.json` and fixture scripts — four fake-CLI workflow cases.
- Create during implementation, outside the repository: `../shepherd-workspace/iteration-*/` — skill-creator transcripts, outputs, grades, timings, benchmarks, and viewer data.
- Modify during implementation: `docs/plans/2026-07-10-shepherd-root-skill-running-session.md` — update Progress and Next Steps; archive it only after all automated and human review gates pass.

## Tasks

### Task 1: Enforce the Running-Session Agent Contract

**Objective:** Hide retained agents from stopped Herdr sessions in `agent.list`, `agent.get`, and `agent.read` without deleting their database rows.

**Files:**
- Modify: `src/db/agents.ts:149-169`
- Test: `test/integration/observability-rpc.test.ts`

**Interfaces:**
- Consumes: `herdr_sessions(name, running)`, `AgentQueryScope`, `AgentStore.resolveTarget()`
- Produces: a running-only `AgentStore.list()` result used by list/get/read RPC paths

- [ ] **Step 1: Add the failing RPC integration test**

Add this test near the existing `serves agent methods over JSONL` case:

```typescript
test("hides retained agents after their Herdr session stops", async () => {
  const { client, harness } = await openServer();
  seedAgent(harness);

  harness.herdrSessions.markStoppedMissingFrom([]);

  expect(
    harness.agents.findByPane({ herdrSessionName: "default", paneId: "wB:p1" }),
  ).toBeDefined();
  await expect(client.request("agent.list", { workspaceId: "wB" })).resolves.toEqual({
    agents: [],
  });
  await expect(client.request("agent.list", { all: true })).resolves.toEqual({ agents: [] });
  await expect(
    client.request("agent.get", { target: "pi", workspaceId: "wB" }),
  ).rejects.toThrow("agent target not found: pi");
  await expect(
    client.request("agent.read", { limit: 20, target: "pi", workspaceId: "wB" }),
  ).rejects.toThrow("agent target not found: pi");

  client.close();
  harness.sqlite.close();
});
```

- [ ] **Step 2: Run the focused test and confirm Red**

Run:

```bash
PATH="$HOME/.local/share/mise/installs/node/24.18.0/bin:$HOME/.local/share/mise/installs/pnpm/11.9.0/bin:$PATH" \
  pnpm test -- test/integration/observability-rpc.test.ts
```

Expected: the new `agent.list` assertion fails because the retained `pi` agent is still returned; the existing tests remain green.

- [ ] **Step 3: Implement the running-session join**

Replace `AgentStore.list()` with the following implementation. Prefix every query column with its table alias to avoid ambiguity with `herdr_sessions`:

```typescript
list(scope: AgentQueryScope = {}): AgentIndexRecord[] {
  const clauses = ["sessions.running = 1"];
  const params: Array<number | string | null> = [];
  if (!scope.all && scope.herdrSessionName) {
    clauses.push("agents.herdr_session_name = ?");
    params.push(scope.herdrSessionName);
  }
  if (!scope.all && scope.workspaceId) {
    clauses.push("agents.workspace_id = ?");
    params.push(scope.workspaceId);
  }
  if (scope.all && scope.herdrSessionName) {
    clauses.push("agents.herdr_session_name = ?");
    params.push(scope.herdrSessionName);
  }
  const where = ` where ${clauses.join(" and ")}`;
  const rows = this.#sqlite
    .prepare(
      `select agents.*
       from agents
       inner join herdr_sessions as sessions
         on sessions.name = agents.herdr_session_name
       ${where}
       order by agents.herdr_session_name, agents.workspace_id, agents.pane_id`,
    )
    .all(...params) as AgentRow[];
  return rows.map(mapAgent);
}
```

Do not change `findByPane()`, `findByTerminal()`, `get()`, schema files, or migrations. Internal presence resolution already validates the running socket before `findByPane()`, while public get/read resolve through the filtered list.

- [ ] **Step 4: Run focused store/RPC tests and confirm Green**

Run:

```bash
PATH="$HOME/.local/share/mise/installs/node/24.18.0/bin:$HOME/.local/share/mise/installs/pnpm/11.9.0/bin:$PATH" \
  pnpm test -- test/integration/observability-rpc.test.ts test/integration/agent-store-terminal-identity.test.ts test/unit/herdr-session-watch-manager.test.ts
```

Expected: all selected test files pass. The new test proves that public queries hide the row and the direct `findByPane()` assertion proves the row remains stored.

- [ ] **Step 5: Review the restart tradeoff**

Confirm from `HerdrSessionWatchManager.#startWatcher()` and `AgentIndexService.refreshHerdrSession()` that a restarted session is marked running before its replacement snapshot completes. Record in the plan Progress notes that retained rows may be briefly queryable during that first refresh; do not broaden this task with generation or epoch fields. The agreed scope is running-session filtering, not a new freshness model.

- [ ] **Step 6: Commit the contract fix**

```bash
git add src/db/agents.ts test/integration/observability-rpc.test.ts
git commit -m "fix(observability): hide agents from stopped sessions"
```

### Task 2: Rewrite the Root Shepherd Skill Around Structured Inspection

**Objective:** Produce a concise root skill that triggers for understanding other Herdr-managed agents, supports explicit outside scopes, auto-starts the Shepherd daemon when stopped, and delegates all Herdr control to the official skill.

**Files:**
- Modify: `SKILL.md`
- Create outside repo: `../shepherd-workspace/skill-snapshot/SKILL.md`
- Create outside repo: `../shepherd-workspace/candidate/SKILL.md`

**Interfaces:**
- Consumes: the running-only contract from Task 1 and the official `herdr` skill installation command
- Produces: the candidate skill evaluated in Task 3

- [ ] **Step 1: Create the external evaluation workspace and committed baseline**

Run from the repository root:

```bash
mkdir -p ../shepherd-workspace/skill-snapshot ../shepherd-workspace/candidate
git show HEAD:SKILL.md > ../shepherd-workspace/skill-snapshot/SKILL.md
```

Expected: the baseline file contains the committed pre-change skill, not the current uncommitted broad draft. `git status --short` must not show `evals/`, `.claude/`, or any generated evaluation file.

- [ ] **Step 2: Replace the root skill with this candidate**

Write exactly this initial candidate, then let `/skill-creator` adjust the description only when measured trigger failures justify a change:

```markdown
---
name: shepherd
description: "Inspect the status, progress, latest messages, compact structured history, and recent tool results of coding agents managed by Herdr using Shepherd. Use whenever the user asks what another Herdr-managed coding agent is doing, whether it is working, blocked, idle, or done, what it recently reported or changed, or needs structured context before coordinating with that agent. Also use outside Herdr when the user provides an explicit Herdr workspace or session scope for agent inspection."
compatibility: "Requires the Shepherd CLI and daemon. Current-workspace lookup requires HERDR_ENV=1 and HERDR_WORKSPACE_ID. Explicit Shepherd workspace or session scopes work outside Herdr."
---

# Shepherd agent inspection

Use Shepherd for structured coding-agent status, compact message history, and recent compact tool results. Use the official `herdr` skill for live workspace, tab, pane, terminal input/output, focus, spawn, and wait operations.

## Ensure the daemon is running

Check the daemon before the first Shepherd query:

```bash
shepherd daemon status
```

If the JSON response has `state: "stopped"`, start it once:

```bash
shepherd daemon start
```

Do not restart or stop a running daemon unless the user asks.

## Select the scope

Use the current workspace only when both `HERDR_ENV=1` and `HERDR_WORKSPACE_ID` are set:

```bash
shepherd agent list --json
```

If either value is missing, do not guess the workspace or fall back to `--all`. Ask for an explicit scope.

Outside Herdr, or when the user names a scope, pass it explicitly:

```bash
shepherd agent list --workspace <workspace-id> --json
shepherd agent list --all --json
```

Use `--session <name>` when workspace ids or agent names are ambiguous across running Herdr sessions.

## Inspect an agent

Start with `agent list` and select the exact pane id, terminal id, or unique agent name from its result. Do not assume names such as `claude` or `codex` are unique.

```bash
shepherd agent get <target> --json
shepherd agent read <target> --limit 20 --json
```

Add the same `--workspace` and `--session` scope used for `agent list` when operating outside the current Herdr workspace.

`agent get` returns metadata, status, compact history, and the latest compact tool result. `agent read` returns recent user, assistant, and compact `tool_result` messages; it does not return raw full terminal output.

Agent status uses `working`, `blocked`, `idle`, `done`, or `unknown`. `done` means the agent finished and its pane has not yet been viewed.

## Coordinate through the official Herdr skill

When a task also requires live terminal output, pane control, input, spawning, focus, or waiting, load and follow the installed official `herdr` skill as the source of truth:

https://github.com/ogulcancelik/herdr/blob/master/SKILL.md

If that skill is unavailable, stop the Herdr-control portion and ask the user to install it:

```bash
npx skills add ogulcancelik/herdr --skill herdr -g
```

Do not copy or guess Herdr CLI commands in this skill.

## Boundaries

- Shepherd returns agents from running Herdr sessions only.
- Use Shepherd for structured semantic history, not raw terminal fidelity.
- Use the official `herdr` skill for live terminal state and control.
```

- [ ] **Step 3: Validate frontmatter and required phrases**

Run:

```bash
uv run --with pyyaml python \
  /Users/ryo.nakae/.agents/skills/skill-creator/scripts/quick_validate.py .
```

Expected: `Skill is valid!`

Run:

```bash
rg -n "HERDR_ENV=1|HERDR_WORKSPACE_ID|shepherd daemon status|shepherd agent list|shepherd agent get|shepherd agent read|ogulcancelik/herdr" SKILL.md
rg -n "herdr workspace|herdr tab|herdr pane|herdr wait" SKILL.md
```

Expected: the first command finds every required contract. The second command returns no matches because the root skill no longer duplicates Herdr CLI recipes.

- [ ] **Step 4: Copy the candidate into the external evaluation workspace**

```bash
cp SKILL.md ../shepherd-workspace/candidate/SKILL.md
git diff --check -- SKILL.md
git status --short
```

Expected: only planned repository files are modified; no evaluation artifact appears in the repository. Do not commit the skill until Task 3 passes.

### Task 3: Evaluate and Iterate with Skill Creator

**Objective:** Prove that the candidate improves execution behavior over the committed skill, triggers reliably in Claude Code, and passes a Codex smoke test without committing eval artifacts.

**Files:**
- Read: `SKILL.md`
- Modify when evidence requires: `SKILL.md` description or instructions
- Create only outside repo: `../shepherd-workspace/**`

**Interfaces:**
- Consumes: Task 2 candidate and `HEAD:SKILL.md` baseline snapshot
- Produces: human-reviewed behavior benchmark, accepted description, Claude trigger results, and Codex smoke results

#### Behavior eval definitions

Create four temporary evals with these exact prompts and expectations:

| ID | Prompt | Required expectations |
| --- | --- | --- |
| 1 | `You are inside Herdr. Find which coding agent in the current workspace is blocked, read its latest structured history, and summarize why it needs input.` | Calls daemon status; uses `agent list` before selecting a target; uses `agent get` or `agent read`; does not invoke `herdr`; reports fixture evidence. |
| 2 | `From outside Herdr, inspect agent codex in workspace wB and session nightly. Return its latest 20 structured messages.` | Uses explicit `--workspace wB --session nightly` consistently; never falls back to `--all`; uses `agent list` before `agent read`; does not invoke `herdr`. |
| 3 | `Check the current Herdr workspace agents. Shepherd's daemon is stopped right now.` | Executes `daemon status`, observes stopped state, executes `daemon start` once, then retries inspection; never uses restart or stop. |
| 4 | `Check what codex is doing, wait until it finishes, then send it a follow-up request. The official herdr skill is not installed.` | Uses Shepherd for the structured inspection; does not guess or execute Herdr commands; stops the wait/input portion; asks the user to install `ogulcancelik/herdr`. |

Create `../shepherd-workspace/behavior-evals/bin/shepherd` with this deterministic adapter:

```python
#!/usr/bin/env python3
import json
import os
import sys
from pathlib import Path

args = sys.argv[1:]
log_path = Path(os.environ["SHEPHERD_FAKE_LOG"])
state_path = Path(os.environ["SHEPHERD_FAKE_STATE"])
log_path.parent.mkdir(parents=True, exist_ok=True)
with log_path.open("a") as log:
    log.write(json.dumps({"command": "shepherd", "args": args}) + "\n")

if args == ["daemon", "status"]:
    state = state_path.read_text().strip() if state_path.exists() else "running"
    print(json.dumps({"state": state}))
elif args == ["daemon", "start"]:
    state_path.write_text("running\n")
    print(json.dumps({"pid": 4242, "socketPath": "/tmp/fake-shepherd.sock"}))
elif args[:2] == ["agent", "list"]:
    print(
        json.dumps(
            {
                "agents": [
                    {
                        "agent": "codex",
                        "agentStatus": "blocked",
                        "paneId": "wB:p2",
                        "terminalId": "term_codex",
                        "workspaceId": "wB",
                        "history": {
                            "lastUserMessage": {"text": "Run the migration tests"},
                            "lastAssistantMessage": {"text": "I need the database URL"},
                        },
                    },
                    {
                        "agent": "claude",
                        "agentStatus": "working",
                        "paneId": "wB:p1",
                        "terminalId": "term_claude",
                        "workspaceId": "wB",
                        "history": {
                            "lastUserMessage": {"text": "Review the API"},
                            "lastAssistantMessage": {"text": "Checking handlers"},
                        },
                    },
                ]
            }
        )
    )
elif args[:2] == ["agent", "get"] and len(args) >= 3:
    print(
        json.dumps(
            {
                "agent": {
                    "agent": "codex",
                    "agentStatus": "blocked",
                    "paneId": "wB:p2",
                    "history": {
                        "lastAssistantMessage": {"text": "I need the database URL"},
                        "latestToolResult": {"text": "DATABASE_URL is missing"},
                    },
                }
            }
        )
    )
elif args[:2] == ["agent", "read"] and len(args) >= 3:
    print(
        json.dumps(
            {
                "agent": {
                    "agent": "codex",
                    "paneId": "wB:p2",
                    "messages": [
                        {"role": "user", "text": "Run the migration tests"},
                        {"role": "assistant", "text": "I need the database URL"},
                        {"role": "tool_result", "text": "DATABASE_URL is missing"},
                    ],
                }
            }
        )
    )
else:
    print(json.dumps({"error": f"unsupported fake command: {args}"}), file=sys.stderr)
    raise SystemExit(2)
```

Create `../shepherd-workspace/behavior-evals/bin/herdr` as a guard so no run can reach a real Herdr session:

```bash
#!/usr/bin/env bash
printf '%s\n' "herdr $*" >> "$SHEPHERD_FAKE_LOG"
echo "Herdr is intentionally unavailable in this eval" >&2
exit 97
```

Run `chmod +x` on both adapters. Give every run unique environment paths inside that run directory:

```text
SHEPHERD_FAKE_LOG=<run-directory>/outputs/command-log.jsonl
SHEPHERD_FAKE_STATE=<run-directory>/daemon-state
```

Before launching each executor, create its `outputs/` directory, truncate its log, and write `stopped` to its state only for eval 3; write `running` for every other eval. Candidate and baseline never share a state or log file.

Each executor prompt must require every shell command to set `PATH=/Users/ryo.nakae/Dev/private/shepherd-workspace/behavior-evals/bin:$PATH`, `SHEPHERD_FAKE_LOG`, and `SHEPHERD_FAKE_STATE` inline. This PATH shadows both real binaries with the fake Shepherd adapter and Herdr guard. For evals 1, 3, and 4, each command also sets `HERDR_ENV=1 HERDR_WORKSPACE_ID=wB`; for eval 2, use `env -u HERDR_ENV -u HERDR_WORKSPACE_ID` and require `--workspace wB --session nightly`.

Retrieve every executor with full tool-call history (`get_subagent_result` with `verbose: true`) and save that structured conversation as `transcript.md`. The grader must fail the run if any executed shell tool input lacks the fake-bin PATH prefix when invoking Shepherd/Herdr, invokes a real absolute Shepherd/Herdr path, or contains a Shepherd/Herdr command absent from that run's unique command log. This transcript-to-log audit is required evidence that no real binary ran.

- [ ] **Step 1: Invoke `/skill-creator` and prepare iteration 1**

Follow `/skill-creator` and the aggregator's required directory layout:

1. Save the four evals to `../shepherd-workspace/behavior-evals/evals.json` using the skill-creator schema.
2. Create these eval directories: `eval-1-current-blocked`, `eval-2-explicit-scope`, `eval-3-daemon-start`, and `eval-4-missing-herdr-skill`.
3. Put `eval_metadata.json` in each eval directory with the numeric id, descriptive name, exact prompt, and listed expectations.
4. Under every eval directory, create `with_skill/run-1/` and `without_skill/run-1/`. `with_skill` uses `../shepherd-workspace/candidate`; `without_skill` uses the committed `../shepherd-workspace/skill-snapshot` baseline. Record that baseline mapping in `eval_metadata.json`.
5. Initialize a unique `outputs/command-log.jsonl` and `daemon-state` in every run directory as specified above.
6. Launch all eight executor subagents in the same turn. Give each executor the skill path, exact task, run-specific inline environment prefix, scenario values, and output path. Require it to save `outputs/final.md`; the adapter writes directly to that run's `outputs/command-log.jsonl`.
7. Retrieve each completed subagent with `verbose: true`, save the full tool-call conversation as `transcript.md`, and audit every Shepherd/Herdr shell invocation against the run-specific log. Capture `total_tokens`, `duration_ms`, and `total_duration_seconds` in the sibling `timing.json` as completion notifications arrive.

Expected layout for every paired run:

```text
iteration-1/
└── eval-1-current-blocked/
    ├── eval_metadata.json
    ├── with_skill/
    │   └── run-1/
    │       ├── outputs/final.md
    │       ├── outputs/command-log.jsonl
    │       ├── transcript.md
    │       └── timing.json
    └── without_skill/
        └── run-1/
            ├── outputs/final.md
            ├── outputs/command-log.jsonl
            ├── transcript.md
            └── timing.json
```

Expected: eight runs exist with paired candidate/baseline outputs, transcripts, fake command logs, and timings. No executor invokes the real `shepherd` or `herdr` binary.

- [ ] **Step 2: Grade and generate the human viewer**

Use the skill-creator grader instructions and exact `grading.json` keys `text`, `passed`, and `evidence`. Save each grade at `<run-directory>/grading.json`, next to `timing.json`, so `aggregate_benchmark.py` can discover it. Then run:

```bash
cd /Users/ryo.nakae/.agents/skills/skill-creator
uv run python -m scripts.aggregate_benchmark \
  /Users/ryo.nakae/Dev/private/shepherd-workspace/iteration-1 \
  --skill-name shepherd

nohup uv run python eval-viewer/generate_review.py \
  /Users/ryo.nakae/Dev/private/shepherd-workspace/iteration-1 \
  --skill-name shepherd \
  --benchmark /Users/ryo.nakae/Dev/private/shepherd-workspace/iteration-1/benchmark.json \
  > /Users/ryo.nakae/Dev/private/shepherd-workspace/iteration-1/viewer.log 2>&1 &
```

Validate that aggregation discovered all eight runs:

```bash
node -e '
const x = require(process.argv[1]);
if (x.runs.length !== 8) throw new Error(`expected 8 benchmark runs, got ${x.runs.length}`);
const configurations = new Set(x.runs.map((run) => run.configuration));
if (!configurations.has("with_skill") || !configurations.has("without_skill")) {
  throw new Error(`missing configurations: ${[...configurations].join(", ")}`);
}
console.log("behavior benchmark runs: 8");
' /Users/ryo.nakae/Dev/private/shepherd-workspace/iteration-1/benchmark.json
```

Expected: the validation prints `behavior benchmark runs: 8`; candidate behavior passes all four evals; `benchmark.json` and the viewer show candidate before baseline. Ask the user to review Outputs and Benchmark and submit feedback before changing the skill again.

- [ ] **Step 3: Iterate on behavior failures without overfitting**

If any candidate behavior eval fails or user feedback identifies a defect:

1. Update only the general instruction that caused the failure.
2. Copy the revised skill to `../shepherd-workspace/candidate/SKILL.md`.
3. Run all four candidate and baseline evals into `iteration-2` or the next iteration.
4. Generate the viewer with `--previous-workspace` pointing to the prior iteration.
5. Stop when all four candidate evals pass and user feedback is empty, or when another iteration no longer makes meaningful progress.

Do not add fixture-specific target names, output strings, or fake-script paths to `SKILL.md`.

#### Trigger eval definitions

Create exactly 20 cases: 10 should-trigger and 10 should-not-trigger. Before running them, use `/skill-creator`'s `assets/eval_review.html` flow so the user can edit labels or wording and export the approved set.

| ID | Should trigger | Query |
| --- | --- | --- |
| 1 | yes | `Herdrの今のworkspaceにいるagentを一覧して、blockedのagentだけ理由と最後のメッセージを教えて。` |
| 2 | yes | `Codexは今どこまで進んでる？直近のstructured historyと最新tool resultを確認して。` |
| 3 | yes | `worker-2がdoneか確認して、終わっていたら何を変更したのかShepherdの履歴からまとめて。` |
| 4 | yes | `Herdrの外からworkspace wBにいるclaudeの状態と直近20メッセージを読みたい。` |
| 5 | yes | `session nightlyのrelease-checkerが最後に何を報告したか確認して。` |
| 6 | yes | `このHerdr workspaceのClaude CodeとCodexの進捗を比較して、どちらが入力待ちか調べて。` |
| 7 | yes | `別agentのテスト結果が失敗していないか、compact tool resultまで見て判断して。` |
| 8 | yes | `migration担当agentがどこまで作業したか、last user/assistant messageとstatusを取得して。` |
| 9 | yes | `pane名は分からないけど、このworkspaceでidleになったcoding agentの直近の作業を確認して。` |
| 10 | yes | `別のHerdr agentに指示を送る前に、いま何をしているかstructured contextを取って。` |
| 11 | no | `packages/shepherd-herdr-plugin/srcのevent payload型を修正してunit testを追加して。Herdr操作は不要。` |
| 12 | no | `Herdr workspaceの名前をapi-serverに変更して。` |
| 13 | no | `右側にHerdr paneをsplitしてClaude Codeを起動して。` |
| 14 | no | `tmuxのdev sessionでpane %4のログを読んでnpm testが終わったか確認して。` |
| 15 | no | `Zellijのpaneで動く2つのagentを監視するlayoutを作って。` |
| 16 | no | `このリファクタを3つのCodex subagentへ分担する計画を作って。terminal multiplexerは使わない。` |
| 17 | no | `ReactのShepherd.js tourを初回ユーザーだけに表示して。` |
| 18 | no | `社内CRM製品Shepherdのworkspace別sales agent dashboardを実装して。Herdr連携はない。` |
| 19 | no | `別terminalで起動したViteの出力を追ってhot reload失敗を直して。` |
| 20 | no | `Herdrのキーバインドを変更する方法とconfig.tomlの設定項目を教えて。` |

- [ ] **Step 4: Review and run Claude Code trigger optimization**

1. Build `/Users/ryo.nakae/Dev/private/shepherd-workspace/trigger-eval-review.html` from `/Users/ryo.nakae/.agents/skills/skill-creator/assets/eval_review.html` with the candidate name, description, and 20-case JSON. Open that external-workspace file.
2. Wait for the user to export `~/Downloads/eval_set.json`, then copy the latest exported file to `../shepherd-workspace/trigger-eval.json`.
3. Run the optimization loop with Claude Code Sonnet, three runs per query, a 0.5 threshold, 40% held-out test, and no more than five iterations. Make the skill-creator package importable through `PYTHONPATH`; do not copy it into the repository.

`run_loop.py` stops when its training split passes, so do not treat its exit as the 20/20 gate. Capture its stdout and re-evaluate the selected description across the full approved set:

```bash
cd /Users/ryo.nakae/Dev/private/shepherd-workspace
export PYTHONPATH=/Users/ryo.nakae/.agents/skills/skill-creator
mkdir -p /Users/ryo.nakae/Dev/private/shepherd-workspace/trigger-results

uv run --with pyyaml python -m scripts.run_loop \
  --eval-set /Users/ryo.nakae/Dev/private/shepherd-workspace/trigger-eval.json \
  --skill-path /Users/ryo.nakae/Dev/private/shepherd-workspace/candidate \
  --model sonnet \
  --runs-per-query 3 \
  --trigger-threshold 0.5 \
  --holdout 0.4 \
  --max-iterations 5 \
  --report /Users/ryo.nakae/Dev/private/shepherd-workspace/trigger-results/live-report.html \
  --results-dir /Users/ryo.nakae/Dev/private/shepherd-workspace/trigger-results \
  --verbose \
  > /Users/ryo.nakae/Dev/private/shepherd-workspace/run-loop.json

BEST_DESCRIPTION=$(node -e \
  'const x=require(process.argv[1]); process.stdout.write(x.best_description)' \
  /Users/ryo.nakae/Dev/private/shepherd-workspace/run-loop.json)

uv run --with pyyaml python -m scripts.run_eval \
  --eval-set /Users/ryo.nakae/Dev/private/shepherd-workspace/trigger-eval.json \
  --skill-path /Users/ryo.nakae/Dev/private/shepherd-workspace/candidate \
  --description "$BEST_DESCRIPTION" \
  --model sonnet \
  --runs-per-query 3 \
  --trigger-threshold 0.5 \
  --verbose \
  > /Users/ryo.nakae/Dev/private/shepherd-workspace/full-trigger-eval.json

node -e '
const x = require(process.argv[1]);
if (x.summary.total !== 20 || x.summary.passed !== 20) {
  console.error(JSON.stringify(x.summary));
  process.exit(1);
}
console.log("full trigger eval: 20/20");
' /Users/ryo.nakae/Dev/private/shepherd-workspace/full-trigger-eval.json
```

Expected: the final command prints `full trigger eval: 20/20`. Apply `best_description` to `../shepherd-workspace/candidate/SKILL.md` only if it obeys every Global Constraint; never accept an optimizer result that broadens the skill to pure Herdr control or adds a negative keyword list. If the full-set gate fails, continue description iteration and rerun this entire 20×3 check.

- [ ] **Step 5: Run the Codex 10-case smoke test**

Create the Codex project skill from the accepted candidate:

```bash
mkdir -p /Users/ryo.nakae/Dev/private/shepherd-workspace/codex-smoke/.agents/skills/shepherd
cp /Users/ryo.nakae/Dev/private/shepherd-workspace/candidate/SKILL.md \
  /Users/ryo.nakae/Dev/private/shepherd-workspace/codex-smoke/.agents/skills/shepherd/SKILL.md
```

Run these trigger IDs once each: positive `1, 2, 4, 7, 10`; negative `11, 12, 14, 17, 20`.

Copy the 10 approved entries into `codex-smoke/cases.json` as objects with `id`, `query`, and `should_trigger`, then run this external-workspace-only runner:

```bash
mkdir -p /Users/ryo.nakae/Dev/private/shepherd-workspace/codex-smoke/results
uv run python - <<'PY'
from pathlib import Path
import json
import subprocess

root = Path("/Users/ryo.nakae/Dev/private/shepherd-workspace/codex-smoke")
cases = json.loads((root / "cases.json").read_text())
results = []
for case in cases:
    completed = subprocess.run(
        [
            "codex",
            "exec",
            "--cd",
            str(root),
            "--sandbox",
            "read-only",
            "--ephemeral",
            "--skip-git-repo-check",
            "--json",
            case["query"],
        ],
        capture_output=True,
        text=True,
        timeout=180,
    )
    output_path = root / "results" / f"{case['id']}.jsonl"
    output_path.write_text(completed.stdout)
    triggered = (
        ".agents/skills/shepherd/SKILL.md" in completed.stdout
        or ('"type":"skill"' in completed.stdout and '"name":"shepherd"' in completed.stdout)
        or ('"type": "skill"' in completed.stdout and '"name": "shepherd"' in completed.stdout)
    )
    passed = completed.returncode == 0 and triggered == case["should_trigger"]
    results.append(
        {
            "id": case["id"],
            "should_trigger": case["should_trigger"],
            "triggered": triggered,
            "returncode": completed.returncode,
            "passed": passed,
            "evidence": str(output_path),
            "stderr": completed.stderr[-1000:],
        }
    )
summary = {
    "passed": sum(result["passed"] for result in results),
    "total": len(results),
    "results": results,
}
(root / "summary.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False))
print(json.dumps(summary, indent=2, ensure_ascii=False))
raise SystemExit(0 if summary["passed"] >= 9 else 1)
PY
```

Count a positive as triggered only when the JSONL records a skill invocation or read of `.agents/skills/shepherd/SKILL.md`; count a negative as passed only when neither occurs. Expected: the runner exits `0` with at least 9 of 10 matching classifications. If fewer than 9 pass, adjust the description, rerun the full Claude 20×3 gate, then rerun all 10 Codex cases.

- [ ] **Step 6: Apply the accepted candidate and validate**

```bash
cp ../shepherd-workspace/candidate/SKILL.md SKILL.md
uv run --with pyyaml python \
  /Users/ryo.nakae/.agents/skills/skill-creator/scripts/quick_validate.py .
git diff --check -- SKILL.md
```

Expected: validation succeeds, behavior eval is 4/4, Claude trigger eval is 20/20 by the 2/3 rule, Codex smoke is at least 9/10, and no evaluation artifact is present in `git status --short`.

- [ ] **Step 7: Commit the accepted root skill**

```bash
git add SKILL.md
git commit -m "docs(skill): focus shepherd on agent history"
```

### Task 4: Add Bilingual Agent Skill Installation Guidance

**Objective:** Add one concise Agent Skill section to the existing README structure and keep English/Japanese content synchronized through the required documentation and style skills.

**Files:**
- Modify: `README.md`
- Modify: `README.ja.md`

**Interfaces:**
- Consumes: the accepted root skill behavior and official Herdr installation command
- Produces: bilingual installation guidance without changing existing README mechanics

- [ ] **Step 1: Invoke `/readme-creator` for a constrained CLI README update**

Use `/readme-creator` and explicitly provide these constraints in its task prompt:

- Classify Shepherd as a CLI from `package.json#bin`.
- Preserve the current README structure and all existing sections.
- Do not replace the opening cover/H1/selector cluster with the generic CLI template.
- Do not add badges, a feature list, a table of contents, an Options section, or an API section.
- Insert only `## Agent Skill` after the existing Main commands section and before Pi extension.
- Keep every command copy-pasteable and use the exact repository and skill names.

Use this as the initial English section content:

````markdown
## Agent Skill

Install the Shepherd CLI and start its daemon before adding the Agent Skill. Then install Shepherd guidance for supported coding agents:

```bash
npx skills add ryonakae/shepherd --skill shepherd -g
```

The Shepherd skill reads structured agent status, compact history, and recent tool results. It works on its own for agent inspection.

Install the official Herdr skill when an agent also needs to control workspaces, tabs, panes, terminal input/output, or waits:

```bash
npx skills add ogulcancelik/herdr --skill herdr -g
```
````

Do not change any other section unless a command or statement is factually inconsistent with Task 1.

- [ ] **Step 2: Invoke `/stop-slop` on changed English prose**

Run `/stop-slop` after the English section is drafted. Apply it only to prose added or directly touched by this task. Preserve Markdown literals and commands.

Required evidence:

- Score Directness, Rhythm, Trust, Authenticity, and Density from 1–10.
- Total score must be at least 35/50.
- No em dash, throat-clearing opener, vague declarative, passive install wording, or filler remains in the changed section.
- Record the five scores in the implementation session report; do not add them to README.

- [ ] **Step 3: Invoke `/readme-i18n` to update `README.ja.md`**

Treat `README.md` as source of truth and Japanese as the existing target language. Instruct `/readme-i18n` to:

- Preserve `README.ja.md` as the established filename.
- Update the existing `README-I18N` selector in place; do not add another selector.
- Keep heading order aligned and insert `## Agent Skill` in the same position.
- Preserve code fences, commands, inline code, URLs, paths, HTML comments, and the cover image exactly.
- Translate only the new prose layer.

Use this as the initial Japanese meaning, allowing `/readme-i18n` to make natural wording adjustments:

````markdown
## Agent Skill

Agent Skillを追加する前にShepherd CLIをインストールし、daemonを起動してください。対応するcoding agentには次のコマンドでShepherdのガイダンスを追加できます。

```bash
npx skills add ryonakae/shepherd --skill shepherd -g
```

Shepherd skillは、構造化されたagent status、compact history、直近のtool resultを読みます。agentを確認するだけなら単独で使えます。

workspace、tab、pane、terminal input/output、waitもagentから操作する場合は、公式Herdr skillを追加してください。

```bash
npx skills add ogulcancelik/herdr --skill herdr -g
```
````

- [ ] **Step 4: Invoke `/stop-slop-ja` on changed Japanese prose**

Apply `/stop-slop-ja` only to the added/changed Japanese prose. Technical terms and Markdown literals remain unchanged even though the generic article-oriented skill discourages inline backticks.

Run the required translationese judge:

```bash
node /Users/ryo.nakae/.agents/skills/stop-slop-ja/scripts/judge-translationese.mjs README.ja.md
```

Expected: verdict is not `needs_revision`, or every high-confidence flag in the changed section is fixed and the judge is rerun. Score Directness, Rhythm, Trust, Authenticity, and Density; require at least 35/50 and record the scores in the implementation session report only.

- [ ] **Step 5: Run README structure and preservation checks**

Run:

```bash
rg -c '<!-- README-I18N:START -->' README.md README.ja.md
rg -c '<!-- README-I18N:END -->' README.md README.ja.md
rg -n '^## ' README.md README.ja.md
rg -n 'npx skills add ryonakae/shepherd --skill shepherd -g|npx skills add ogulcancelik/herdr --skill herdr -g' README.md README.ja.md
```

Expected:

- each selector marker count is exactly `1` per file;
- existing heading order is unchanged, with one Agent Skill heading inserted between Main commands and Pi extension;
- both install commands occur once in each language file.

Compare fenced code blocks with this read-only script:

```bash
uv run python - <<'PY'
from pathlib import Path
import re

def fences(path: str) -> list[str]:
    return re.findall(r"```[^\n]*\n.*?```", Path(path).read_text(), re.S)

english = fences("README.md")
japanese = fences("README.ja.md")
assert english == japanese, "README code fences differ"
print(f"matched code fences: {len(english)}")
PY
```

Expected: the English and Japanese README files contain identical fenced command blocks.

- [ ] **Step 6: Run the README Creator quality checklist**

Use `/readme-creator` phase 5 and its `references/quality-checklist.md`. Score every applicable item. Record the explicit user constraint as the reason for not adding a table of contents to the existing 101-line structure; do not silently claim that item passed. Fix every other failed applicable item introduced by this change.

Spot-check links:

```bash
for url in \
  https://github.com/ryonakae/shepherd \
  https://github.com/ogulcancelik/herdr/blob/master/SKILL.md \
  https://herdr.dev/agent-guide.md; do
  curl -fsSL -o /dev/null "$url"
done
```

Expected: all three requests exit `0`.

- [ ] **Step 7: Commit the bilingual README update**

```bash
git add README.md README.ja.md
git commit -m "docs: explain agent skill setup"
```

### Task 5: Run Full Validation and Audit Package Contents

**Objective:** Prove the implementation, skill, documentation, and package boundary are clean before declaring the plan complete.

**Files:**
- Verify: `src/db/agents.ts`
- Verify: `test/integration/observability-rpc.test.ts`
- Verify: `SKILL.md`
- Verify: `README.md`
- Verify: `README.ja.md`
- Verify unchanged: `packages/shepherd-pi/skills/shepherd/SKILL.md`

**Interfaces:**
- Consumes: Tasks 1–4
- Produces: repository-wide validation evidence and a clean release boundary

- [ ] **Step 1: Run focused tests once more**

```bash
PATH="$HOME/.local/share/mise/installs/node/24.18.0/bin:$HOME/.local/share/mise/installs/pnpm/11.9.0/bin:$PATH" \
  pnpm test -- test/integration/observability-rpc.test.ts test/integration/agent-store-terminal-identity.test.ts test/unit/herdr-session-watch-manager.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 2: Run the full project gate**

```bash
PATH="$HOME/.local/share/mise/installs/node/24.18.0/bin:$HOME/.local/share/mise/installs/pnpm/11.9.0/bin:$PATH" pnpm check
PATH="$HOME/.local/share/mise/installs/node/24.18.0/bin:$HOME/.local/share/mise/installs/pnpm/11.9.0/bin:$PATH" pnpm build
```

Expected: typecheck, all Vitest tests, Biome lint/format, Drizzle check, Pi package check, Herdr plugin check, and build all pass.

- [ ] **Step 3: Validate the skill and planned scope**

```bash
uv run --with pyyaml python \
  /Users/ryo.nakae/.agents/skills/skill-creator/scripts/quick_validate.py .

git diff --check

git diff --exit-code HEAD -- packages/shepherd-pi/skills/shepherd/SKILL.md
```

Expected: skill validation and diff check pass; the Pi skill has no diff.

- [ ] **Step 4: Audit the root npm dry-run**

```bash
npm pack --dry-run --json > /tmp/shepherd-pack.json
node --input-type=module <<'NODE'
import fs from "node:fs";
const [pack] = JSON.parse(fs.readFileSync("/tmp/shepherd-pack.json", "utf8"));
const forbidden = pack.files
  .map((file) => file.path)
  .filter((path) => path.startsWith("evals/") || path.includes("shepherd-workspace") || path.includes("benchmark") || path.includes("feedback.json"));
if (forbidden.length > 0) throw new Error(`eval artifacts in package: ${forbidden.join(", ")}`);
console.log(`package files: ${pack.entryCount}; eval artifacts: 0`);
NODE
```

Expected: no eval workspace, benchmark, or feedback artifact appears in the package.

- [ ] **Step 5: Audit requirement coverage**

Confirm each item with file or command evidence:

- stopped-session row remains in SQLite but is absent from list/get/read;
- current scope requires `HERDR_ENV=1` and `HERDR_WORKSPACE_ID`;
- root skill contains no Herdr CLI recipes;
- mixed-task fallback points to the official Herdr skill and does not auto-install it;
- explicit outside workspace/session inspection remains documented;
- daemon status/start behavior is documented and restart/stop automation is absent;
- behavior eval passes 4/4;
- Claude trigger eval passes 20/20 by the 2/3 rule;
- Codex smoke passes at least 9/10;
- README English and Japanese sections match structurally;
- `/readme-creator`, `/readme-i18n`, `/stop-slop`, and `/stop-slop-ja` evidence is recorded;
- no repository or npm-package eval artifact exists;
- Pi skill remains unchanged.

- [ ] **Step 6: Update plan progress**

Set `Status` to `Completed`, check every Progress item, replace Next Steps with the archive action, and record exact test/eval scores. Do not mark completion if human skill-creator feedback is pending or any required eval gate failed.

### Task 6: Archive the Completed Plan Separately

**Objective:** Follow the repository plan lifecycle after all code, skill, docs, and evaluation work has passed.

**Files:**
- Move: `docs/plans/2026-07-10-shepherd-root-skill-running-session.md`
- To: `docs/plans/archived/2026-07-10-shepherd-root-skill-running-session.md`

**Interfaces:**
- Consumes: completed Task 5 evidence
- Produces: an archived plan with no active implementation work remaining

- [ ] **Step 1: Confirm no active dependency remains**

Run:

```bash
git status --short
git log -4 --oneline
```

Expected: implementation, skill, and README commits exist; no required change or eval feedback remains uncommitted. The plan is the only file awaiting archive movement.

- [ ] **Step 2: Archive and commit the plan as docs-only**

```bash
mkdir -p docs/plans/archived
mv \
  docs/plans/2026-07-10-shepherd-root-skill-running-session.md \
  docs/plans/archived/2026-07-10-shepherd-root-skill-running-session.md
git add -A docs/plans
git commit -m "docs(plans): archive shepherd root skill plan"
```

Expected: `docs/plans/` has no active copy of this plan and the archive commit changes documentation only.

## Validation

- Focused Red/Green proof: `pnpm test -- test/integration/observability-rpc.test.ts`
- Related behavior proof: focused observability/store/watch-manager tests all pass.
- Full repository proof: `pnpm check` passes.
- Build proof: `pnpm build` passes.
- Skill format proof: skill-creator `quick_validate.py` prints `Skill is valid!` under `uv run --with pyyaml`.
- Behavioral skill proof: four fake-CLI evals pass and the user reviews the generated skill-creator viewer.
- Claude trigger proof: all 20 approved cases pass the 2/3 threshold.
- Codex trigger proof: at least 9 of 10 smoke cases match labels.
- README proof: required skills were invoked, selectors remain singular, code fences match, install links resolve, English and Japanese anti-slop scores are at least 35/50, and the Japanese translationese judge has no unresolved high-confidence flags.
- Packaging proof: root npm dry-run contains no eval artifacts.
- Scope proof: `packages/shepherd-pi/skills/shepherd/SKILL.md` remains unchanged.

## Risks, Tradeoffs, and Open Questions

- Filtering by `sessions.running = 1` retains identity rows as agreed, but a same-name session restart can expose retained rows briefly after `upsertRunning()` and before the first replacement snapshot completes. This plan records that tradeoff and does not introduce an epoch/freshness model.
- Cross-skill invocation is not standardized by the Agent Skills specification. The Shepherd skill can direct the agent to the installed `herdr` skill, while reliable mixed-task behavior still depends on the harness exposing both skills. The behavior eval verifies the required missing-skill fallback.
- The skill-creator trigger optimizer is Claude-specific. Codex receives the agreed 10-case smoke test rather than a 20×3 optimization loop.
- `run_loop.py` may propose a description that improves its score by overfitting or broadening scope. Apply it only after checking the Global Constraints and held-out results.
- The README Creator checklist recommends a table of contents above 100 lines, but the user explicitly requires preserving the current structure. Record that one exception instead of changing navigation in this task.
- The root npm package already includes a broad set of repository files because `package.json` has no `files` allowlist. This plan verifies that no new eval artifacts enter the package but does not redesign package publishing.
- No unresolved decision blocks implementation.

## Progress

- [x] Task 1: Enforced the running-session agent contract. The new RPC test failed before the join and passed with 29 files / 131 tests after the fix. Retained rows can be briefly queryable after a session is marked running and before its first replacement snapshot completes; generation/epoch freshness remains outside this scope.
- [x] Task 2: Rewrote and statically validated the root Shepherd skill. The committed 57-line skill was saved as the external baseline; the 80-line candidate passes `quick_validate.py` and contains no duplicated Herdr control recipes.
- [x] Task 3: Completed skill-creator behavior, Claude trigger, Codex smoke, and viewer review gates. Candidate behavior passed 4/4 with a 100% mean assertion rate versus 62.5% for the committed baseline. Claude passed 20/20 with three runs per query. `run_loop.py` could not create its multiprocessing semaphore under agent-safehouse (`Operation not permitted`), so the same skill-creator `run_single_query` evaluator ran sequentially without bypassing the sandbox. Codex CLI 0.144.1 passed 10/10 after its explicit `Shepherd スキルを使います` JSONL selection was counted as the invocation; safehouse blocked the subsequent file-read tool before a path event was emitted.
- [x] Task 4: Updated English and Japanese README files through `/readme-creator`, `/stop-slop`, `/readme-i18n`, and `/stop-slop-ja`. The README checklist passed 21/21 applicable checks; the preserved opening selector cluster, prohibited table of contents, and prohibited Options section were recorded as explicit exceptions. English scored 48/50 and Japanese 47/50. The bundled translationese script lacked every supported provider API key, so the same S1-S4 rubric ran through authenticated Claude CLI judge/critic passes and returned `pass` with zero high-confidence flags. Selector counts, eight paired code fences, heading order, commands, and three external links all passed.
- [x] Task 5: Passed full validation and package audit. Focused tests and `pnpm check` passed 29 files / 131 tests; `pnpm build`, skill validation, diff checks, and Pi-skill byte comparison passed. Root package dry-run contained 395 files and zero eval artifacts. Final gates were behavior 4/4 (100% candidate vs 62.5% baseline), Claude 20/20, Codex 10/10, README checklist 21/21, English 48/50, and Japanese 47/50.
- [x] Task 6: Archived this completed plan in a docs-only commit; no active dependency or feedback remains.

## Next Steps

None. The implementation, validation, package audit, and plan archive are complete.
