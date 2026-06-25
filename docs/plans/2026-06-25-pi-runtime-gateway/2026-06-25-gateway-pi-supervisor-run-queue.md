# Daemon Pi Supervisor and Run Queue

Date: 2026-06-25

Parent: [Shepherd Pi Runtime Gateway Plan](../2026-06-25-pi-runtime-gateway.md)

## Status

Done.

## Progress

- **Done** — Headless Pi should run as `pi --mode rpc --session <piSessionFile>` subprocesses.
- **Done** — One Shepherd session maps to one Pi session file.
- **Done** — Existing `gateway_runs` remains the durable queue/recovery table.
- **Done** — `gateway.run.queued` is a persistent event.
- **Done** — Pi session metadata assignment, lazy headless Pi subprocess startup, `pi.attach`, `pi.heartbeat`, and TUI-over-headless claim priority are implemented.
- **Done** — external worker claim/start/complete/fail RPC exists for the final-only Pi extension path; stale owner recovery marks running runs `recovery_required`.

## Next steps

Complete. Supervisor, claim lifecycle, owner priority, heartbeat, and recovery behavior are covered by unit/integration tests.

## Pi supervisor

The daemon owns a Pi runtime supervisor.

Responsibilities:

- Maintain one lazy headless Pi RPC subprocess per active Shepherd session.
- Start subprocesses with the session's `piSessionFile`.
- Stop idle subprocesses after `gateway.pi.idle_timeout_ms`.
- Track extension handshakes.
- Track owner priority between headless Pi and interactive TUI Pi.
- Mark running gateway runs as `recovery_required` on daemon restart or owner loss.

Headless launch shape:

```bash
pi --mode rpc --session <piSessionFile>
```

The `shepherd-pi` extension is expected to be installed in the user's Pi environment. The daemon does not pass `-e` in normal operation.

## Owner model

Owner kinds:

- `headless_pi`: daemon-spawned Pi RPC process.
- `tui_pi`: user-facing Pi TUI process with `shepherd-pi` extension.

Priority:

1. `tui_pi`
2. `headless_pi`

If a TUI Pi is attached and healthy, it claims runs before headless Pi. Headless Pi must pause claim attempts for that session while a TUI owner is active.

A TUI owner must heartbeat. If it disconnects while idle, ownership falls back to headless Pi after timeout. If it disconnects while running a claimed run, that run becomes `recovery_required`; Shepherd does not auto-replay it.

## Gateway run queue

Keep using `gateway_runs` as the durable run queue and recovery table.

Run lifecycle:

```text
Slack user.message
  -> events.user.message
  -> gateway_runs queued
  -> events.gateway.run.queued
  -> Pi owner receives subscription event
  -> Pi owner calls gateway.claim_next_run
  -> gateway_runs running
  -> events.gateway.run.started
  -> Pi extension calls pi.sendUserMessage()
  -> transient stream delivery while assistant responds
  -> final events.gateway.message
  -> gateway_runs completed
  -> events.gateway.run.completed
```

Failure path:

```text
Pi owner fails run
  -> events.gateway.run.failed
  -> gateway_runs failed
```

Owner loss during running:

```text
Pi owner disconnects mid-run
  -> gateway_runs recovery_required
  -> events.recovery.note
```

## Event stream additions

### `gateway.run.queued`

Payload:

```json
{
  "gatewayRunId": "...",
  "triggeringEventId": 123,
  "piSessionFile": "/.../session.jsonl",
  "piSessionId": "..."
}
```

This event is not delivered to Slack. It is visible to Pi extension, audit, and future local UI surfaces.

## RPC additions

### `pi.handshake`

Called by `shepherd-pi` on `session_start`.

Input:

```json
{
  "extensionVersion": "0.1.0",
  "mode": "tui" | "rpc" | "json" | "print",
  "piSessionFile": "/.../session.jsonl",
  "piSessionId": "...",
  "binding": {
    "sessionId": "...",
    "socketPath": "...",
    "daemonId": "..."
  }
}
```

Output:

```json
{
  "daemonId": "...",
  "attached": true,
  "sessionId": "...",
  "ownerId": "...",
  "ownerKind": "tui_pi" | "headless_pi"
}
```

### `pi.attach`

Attach a Pi session to a Shepherd session and create/update the Pi binding entry.

Input:

```json
{
  "sessionId": "...",
  "piSessionFile": "/.../session.jsonl",
  "piSessionId": "...",
  "mode": "tui" | "rpc",
  "force": false
}
```

Output includes `daemonId`, `socketPath`, `ownerId`, and the Shepherd session record.

### `pi.heartbeat`

Input:

```json
{
  "ownerId": "...",
  "sessionId": "..."
}
```

Used for TUI owner liveness and headless owner monitoring.

### `gateway.claim_next_run`

Input:

```json
{
  "ownerId": "...",
  "sessionId": "..."
}
```

Output:

```json
{
  "run": {
    "id": "...",
    "triggeringEventId": 123,
    "userText": "...",
    "actorId": "...",
    "presentation": {}
  }
}
```

Return `null` when no claimable run exists or when a higher-priority owner owns the session.

### `gateway.start_run`

Records `gateway.run.started` and marks the claimed run as running if not already done by claim. This can be folded into claim if implementation stays simpler, but the event must be emitted before Pi starts the LLM turn.

### `gateway.complete_run`

Input:

```json
{
  "ownerId": "...",
  "gatewayRunId": "...",
  "text": "final assistant text",
  "piSessionFile": "...",
  "piSessionId": "..."
}
```

Effects:

- Append `gateway.message` with final text.
- Mark run completed.
- Append `gateway.run.completed`.
- Deliver final message if streaming did not already deliver final content.

### `gateway.fail_run`

Input:

```json
{
  "ownerId": "...",
  "gatewayRunId": "...",
  "message": "..."
}
```

Effects:

- Append `gateway.run.failed`.
- Mark run failed.
- Notify platform with a concise error when appropriate.

## Data model notes

### Session metadata

Start by storing Pi binding in `sessions.metadata_json`:

```ts
type SessionMetadata = {
  slackAutoBind?: ...;
  pi?: {
    sessionFile: string;
    sessionId: string;
    createdAt: string;
    updatedAt: string;
  };
};
```

A dedicated table can be added later if querying by Pi session becomes common.

### Daemon identity

Store a stable daemon identity in Shepherd home/state. Options:

- A small file under `SHEPHERD_HOME`, for example `daemon-id`.
- A DB metadata table if one is added.

The identity is written into Pi session binding entries and checked during auto-attach.

### Delivery receipts

Keep `delivery_receipts` event-id based for persisted events. Streaming placeholders are not delivery receipts in MVP.

## Tests

- Queued run creation emits `gateway.run.queued`.
- Claim is atomic and idempotent.
- TUI owner priority beats headless owner.
- Owner disconnect while running marks `recovery_required`.
- Daemon restart marks queued/running runs conservatively.
