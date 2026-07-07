# Shepherd

Shepherd keeps worker state for coding agents that run in Herdr, then exposes that state to humans, Herdr plugin actions, Pi, and shell commands.

<!-- README-I18N:START -->

**English** | [日本語](./README.ja.md)

<!-- README-I18N:END -->

- **Durable worker state:** Shepherd maps Herdr workspaces, panes, and runtime telemetry into stable worker records.
- **Readable snapshots:** Shepherd stores status, summaries, blocked reasons, recommended actions, confidence, and evidence in SQLite.
- **Worker events:** Shepherd records `worker.*` events for completion, blocked work, input requests, tool failures, summary updates, and status changes.
- **Notifications for orchestrators:** Shepherd delivers unread worker events to CLI subscribers and the Pi extension.
- **Runtime bridges:** The Pi extension sends redacted telemetry. The Herdr plugin adds a `context` action and a worker dashboard pane.

## How it fits

Run the Shepherd daemon before using the bridges. The daemon owns the SQLite database and JSON Lines socket under `$SHEPHERD_HOME` (`~/.shepherd` by default). The CLI, Pi extension, and Herdr plugin connect to that daemon.

Herdr controls workspaces, tabs, panes, and agents. Pi owns the model conversation. Shepherd stores worker state and notification history between those systems.

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

Keep the daemon running while Pi or Herdr reads Shepherd data.

## Add the runtime bridges

```bash
pi install ./packages/shepherd-pi
herdr plugin install ryonakae/shepherd/packages/shepherd-herdr-plugin --ref v0.1.0
```

During development, use `herdr plugin link ./packages/shepherd-herdr-plugin` instead of installing the tagged release.

## Read worker context

Agents should read [`SKILL.md`](SKILL.md). Inside a Herdr-managed pane, agents start with one command:

```bash
shepherd context --json
```

From a source checkout, run the same command through the built CLI:

```bash
node dist/src/cli/shepherd.js context --json
```

Humans can use the Herdr plugin action for the same current workspace context:

```bash
herdr plugin action invoke context --plugin shepherd.observability
```

Use `--subscriber shepherd-agent` only when you need unread worker notifications. Without `--subscriber`, `context` returns the current snapshot and `notifications: { "subscription": null, "events": [] }`.

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

Run `node dist/src/cli/shepherd.js help` to see daemon, context, observe, snapshot, event, notification, ack, and worker commands.

## Packages

| Package | Purpose |
|---------|---------|
| [`packages/shepherd-pi`](packages/shepherd-pi) | Pi extension for telemetry and worker notifications. |
| [`packages/shepherd-herdr-plugin`](packages/shepherd-herdr-plugin) | Herdr plugin with a `context` action and dashboard pane. |

## License

[MIT](LICENSE)
