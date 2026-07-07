# Shepherd

<!-- README-I18N:START -->

**English** | [日本語](./README.ja.md)

<!-- README-I18N:END -->

Shepherd keeps worker state for coding agents that run in Herdr, then exposes that state to humans, Herdr plugin actions, Pi, and shell commands.

In Shepherd, a **worker** is one coding-agent run that Shepherd can track across a Herdr workspace or pane. A worker record keeps the agent's status, summary, blocked reason, recommended action, and evidence.

- **Durable worker state:** Shepherd maps Herdr workspaces, panes, and runtime telemetry into stable worker records.
- **Readable snapshots:** Shepherd stores status, summaries, blocked reasons, recommended actions, confidence, and evidence in SQLite.
- **Worker events:** Shepherd records `worker.*` events for completion, blocked work, input requests, tool failures, summary updates, and status changes.
- **Notifications for orchestrators:** Shepherd delivers unread worker events to CLI subscribers and the Pi extension.
- **Runtime bridges:** The Pi extension sends redacted telemetry. The Herdr plugin adds a `context` action and a worker dashboard pane.

## How it fits

Run the Shepherd daemon before using the bridges. The daemon owns the SQLite database and JSON Lines socket under `$SHEPHERD_HOME` (`~/.shepherd` by default). The CLI, Pi extension, and Herdr plugin connect to that daemon.

Herdr controls workspaces, tabs, panes, and agents. Pi owns the model conversation. Shepherd stores worker state and notification history between those systems.

## Why use Shepherd?

Herdr gives humans and agents the control surface: workspaces, tabs, panes, agent status, and command execution. Shepherd gives those agent runs a shared memory layer: worker snapshots, summaries, blocked reasons, recommended actions, evidence, events, and unread notifications.

With the Shepherd Agent Skill installed, an agent can start with `shepherd context --json`, read what other workers are doing, and decide its next step without scraping panes. Herdr still controls panes and agents; Shepherd reads durable worker context.

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
## Packages

| Package | Purpose |
|---------|---------|
| [`packages/shepherd-pi`](packages/shepherd-pi) | Pi extension for telemetry and worker notifications. |
| [`packages/shepherd-herdr-plugin`](packages/shepherd-herdr-plugin) | Herdr plugin with a `context` action and dashboard pane. |

## License

[MIT](LICENSE)
