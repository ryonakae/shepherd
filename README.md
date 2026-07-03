# Shepherd

Shepherd is a Herdr worker observability and orchestration layer. It watches Herdr-managed coding agents, stores worker-level state, and pushes useful signals back to orchestrator runtimes such as Pi.

Shepherd is not an LLM gateway and is not a thin Herdr wrapper. Herdr owns low-level workspace, tab, pane, and agent control. Shepherd adds value above that layer:

- structured worker snapshots
- enriched `worker.*` events
- orchestrator push notifications

## Quick start

```bash
mise trust
mise install
pnpm install
pnpm check
pnpm build

shepherd daemon start
pi install ./packages/shepherd-pi
herdr plugin link ./packages/shepherd-herdr-plugin
```

## Requirements

- Node.js 24.18.0 or newer
- pnpm 11.9.0 or newer
- Herdr 0.7.0 or newer
- Pi, when using the Pi runtime extension

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

Retention settings are not active in the MVP. Shepherd stores sanitized worker events and snapshots indefinitely.

## CLI examples

Observe a Herdr workspace by session name:

```bash
shepherd observe --herdr-session main --workspace w1 --json
```

Observe the current Herdr-managed pane/workspace:

```bash
shepherd observe-current --json
```

Read worker snapshots:

```bash
shepherd snapshot ow_123 --json
```

Read worker events after a cursor:

```bash
shepherd events ow_123 --after 10 --json
```

Subscribe for notifications and acknowledge delivery:

```bash
shepherd notifications ow_123 --subscriber pi-session --auto-resume --json
shepherd ack --subscription ns_123 --event 42 --json
```

Send a semantic worker message or wait for worker state:

```bash
shepherd message-worker wk_123 "please continue"
shepherd wait-worker wk_123 --state done --timeout-ms 600000
```

## Pi extension

`packages/shepherd-pi` observes the current Herdr workspace when Pi runs inside Herdr, sends bounded runtime telemetry to Shepherd, receives worker notifications, and injects hidden context on the next Pi turn.

```bash
pi install ./packages/shepherd-pi
```

The extension sends excerpts, `sessionRef`, and `artifactRefs`. It does not send hidden thinking or full tool results.

## Herdr plugin

`packages/shepherd-herdr-plugin` is a companion plugin. It provides an observe action and dashboard pane, but it is not Shepherd's primary event stream.

```bash
herdr plugin link ./packages/shepherd-herdr-plugin
herdr plugin action invoke observe-workspace --plugin shepherd.observability
herdr plugin pane open --plugin shepherd.observability --entrypoint dashboard
```

## Development commands

- `pnpm typecheck`: run TypeScript checks.
- `pnpm test`: run Vitest unit and integration tests.
- `pnpm lint`: run Biome checks.
- `pnpm format:check`: check Biome formatting.
- `pnpm db:generate`: generate Drizzle migrations from `src/db/schema.ts`.
- `pnpm db:check`: verify Drizzle migrations match schema.
- `pnpm pi-package:check`: typecheck and dry-pack the Pi extension.
- `pnpm herdr-plugin:check`: typecheck and dry-pack the Herdr plugin.
- `pnpm check`: run the full quality gate.
- `pnpm build`: emit `dist` and rewrite TS path aliases.

## Project layout

- `src/observability`: worker contracts, telemetry normalization, rules, notification service, and `WorkerStatePipeline`.
- `src/daemon`: JSON Lines RPC server/client and daemon service.
- `src/db`: SQLite connection, migrations, Drizzle schema, and observability stores.
- `src/herdr`: Herdr socket clients, session snapshots, and workspace resolution helpers.
- `src/cli`: `shepherd` CLI.
- `packages/shepherd-pi`: Pi extension package.
- `packages/shepherd-herdr-plugin`: Herdr companion plugin package.
- `test/unit`: pure logic and contract tests.
- `test/integration`: SQLite and JSONL integration tests.
- `docs/plans`: active implementation plans; completed plans live under `docs/plans/archived`.

## License

[MIT](LICENSE)
