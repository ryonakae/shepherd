![Shepherd cover](./assets/shepherd-cover.png)

# Shepherd

<!-- README-I18N:START -->
**English** | [日本語](./README.ja.md)
<!-- README-I18N:END -->

Shepherd is a tool for reading the state and compact history of other agents running in Herdr from the CLI.

Herdr's `herdr agent read` can also read another agent's output. However, it reads terminal streams or scrollback, so it is hard to retrieve agent history as structured data and the output includes extra text. Shepherd reads agent session data and provides another agent's work status, latest message excerpts, and unread agent updates in an easier-to-use format.

Shepherd currently supports session history from Claude Code, Codex, Gemini CLI, OpenCode, and Pi.

## Requirements

- Node.js >= 24.18.0
- pnpm >= 11.9.0
- Herdr >= 0.7.0

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

Shepherd agent commands require the daemon. The daemon watches all running Herdr sessions reported by `herdr session list --json`, rescans them every 60 seconds, and does not index stopped Herdr sessions. Runtime files live in `~/.shepherd` by default. Set `SHEPHERD_HOME` to use another directory.

```bash
shepherd daemon start
```

## Main commands

- `shepherd agent list`: returns agents in the selected workspace plus the last user / assistant message.
- `shepherd agent get <target>`: returns one agent's metadata and compact history. It also includes the latest compact tool result.
- `shepherd agent read <target> --limit N`: returns the latest N user / assistant / compact `tool_result` messages.

Inside a Herdr workspace, Shepherd selects the current workspace automatically.

```bash
shepherd agent list --json
shepherd agent get claude --json
shepherd agent read claude --limit 20 --json
```

From outside Herdr, pass a scope.

```bash
shepherd agent list --all --json
shepherd agent list --workspace wB --json
shepherd agent get claude --workspace wB --json
shepherd agent read wB:p2 --workspace wB --limit 20 --json
```

`<target>` can be a pane id, terminal id, or agent name that is unique in the selected scope, following Herdr conventions where possible. Use `--session <name>` when the same workspace id or agent name exists in multiple running Herdr sessions.

## Agent Skill

Install the Shepherd CLI and start its daemon before adding the Agent Skill. Then add the Shepherd instructions to supported coding agents:

```bash
npx skills add ryonakae/shepherd --skill shepherd -g
```

The Shepherd skill reads structured agent status, compact history, and recent tool results. Use it alone for agent inspection.

Add the official Herdr skill when an agent needs to control workspaces, tabs, panes, terminal input/output, or waits:

```bash
npx skills add ogulcancelik/herdr --skill herdr -g
```

## Pi extension

The `shepherd-pi` extension connects to the Shepherd daemon when Pi runs inside Herdr. Every connected Pi receives compact current-workspace agent history as hidden context before a turn. Pushed unread agent updates go only to the terminal explicitly selected as that workspace's Shepherd orchestrator.

Enter `/shepherd orchestrator on` in Pi to claim the role. Use `/shepherd orchestrator` or `/shepherd orchestrator status` to inspect it, and `/shepherd orchestrator off` from the owner to release it. Claiming from another Pi in the same Herdr session/workspace transfers the role atomically. With no owner, no Pi receives pushed updates.

The role follows the Herdr terminal across Pi session replacement and pane movement. It clears when that terminal remains disconnected beyond the grace period. Only the owner shows `Shepherd: orchestrator` in the Pi footer.

## Herdr plugin

`shepherd-herdr-plugin` is an optional Herdr plugin. Inside a Herdr workspace, it connects to the Shepherd daemon and shows compact agent rows for the current workspace in the Herdr UI. It is not required if you only use the Shepherd CLI or Pi extension.

## Packages

| Path | Purpose |
| --- | --- |
| `packages/shepherd-pi` | Pi extension for agent history and agent updates. |
| `packages/shepherd-herdr-plugin` | Optional plugin that shows compact agent rows in the Herdr UI. |

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
