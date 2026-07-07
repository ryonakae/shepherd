# Shepherd

Shepherd watches coding-agent runs inside Herdr and keeps their worker state available to Pi, Herdr panes, and shell commands.

<!-- README-I18N:START -->

**English** | [日本語](./README.ja.md)

<!-- README-I18N:END -->

- **Worker state that survives pane changes:** Shepherd maps Herdr workspaces, panes, and runtime telemetry into stable worker records.
- **Readable snapshots:** Shepherd stores summaries, status, blocked reasons, recommended actions, confidence, and evidence in SQLite.
- **Worker events:** Shepherd records `worker.*` events for completion, blocked work, input requests, tool failures, summary updates, and status changes.
- **Orchestrator notifications:** Shepherd delivers unread worker events to CLI subscribers and the Pi extension.
- **Runtime bridges:** The Pi extension sends redacted telemetry and injects worker notifications into the next turn. The Herdr plugin adds an observe action and a worker dashboard pane.

## How it fits

Run Shepherd as a daemon before you use the bridges. The daemon owns the SQLite database and JSON Lines socket under `$SHEPHERD_HOME` (`~/.shepherd` by default). The CLI, Pi extension, and Herdr plugin connect to that daemon.

Herdr controls workspaces, tabs, panes, and agents. Pi owns the model conversation. Shepherd stores the worker state and history between those live systems.

## Requirements

Use Node.js 24.18.0+, pnpm 11.9.0+, Herdr 0.7.0+ for the Herdr plugin, and Pi for the Pi extension. The setup below uses mise to install Node.js and pnpm.

## Quick start from source

```bash
git clone https://github.com/ryonakae/shepherd.git
cd shepherd
mise trust
mise install
pnpm install
pnpm build
node dist/src/cli/shepherd.js daemon start
node dist/src/cli/shepherd.js daemon status
```

The daemon must keep running while Pi or Herdr reads Shepherd data.

## Add the runtime bridges

```bash
pi install ./packages/shepherd-pi
herdr plugin install ryonakae/shepherd/packages/shepherd-herdr-plugin --ref v0.1.0
```

During development, use `herdr plugin link ./packages/shepherd-herdr-plugin` instead of installing the tagged release.

## Observe a Herdr workspace

Run these commands inside a Herdr-managed pane after the daemon starts:

```bash
OBSERVED_WORKSPACE_ID=$(node dist/src/cli/shepherd.js observe-current --json | node -e 'let s=""; process.stdin.on("data", d => s += d); process.stdin.on("end", () => console.log(JSON.parse(s).observedWorkspace.id));')
node dist/src/cli/shepherd.js snapshot "$OBSERVED_WORKSPACE_ID" --json
node dist/src/cli/shepherd.js notifications "$OBSERVED_WORKSPACE_ID" --subscriber pi-session --json
```

The Pi extension uses the same daemon socket. It sends bounded, redacted tool and message excerpts to Shepherd, then adds unread worker notifications to the next Pi turn as hidden context.

## Configuration

Shepherd reads `$SHEPHERD_HOME/config.yaml`. If `SHEPHERD_HOME` is unset, Shepherd uses `~/.shepherd`.

```yaml
runtime:
  db_path: state.db
  socket_path: shepherd.sock
  pid_path: shepherd.pid
  log_path: logs/shepherd.log
observability:
  telemetry:
    max_excerpt_bytes: 4096
```

Run `node dist/src/cli/shepherd.js help` to see daemon, observe, snapshot, event, notification, ack, and worker commands.

## Packages

| Package | Purpose |
|---------|---------|
| [`packages/shepherd-pi`](packages/shepherd-pi) | Pi extension for telemetry and worker notifications. |
| [`packages/shepherd-herdr-plugin`](packages/shepherd-herdr-plugin) | Herdr plugin with an observe action and dashboard pane. |

## Development

```bash
pnpm check                # typecheck, tests, Biome, Drizzle, Pi package, Herdr plugin
pnpm build                # emit dist and rewrite TS path aliases
pnpm test                 # run Vitest once
pnpm db:generate          # generate Drizzle migrations
pnpm pi-package:check     # check the Pi extension package
pnpm herdr-plugin:check   # check the Herdr plugin package
```

## License

[MIT](LICENSE)
