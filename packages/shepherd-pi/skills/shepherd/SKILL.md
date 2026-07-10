---
name: shepherd
description: "Use Shepherd inside Herdr to read compact agent history for coding agents. Use when HERDR_ENV=1 or when the user gives a Herdr workspace/session scope."
---

# shepherd - agent history skill

Shepherd commands require the Shepherd daemon. If a command cannot connect, ask the user to run:

```bash
shepherd daemon start
```

Inside Herdr, start with:

```bash
shepherd agent list --json
```

Use `shepherd agent get <target> --json` for one agent's metadata and compact history.
Use `shepherd agent read <target> --limit 20 --json` for recent structured user, assistant, and compact `tool_result` messages.

Outside Herdr, pass scope explicitly:

```bash
shepherd agent list --all --json
shepherd agent list --workspace wB --json
shepherd agent get claude --workspace wB --json
```

Use Herdr for pane/tab/terminal control. Use Shepherd for compact agent history.

When the `shepherd-pi` extension is active, current-workspace compact agent history remains available to every Pi instance before a turn. Unread agent updates are included only when that terminal is the explicit Shepherd orchestrator. Do not claim the orchestrator role unless the user asks.
