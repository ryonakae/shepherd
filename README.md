# Shepherd

Shepherd is a Pi-coordinated gateway for operating Herdr-managed coding agents from a shared TUI and messaging event stream.

<!-- README-I18N:START -->

**English** | [日本語](./README.ja.md)

<!-- README-I18N:END -->

## Features

- **Clear runtime split:** Pi owns model/provider/session conversation state, Herdr owns terminal execution surfaces, and Shepherd Gateway owns sessions, delivery, Pi turn queueing, policy, bindings, and audit events.
- **Shared session stream:** TUI and Slack clients read and write the same Shepherd session event log through platform adapters.
- **Herdr worker orchestration:** Shepherd manages Herdr workspaces, panes, and worker-agent bindings through `shepherd_*` logical tools.
- **Typed foundation:** TypeScript, Vitest, Biome, SQLite migrations, Drizzle schema generation, and TypeBox/Ajv schemas support the MVP.

## Contents

- [Getting Started](#getting-started)
- [Requirements](#requirements)
- [Configuration](#configuration)
- [Usage](#usage)
- [Common Commands](#common-commands)
- [Project Layout](#project-layout)

## Getting Started

```bash
mise trust
mise install
pnpm install
pnpm check
pnpm build
```

## Requirements

- Node.js 24.18.0 or newer
- pnpm 11.9.0 or newer
- `mise` for local tool version management

## Configuration

Shepherd reads `$SHEPHERD_HOME/config.yaml`. If `SHEPHERD_HOME` is unset, Shepherd uses `~/.shepherd` on all platforms. Shepherd also reads `$SHEPHERD_HOME/.env`; values in that file override shell values for non-`SHEPHERD_*` variables.

The `runtime:` section is optional. Relative paths are resolved from `$SHEPHERD_HOME`. During development, the SQLite schema is reset destructively when migrations change; remove old `$SHEPHERD_HOME/state.db` files if an old local database blocks startup.

```yaml
runtime:
  db_path: state.db
  socket_path: gateway.sock
  pid_path: gateway.pid
  log_path: logs/gateway.log

gateway:
  pi:
    idle_timeout_ms: 600000
    readiness_timeout_ms: 10000

default_agent: implementer
agents:
  implementer:
    command: codex
    args: []
    when: "Use for implementation, test fixes, and CLI-heavy coding work."

context:
  allowed_roots:
    - /Users/ryo.nakae/Dev/private/shepherd

platforms:
  slack:
    app_token_env: SLACK_APP_TOKEN
    bot_token_env: SLACK_BOT_TOKEN
    allow_customize: false
    allowed_teams:
      - T0123456789
    allowed_channels:
      - C0123456789
    allowed_users:
      - U0123456789
    tui_default_channel: C0123456789
    streaming:
      enabled: true
      edit_interval_ms: 750
      buffer_threshold_chars: 40
      cursor: " ▉"
      tool_progress: off
```

Shepherd no longer has provider/model config. Configure provider auth and model selection in Pi itself.

Shepherd requires `allowed_users` when you configure Slack. The Gateway ignores messages outside `allowed_teams`, `allowed_channels`, or `allowed_users`, then logs the denied axis and Slack IDs at debug level. If you set `tui_default_channel`, include it in `allowed_channels`.

### Slack app setup

Create or update a Slack app for the workspace, then install it to the workspace.

1. Enable Socket Mode.
2. Create an app-level token with `connections:write`; Slack app-level token values start with `xapp-`.
3. Add a bot token with the scopes Shepherd needs:
   - `chat:write`
   - `channels:history` for public channels
   - `groups:history` for private channels
   - `im:history` for direct messages
   - `mpim:history` for group direct messages
   - `chat:write.customize` only when `allow_customize: true`
4. Subscribe to bot events for the Slack surfaces you want to use:
   - `message.channels`
   - `message.groups`
   - `message.im`
   - `message.mpim`
5. Invite the bot to every channel listed in `allowed_channels`.
6. Put Slack IDs, not display names, in the YAML file. Use team IDs like `T0123456789`, channel IDs like `C0123456789`, and user IDs like `U0123456789`.

Put tokens in `$SHEPHERD_HOME/.env` so token values stay out of the YAML file and shell history.

```bash
mkdir -p "${SHEPHERD_HOME:-$HOME/.shepherd}"
cat > "${SHEPHERD_HOME:-$HOME/.shepherd}/.env" <<'EOF'
SLACK_APP_TOKEN=xapp-...
SLACK_BOT_TOKEN=xoxb-...
EOF
```

### Pi package setup

Install the local Shepherd Pi package before starting the Gateway:

```bash
pi install ./packages/shepherd-pi
pi list
```

Open Pi once and run `/login` if Pi has no available model. `shepherd gateway start` starts `pi --mode rpc --no-session`, waits for the `shepherd-pi` extension handshake, and checks that Pi has at least one authenticated model.

## Usage

Run the test suite:

```bash
pnpm test
```

Apply committed SQLite migrations to the configured database:

```bash
pnpm db:migrate
```

Build TypeScript into `dist`:

```bash
pnpm build
```

Start the Gateway:

```bash
node dist/src/cli/shepherd.js gateway start
```

Start a new local Shepherd session from the current directory and open Pi:

```bash
node dist/src/cli/shepherd.js
```

The Gateway must already be running. `shepherd` does not auto-start it. The current working directory becomes the Shepherd working context exactly as invoked.

Open an existing Shepherd session, for example one created from Slack:

```bash
node dist/src/cli/shepherd.js open "$SHEPHERD_SESSION_ID"
```

Send a message to a running Gateway session:

```bash
node dist/src/cli/shepherd.js send "$SHEPHERD_SESSION_ID" "continue from here"
```

Watch session events as JSON Lines:

```bash
node dist/src/cli/shepherd.js watch "$SHEPHERD_SESSION_ID"
```

Bridge logical tools over stdio JSON Lines:

```bash
node dist/src/cli/shepherd-tools.js
```

Rename a session:

```bash
node dist/src/cli/shepherd.js rename "$SHEPHERD_SESSION_ID" "Review Slack sync"
```

Print stored session audit events from SQLite:

```bash
node dist/src/cli/shepherd.js audit "$SHEPHERD_SESSION_ID"
```

## Common Commands

- `pnpm typecheck`: run strict TypeScript checks without emitting files.
- `pnpm test`: run Vitest unit and integration tests.
- `pnpm lint`: run Biome linting and import organization checks.
- `pnpm format:check`: check Biome formatting.
- `pnpm db:generate`: generate Drizzle SQL migrations from `src/db/schema.ts`.
- `pnpm db:check`: verify generated Drizzle migrations match the schema.
- `pnpm check`: run the full local quality gate.

## Project Layout

- `src/config`: TypeBox/Ajv runtime configuration contracts.
- `src/cli`: command-line entrypoints for `shepherd` and `shepherd-tools`.
- `src/gateway`: local Gateway server, JSON Lines framing, Pi turn queueing, logical tools, recovery, context, and working-context helpers.
- `src/db`: SQLite connection, migration application, Drizzle schema, Pi turns, worker bindings, session bindings, and summaries.
- `src/delivery`: platform delivery routing, fanout, receipts, and duplicate-send prevention.
- `src/herdr`: Herdr socket clients, orchestration, workspace bindings, and progress subscriptions.
- `src/platforms/slack`: Slack inbound normalization, Socket Mode wrapper, and outbound delivery.
- `src/tui`: Gateway socket client used by TUI-style local surfaces.
- `packages/shepherd-pi`: Pi extension package that mirrors Pi turns and registers dynamic `shepherd_*` tools.
- `test/unit`: pure logic and contract tests.
- `test/integration`: SQLite and cross-module integration tests.
- `docs/plans`: active product and implementation plans; completed plans live under `docs/plans/archived`.

## Notes

TypeScript source supports `@/*` imports for files under `src`. The build uses `tsc-alias` so emitted JavaScript can run from `dist`.

`pnpm-workspace.yaml` exists only for pnpm 11 build-script approvals. Shepherd remains a single-package project for the MVP.

## License

[MIT](LICENSE)
