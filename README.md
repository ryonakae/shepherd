# Shepherd

Shepherd orchestrates Herdr-managed coding agents from a shared TUI and messaging event stream.

<!-- README-I18N:START -->

**English** | [日本語](./README.ja.md)

<!-- README-I18N:END -->

## Features

- **Herdr-first orchestration:** Shepherd stores session state and controls Herdr sessions, workspaces, tabs, panes, and agents.
- **Shared session stream:** TUI and Slack clients read and write the same Shepherd session event log through platform adapters.
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

Create a local config file outside the repo, for example `/tmp/shepherd.local.yaml`. The Slack token fields name environment variables; do not paste token values into the YAML file.

```yaml
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

Shepherd requires `allowed_users` when you configure Slack. The daemon ignores messages outside `allowed_teams`, `allowed_channels`, or `allowed_users`, then logs the denied axis and Slack IDs at debug level. If you set `tui_default_channel`, include it in `allowed_channels`.

For Pi-backed gateway runs, omit `providers`, `gateway.default_provider`, and `gateway.model`. Those fields select the legacy provider runner instead of the Pi runtime.

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

Prompt for tokens in the shell that starts the daemon. This keeps token values out of shell history.

```bash
read -rsp 'SLACK_APP_TOKEN: ' SLACK_APP_TOKEN
export SLACK_APP_TOKEN
echo
read -rsp 'SLACK_BOT_TOKEN: ' SLACK_BOT_TOKEN
export SLACK_BOT_TOKEN
echo
```

### Pi package setup

Install the local Shepherd Pi package before starting the daemon with Pi runtime enabled:

```bash
pi install ./packages/shepherd-pi
pi list
```

Open Pi once and run `/login` if Pi has no available model. `shepherd daemon` starts `pi --mode rpc --no-session`, waits for the `shepherd-pi` extension handshake, and checks that Pi has at least one authenticated model.

## Usage

Run the test suite:

```bash
pnpm test
```

Apply committed SQLite migrations to a local database:

```bash
SHEPHERD_DB_PATH=/tmp/shepherd.sqlite pnpm db:migrate
```

Build TypeScript into `dist`:

```bash
pnpm build
```

Start the daemon with the local config:

```bash
export SHEPHERD_DB_PATH=/tmp/shepherd.sqlite
export SHEPHERD_SOCKET_PATH=/tmp/shepherd.sock

node dist/src/cli/shepherd.js daemon \
  --db "$SHEPHERD_DB_PATH" \
  --socket "$SHEPHERD_SOCKET_PATH" \
  --config /tmp/shepherd.local.yaml
```

Create a local session for TUI verification:

```bash
export SHEPHERD_SESSION_ID="$(
  node --input-type=module <<'JS'
import { ShepherdSessionClient } from "./dist/src/tui/client.js";

const socketPath = process.env.SHEPHERD_SOCKET_PATH ?? "/tmp/shepherd.sock";
const client = await ShepherdSessionClient.connect(socketPath);
try {
  const { session } = await client.createSession({ title: "Local verification" });
  console.log(session.id);
} finally {
  await client.close();
}
JS
)"
```

Open an attached Pi TUI for the session:

```bash
node dist/src/cli/shepherd.js open \
  --session "$SHEPHERD_SESSION_ID" \
  --db "$SHEPHERD_DB_PATH" \
  --socket "$SHEPHERD_SOCKET_PATH"
```

Send a message to a running daemon session:

```bash
node dist/src/cli/shepherd.js send \
  --session "$SHEPHERD_SESSION_ID" \
  --socket "$SHEPHERD_SOCKET_PATH" \
  --text "continue from here"
```

Send a message with a one-turn gateway provider override when legacy providers are configured:

```bash
node dist/src/cli/shepherd.js send \
  --session "$SHEPHERD_SESSION_ID" \
  --socket "$SHEPHERD_SOCKET_PATH" \
  --text "try this with OpenAI" \
  --provider openai \
  --model gpt-4.1
```

Watch session events as JSON Lines:

```bash
node dist/src/cli/shepherd.js watch \
  --session "$SHEPHERD_SESSION_ID" \
  --socket "$SHEPHERD_SOCKET_PATH" \
  --after 0
```

Bridge logical tools over stdio JSON Lines:

```bash
node dist/src/cli/shepherd-tools.js --socket /tmp/shepherd.sock
```

Rename a session:

```bash
node dist/src/cli/shepherd.js rename \
  --session "$SHEPHERD_SESSION_ID" \
  --socket "$SHEPHERD_SOCKET_PATH" \
  --title "Review Slack sync"
```

Print stored session audit events from SQLite:

```bash
node dist/src/cli/shepherd.js audit \
  --session "$SHEPHERD_SESSION_ID" \
  --db /tmp/shepherd.sqlite \
  --after 0
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
- `src/daemon`: local daemon utilities, including JSON Lines framing and recovery.
- `src/db`: SQLite connection, migration application, and Drizzle schema.
- `src/delivery`: platform delivery routing, fanout, receipts, and duplicate-send prevention.
- `src/gateway`: provider adapters, logical tools, turn queueing, context, and summary updates.
- `src/gateway/working-contexts.ts`: allowed-root working context discovery and resolution.
- `src/platforms/slack`: Slack inbound normalization, Socket Mode wrapper, and outbound delivery.
- `src/tui`: daemon socket client used by TUI-style local surfaces.
- `test/unit`: pure logic and contract tests.
- `test/integration`: SQLite and cross-module integration tests.
- `docs/plans`: active product and implementation plans; completed plans live under `docs/plans/archived`.

## Notes

TypeScript source supports `@/*` imports for files under `src`. The build uses `tsc-alias` so emitted JavaScript can run from `dist`.

`pnpm-workspace.yaml` exists only for pnpm 11 build-script approvals. Shepherd remains a single-package project for the MVP.

## License

[MIT](LICENSE)
