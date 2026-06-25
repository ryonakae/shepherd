# Shepherd Pi Runtime Gateway Plan

Date: 2026-06-25

## Status

Active. This plan supersedes the custom Shepherd TUI direction and makes Pi the required agent runtime and user-facing TUI.

## Progress

- **Done** — Product decision: Shepherd uses Pi as the canonical agent runtime and TUI instead of implementing a custom full-screen TUI.
- **Done** — Setup decision: users install Shepherd through Homebrew and the Pi bridge through `pi install npm:shepherd-pi`.
- **Done** — Runtime decision: `shepherd gateway start` requires Pi readiness and fails fast when Pi, the extension, or an authenticated Pi model is unavailable.
- **Done** — Session decision: one Shepherd session maps to one Pi session file; Pi session files are the canonical agent conversation state.
- **Done** — Streaming decision: Slack final-answer streaming follows Hermes' edit-in-place model; tool progress is off by default.
- **Done** — Implementation slice 1: config schema accepts `gateway.pi`, Gateway startup checks Pi readiness, sessions receive Pi metadata, queued runs lazy-start headless Pi, and Gateway RPC has the external run queue lifecycle for Pi extension claim/complete/fail.
- **Done** — Implementation slice 2+: dynamic Shepherd tools in `shepherd-pi`, Slack final-answer streaming, TUI takeover entrypoint, auto attach, owner priority, heartbeat, stale-owner recovery, and optional progress no-op handling are implemented.

## Next steps

All implementation slices are complete. Verification is covered by `pnpm check`, including Gateway RPC integration tests, Slack stream delivery unit tests, CLI tests, Gateway identity tests, and `shepherd-pi` package syntax/pack checks.

## Goal

Replace Shepherd's custom gateway LLM provider/TUI direction with a Pi-centered runtime.

Shepherd should run as a local Shepherd Gateway that connects Slack and future messaging platforms to Pi. Pi owns model/provider authentication, model selection, agent session state, `/resume`, `/tree`, compaction, and the interactive TUI. Shepherd owns platform delivery, session bindings, Herdr tool backends, run queueing, recovery, and Pi process supervision.

Target setup:

```bash
brew install shepherd
pi install npm:shepherd-pi
shepherd gateway start
```

After setup, a Slack message should wake a Shepherd session, start or reuse the matching Pi session, let the `shepherd-pi` extension drive the Pi turn, stream the response back to Slack, and keep the same Pi session resumable from Pi's normal `/resume` UI.

## Relationship to existing plans

This plan supersedes the archived custom TUI direction in [`2026-06-24-shepherd-tui-mvp-experience.md`](archived/2026-06-24-shepherd-tui-mvp-experience.md). The old plan remains historical context for event-stream UX and local session requirements, but Shepherd should no longer implement a full-screen TUI itself.

Archived Herdr orchestration plans still apply where they describe:

- Shepherd DB and Gateway as the platform/orchestration source of truth.
- Slack inbound/outbound delivery and access control.
- Herdr working context, workspace, tab, pane, and agent orchestration.
- Logical tool registry, policy gates, idempotency, and recovery.

This plan changes the gateway LLM/runtime and TUI implementation strategy:

- Pi session files are the canonical agent conversation state.
- Shepherd no longer owns LLM provider credentials or model selection.
- Shepherd no longer builds a custom Pi-like TUI.
- Shepherd's event DB becomes platform/orchestration log, not the agent conversation source of truth.

## Core decisions

### Product model

```text
Slack / future platforms
  -> Shepherd Gateway
       - platform adapters
       - session/event DB
       - Pi process supervisor
       - gateway run queue and recovery
       - Slack streaming delivery state
       - Herdr / Shepherd logical tool backend
  -> headless or interactive Pi
       - Pi model/provider/auth/session runtime
       - shepherd-pi extension
       - Shepherd tool registration and Gateway bridge
       - user-facing TUI when interactive
```

### Session identity

A Shepherd session and a Pi session file have a one-to-one relationship.

```text
Shepherd session = platform/orchestration identity
Pi session file  = canonical agent conversation identity
```

Shepherd stores Pi session metadata. Pi stores a Shepherd binding custom entry containing `sessionId`, `socketPath`, and `gatewayId`; this enables automatic attach when a user selects a Shepherd-created Pi session from Pi `/resume`.

### Conversation source of truth

Pi session files are the canonical agent conversation history. Shepherd DB still stores full `user.message` and `gateway.message` text in MVP, but only as platform/orchestration records for Slack retry, audit, dedupe, and recovery. Shepherd must not reconstruct normal Pi LLM context from its event log during normal operation.

### Runtime and configuration

Shepherd should remove Shepherd-owned LLM provider configuration from the new config shape:

```yaml
gateway:
  default_provider: ...
  model: ...
providers:
  ...
```

Pi owns provider authentication and model selection. Shepherd keeps Herdr agent profiles and adds Pi supervisor settings:

```yaml
gateway:
  pi:
    idle_timeout_ms: 600000
    readiness_timeout_ms: 10000
```

### Run ownership

Pi runtimes are session owners:

- `headless_pi`: Gateway-spawned Pi RPC process.
- `tui_pi`: user-facing Pi TUI process with `shepherd-pi` extension.

TUI Pi has priority. If a TUI owner disconnects while idle, headless Pi can resume. If it disconnects while running a claimed run, the run becomes `recovery_required`; Shepherd does not auto-replay it.

### Streaming

Slack final-answer streaming follows the Hermes pattern:

- Token deltas are transient and not persisted.
- The Gateway keeps in-memory stream state keyed by `gatewayRunId`.
- Slack receives a placeholder message, then throttled `chat.update` calls.
- Final assistant text is persisted as `gateway.message`.
- Slack tool progress defaults to `off` to avoid channel spam.

## Child plans

- [Setup, config, and Pi readiness](2026-06-25-pi-runtime-gateway/2026-06-25-setup-config-readiness.md) — **Done**
- [Gateway Pi supervisor and run queue](2026-06-25-pi-runtime-gateway/2026-06-25-gateway-pi-supervisor-run-queue.md) — **Done**
- [`shepherd-pi` extension](2026-06-25-pi-runtime-gateway/2026-06-25-shepherd-pi-extension.md) — **Done**
- [Slack streaming delivery](2026-06-25-pi-runtime-gateway/2026-06-25-slack-streaming-delivery.md) — **Done**
- [TUI takeover and auto attach](2026-06-25-pi-runtime-gateway/2026-06-25-tui-takeover-auto-attach.md) — **Done**
- [Implementation slices and verification](2026-06-25-pi-runtime-gateway/2026-06-25-implementation-slices-verification.md) — **Done**

## Deferred

- Dedicated `shepherd doctor` / `shepherd setup`.
- Preview-only Shepherd message storage.
- Pi entry id <-> Shepherd event id mapping.
- Multi-runtime support outside Pi.
- Slack native plan/task cards for tool progress.
- Cross-platform streaming beyond Slack.
- Rich local dashboard/TUI separate from Pi.
- Full migration tooling for old provider-based configs.

## Open implementation details

These are implementation details, not product blockers:

1. Exact Pi RPC event used for extension handshake in readiness mode.
2. Whether `gateway.start_run` is separate or folded into `claim_next_run`.
3. How `shepherd open` writes the initial Pi custom binding if the Pi session file has not been opened before.
4. Whether Gateway identity lives in a small file or DB metadata.
5. Exact TypeBox/JSON Schema compatibility layer for dynamic Pi tools.
