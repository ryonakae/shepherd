---
name: shepherd
description: "Use Shepherd inside Herdr to read compact agent history for coding agents. Use when HERDR_ENV=1 or when the user gives a Herdr workspace/session scope."
---

# shepherd - agent history skill

Before using Shepherd, check whether the Shepherd daemon is running. If a command cannot connect, ask the user to run:

```bash
shepherd daemon start
```

## Read current Herdr workspace agents

Inside Herdr, start with:

```bash
shepherd agent list --json
```

Use this to see agents in the current workspace and their compact last user/assistant messages.

## Read one agent

```bash
shepherd agent get <target> --json
```

Use this for one agent's metadata, compact history, and latest compact tool result.

## Read recent messages

```bash
shepherd agent read <target> --limit 20 --json
```

This returns recent structured user, assistant, and compact `tool_result` messages. It does not return raw full tool output by default.

## Outside Herdr

Use an explicit scope:

```bash
shepherd agent list --all --json
shepherd agent list --workspace wB --json
shepherd agent get claude --workspace wB --json
```

Use `--session <name>` when workspace ids or agent names are ambiguous across running Herdr sessions.

## Boundaries

- Use Herdr for workspace, tab, pane, terminal output, wait, send, focus, and attach operations.
- Use Shepherd for compact agent history and agent updates. The `shepherd-pi` extension gives every Pi current-workspace compact context, but includes unread updates only for the explicitly selected Shepherd orchestrator terminal. Do not claim that role unless the user asks.
- Do not assume target names; read them from `shepherd agent list --json`.
- Do not expect stopped Herdr sessions to be indexed.
