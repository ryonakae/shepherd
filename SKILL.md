---
name: shepherd
description: "Use Shepherd inside Herdr to read worker snapshots, worker events, and notifications for coding agents. Use when HERDR_ENV=1 or when the user gives you an observed workspace id."
---

# shepherd - agent skill

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
