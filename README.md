# Shepherd

Shepherd gives coding agents a compact, queryable view of other agents running in Herdr, without scraping terminal panes.

<!-- README-I18N:START -->
**English** | [日本語](./README.ja.md)
<!-- README-I18N:END -->

Herdr remains the control surface for workspaces, tabs, panes, and terminal I/O. Shepherd follows running Herdr sessions, discovers agent history files, caches compact history, and delivers agent updates to integrations such as Pi.

## Why use Shepherd?

- **Agent context from the CLI:** check what another agent is doing without reading its terminal pane.
- **Compact history:** fetch the latest user, assistant, and tool-result excerpts without replaying full transcripts.
- **Pi and Herdr integration:** pass current-workspace agent history and unread agent updates into Pi, and show compact agent rows in Herdr.

## Requirements

- Node.js >= 24.18.0
- pnpm >= 11.9.0
- Herdr with socket API support

## Install from source

```bash
git clone https://github.com/ryonakae/shepherd.git
cd shepherd
pnpm install
pnpm build
npm install -g . --ignore-scripts
shepherd help
```

## Start the daemon

Shepherd agent commands require the daemon. It watches all running Herdr sessions reported by `herdr session list --json`, rescans them every 60 seconds, and ignores stopped sessions. Runtime files live in `~/.shepherd` by default; set `SHEPHERD_HOME` to use another directory.

```bash
shepherd daemon start
```


## Main commands

Inside a Herdr workspace, Shepherd selects the current workspace automatically:

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

- `shepherd agent list` returns agents in the selected workspace plus compact last user and assistant messages.
- `shepherd agent get <target>` returns one agent's metadata and compact history, including the latest compact tool result.
- `shepherd agent read <target> --limit N` returns recent structured user, assistant, and compact `tool_result` messages.

Targets follow Herdr conventions where possible: pane id, terminal id, or a unique agent name in the selected scope.

## Pi extension

The `shepherd-pi` extension connects to the Shepherd daemon when Pi runs inside Herdr. Before a Pi turn, it injects current-workspace compact agent history as hidden context. It also receives unread agent updates from the daemon and includes them in the next turn.

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

## License

[MIT](./LICENSE)
