# Changelog

All notable changes to Shepherd are documented in this file.

## v0.6.0

_2026-08-28_

### Added

- Added contextual help for `agent`, `daemon`, every agent subcommand, and every daemon action through `--help` and `-h`.
- Added `shepherd --version` and `shepherd -v`, with the version read from installed package metadata.
- Added usage-error guidance that points to the relevant help command.
- Added an automated release pipeline with synchronized versions, immutable tag validation, npm Trusted Publishing with provenance, tarball integrity checks, and isolated registry installation tests.

### Removed

- **Breaking:** Removed `shepherd help`. Use `shepherd --help` or `shepherd -h` instead.

## v0.5.0

_2026-07-22_

### Added

- Added event-time agent names to status and outcome events.

### Changed

- Stored Herdr live agent names separately from runtime kinds while preserving terminal-based identity and history across renames.
- Resolved agent targets by exact pane, terminal, or Shepherd ID, then live name, then unique runtime kind.
- Displayed identities such as `reviewer · Codex` in Pi and separate `name` and `agent` fields in the CLI and Herdr plugin.

### Removed

- Removed unused Herdr control and managed-session code. Shepherd remains a read-only, daemon-backed history and notification layer compatible with Herdr 0.7.0 or later.

## v0.4.0

_2026-07-16_

### Added

- Added daemon-owned persistent agent context snapshots for fast cross-agent context without Shepherd RPC or history I/O on Pi's prompt path.
- Added owner-only cached context injection with run pinning, reconnect recovery, and wake isolation.
- Added preferred history references, pane revisions, dirty refresh, adaptive polling, and recovery across daemon restarts and pane movement.
- Added SQLite migration `0003_opposite_tarantula.sql` for context snapshots and separate agent session hints.

### Changed

- Changed `shepherd agent list` to read only cached context while `agent get` and `agent read` continue to perform explicit live reads.

### Removed

- Removed per-turn Pi telemetry. Exact Pi session registration now supplies presence identity.

## v0.3.1

_2026-07-15_

### Added

- Published the Shepherd CLI and daemon as `@ryonakae/shepherd` and the Pi extension as `@ryonakae/shepherd-pi`.
- Added clean builds and package-content validation so removed modules cannot remain in `dist`.
- Documented npm installation, GitHub-based Herdr plugin installation, and the release procedure.

### Changed

- Restricted the root npm package to compiled runtime files and Drizzle migrations.
- Removed npm consumer lifecycle scripts while retaining local Husky setup through pnpm.

## v0.3.0

_2026-07-15_

### Added

- Added owner-scoped Pi wake delivery for completed and blocked agent outcomes, including coalescing, busy-turn deferral, ordered acknowledgement, and at-least-once retry safety.
- Added themed Shepherd agent-update cards with collapsed and expanded outcome views, bounded response excerpts, and legacy-session rendering.
- Added a single Pi footer for pending-update and reconnect states.
- Improved daemon and Herdr lifecycle stability through reconnect scope refresh, session reconciliation, sandboxed process detection, and migration lookup outside the repository directory.

### Changed

- Simplified the Pi command surface to `/shepherd [on|off|status]` with local ownership, owner transfer notifications, and reconnect handling.
- Standardized Shepherd-owned code, tests, and documentation on agent terminology.

### Removed

- **Breaking:** Removed the legacy `/shepherd orchestrator ...` command path. Use `/shepherd`, `/shepherd on`, `/shepherd off`, or `/shepherd status`.
- **Breaking:** Renamed Shepherd-owned wake projection types and terminology from subordinate-role names to agent names.

## v0.2.0

_2026-07-13_

### Added

- Added structured session readers for Claude Code, Codex, Gemini CLI, OpenCode, and Pi, including compact tool results.
- Added scoped `agent list`, `agent get`, and `agent read` workflows that exclude agents retained from stopped Herdr sessions.
- Added Pi orchestrator ownership and notification routing that follows Herdr terminal movement and reconnect grace periods.
- Added a Shepherd Agent Skill for structured agent inspection.

### Changed

- Reworked Shepherd around structured history for coding agents in running Herdr sessions.
- Focused `shepherd-pi` on runtime context injection, notifications, and orchestrator commands.

### Removed

- **Breaking:** Removed the legacy worker-observability surface in favor of agent history and agent events.
- **Breaking:** Removed the bundled `shepherd` Agent Skill from `shepherd-pi`; the repository root `SKILL.md` became the single source of truth.

## v0.1.0

_2026-07-07_

### Added

- Added durable worker records that map Herdr workspaces, panes, and runtime telemetry into SQLite state.
- Added readable worker snapshots and `worker.*` events for completion, blocked work, input requests, tool failures, summary updates, and status changes.
- Added unread worker notifications for CLI subscribers and the Pi extension.
- Added a Pi telemetry bridge and a Herdr plugin with a `context` action and worker dashboard.
- Added `shepherd context --json` for agents to read current workspace context and notifications.
