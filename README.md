# Shepherd

Shepherd indexes Herdr agents and their agent history so coding agents can read compact agent history without scraping terminal panes.

Herdr remains the control surface for workspaces, tabs, panes, and terminal I/O. Shepherd reads running Herdr sessions, discovers agent history files, caches compact history, and delivers agent updates to integrations such as Pi.

## Requirements

- Node.js >= 24.18.0
- pnpm >= 11.9.0
- Herdr with socket API support

## Start the daemon

Shepherd commands require the daemon. It watches all running Herdr sessions reported by `herdr session list --json` and rescans them every 60 seconds.

```bash
shepherd daemon start
```

Stopped Herdr sessions are not indexed.

## Main commands

Inside a Herdr workspace, the current workspace is selected automatically:

```bash
shepherd agent list --json
shepherd agent get claude --json
shepherd agent read claude --limit 20 --json
```

From outside Herdr, pass a scope:

```bash
shepherd agent list --all --json
shepherd agent list --workspace wB --json
shepherd agent get claude --workspace wB --json
shepherd agent read wB:p2 --workspace wB --limit 20 --json
```

Use `--session <name>` when the same workspace id or agent name is ambiguous across running Herdr sessions.

## Command behavior

- `shepherd agent list` returns agents in the selected workspace plus compact last user/assistant messages.
- `shepherd agent get <target>` returns one agent's metadata and compact history, including the latest compact tool result.
- `shepherd agent read <target> --limit N` returns recent structured user, assistant, and compact `tool_result` messages.

Targets follow Herdr conventions where possible: pane id, terminal id, or a unique agent name in the selected scope.

## Pi extension

The `shepherd-pi` extension can inject current-workspace compact agent history before a Pi turn. It also receives unread agent updates from the daemon and includes compact history in hidden context.

## Packages

| Path | Purpose |
| --- | --- |
| `packages/shepherd-pi` | Pi extension for agent history and agent updates. |
| `packages/shepherd-herdr-plugin` | Herdr plugin for showing compact Shepherd agent rows. |

## Development

```bash
pnpm install
pnpm check
pnpm build
```

DB schema changes require:

```bash
pnpm db:generate
pnpm db:check
```
