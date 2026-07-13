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
