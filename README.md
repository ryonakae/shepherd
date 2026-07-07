# Shepherd

Watch Herdr-managed coding agents, store their work state, and send useful notifications to orchestrator runtimes such as Pi.

<!-- README-I18N:START -->

**English** | [日本語](./README.ja.md)

<!-- README-I18N:END -->

In Shepherd, a worker is one coding-agent run that Shepherd tracks inside an observed Herdr workspace. The worker may move between panes or tabs, but Shepherd keeps one record for its state, events, and notifications.

- **Worker snapshots:** record summary, current work, completion state, blocked reason, recommended action, confidence, and evidence.
- **Worker events:** store enriched `worker.*` events for completions, blocks, input requests, tool failures, summary updates, and status changes.
- **Runtime notifications:** deliver unread worker events to CLI subscribers and the Pi extension.
- **Herdr integration:** observe workspaces through Herdr socket/session APIs and resolve live workspace/worker state from Herdr snapshots.
- **Runtime bridges:** use the Pi extension for telemetry and notification context, and the Herdr plugin for observe actions and a dashboard pane.

## Herdr plus Shepherd

Herdr controls workspaces, panes, and agents in real time. Shepherd adds durable worker context to that live control surface:

- **Stable worker records:** map Herdr sessions, panes, and runtime telemetry into worker ids that survive tab movement and later inspection.
- **Readable state:** convert terminal/session facts into snapshots an orchestrator can scan without reading pane buffers.
- **Event history:** keep worker events and notification cursors so another process can resume from the last acknowledged event.
- **Pi context:** deliver unread worker events to Pi status, widgets, session entries, and next-turn hidden context.

## Requirements

Node.js 24.18.0+, pnpm 11.9.0+, Herdr 0.7.0+, and Pi for `packages/shepherd-pi`.

## Quick start

```bash
mise trust
mise install
pnpm install
pnpm check
pnpm build

node dist/src/cli/shepherd.js daemon start
pi install ./packages/shepherd-pi
herdr plugin link ./packages/shepherd-herdr-plugin
```

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

Shepherd stores sanitized worker events and snapshots. Retention settings belong in a future schema change.

## CLI usage

```bash
node dist/src/cli/shepherd.js observe --herdr-session main --workspace w1 --json
node dist/src/cli/shepherd.js observe-current --json
node dist/src/cli/shepherd.js snapshot ow_123 --json
node dist/src/cli/shepherd.js events ow_123 --after 10 --json
node dist/src/cli/shepherd.js notifications ow_123 --subscriber pi-session --auto-resume --json
node dist/src/cli/shepherd.js ack --subscription ns_123 --event 42 --json
node dist/src/cli/shepherd.js message-worker wk_123 "please continue"
node dist/src/cli/shepherd.js wait-worker wk_123 --state done --timeout-ms 600000
```

Use ids returned by `observe`, `snapshot`, and `notifications` for later commands.

## Packages

| Package | Purpose |
|---------|---------|
| [`packages/shepherd-pi`](packages/shepherd-pi) | Pi extension that sends redacted telemetry and receives worker notifications. |
| [`packages/shepherd-herdr-plugin`](packages/shepherd-herdr-plugin) | Herdr companion plugin with an observe action and dashboard pane. |

## Common commands

```bash
pnpm test                 # Run Vitest tests
pnpm check                # Run the full quality gate
pnpm build                # Emit dist and rewrite TS path aliases
pnpm db:generate          # Generate Drizzle migrations
pnpm pi-package:check     # Check the Pi extension package
pnpm herdr-plugin:check   # Check the Herdr plugin package
```

## License

[MIT](LICENSE)
