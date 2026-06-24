# Shepherd

Shepherd orchestrates Herdr-managed coding agents from a shared TUI and messaging event stream.

## Features

- **Herdr-first orchestration:** Shepherd stores session state, then controls Herdr sessions, workspaces, tabs, panes, and agents.
- **Shared session stream:** TUI and Slack read and write the same Shepherd session event log through platform adapters.
- **Typed foundation:** The MVP starts with TypeScript, Vitest, Biome, SQLite migrations, Drizzle schema generation, and TypeBox/Ajv runtime schemas.

## Getting Started

```bash
mise trust
mise install
pnpm install
pnpm check
```

## Requirements

- Node.js 24.18.0 or newer
- pnpm 11.9.0 or newer
- `mise` for local tool version management

## Usage

Run the test suite:

```bash
pnpm test
```

Apply committed SQLite migrations to a local database:

```bash
SHEPHERD_DB_PATH=/tmp/shepherd.sqlite pnpm db:migrate
```

Slack Socket Mode config references environment variable names, not literal tokens:

```yaml
platforms:
  slack:
    app_token_env: SLACK_APP_TOKEN
    bot_token_env: SLACK_BOT_TOKEN
    allow_customize: true
```

Build TypeScript into `dist`:

```bash
pnpm build
```

Send a message to a running daemon session:

```bash
shepherd send --session <session-id> --text "continue from here"
```

Watch session events as JSON Lines:

```bash
shepherd watch --session <session-id> --after 0
```

Rename a session:

```bash
shepherd rename --session <session-id> --title "Review Slack sync"
```

## Common Commands

- `pnpm typecheck`: run strict TypeScript checks without emitting files.
- `pnpm test`: run Vitest unit and integration tests.
- `pnpm lint`: run Biome linting and import organization checks.
- `pnpm format:check`: check Biome formatting.
- `pnpm db:generate`: generate Drizzle SQL migrations from `src/db/schema.ts`.
- `pnpm db:check`: verify generated Drizzle migrations are consistent.
- `pnpm check`: run the full local quality gate.

## Project Layout

- `src/config`: TypeBox/Ajv runtime configuration contracts.
- `src/daemon`: local daemon utilities, including JSON Lines framing.
- `src/db`: SQLite connection, migration application, and Drizzle schema.
- `src/delivery`: platform delivery routing, fanout, receipts, and duplicate-send prevention.
- `src/gateway`: provider adapters, logical tools, turn queueing, context, and summary updates.
- `src/gateway/working-contexts.ts`: allowed-root working context discovery and resolution.
- `src/platforms/slack`: Slack inbound normalization, Socket Mode wrapper, and outbound delivery.
- `src/tui`: daemon socket client used by TUI-style local surfaces.
- `test/unit`: pure logic and contract tests.
- `test/integration`: SQLite and cross-module integration tests.
- `docs/plans`: product and implementation plans for the Shepherd MVP.

## Notes

TypeScript source supports `@/*` imports for files under `src`. The build uses `tsc-alias` so emitted JavaScript can run from `dist`.

`pnpm-workspace.yaml` is present only for pnpm 11 build-script approvals. Shepherd is still a single-package project for the MVP.

## License

[MIT](LICENSE)
