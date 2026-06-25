# TUI Takeover and Auto Attach

Date: 2026-06-25

Parent: [Shepherd Pi Runtime Gateway Plan](../2026-06-25-pi-runtime-gateway.md)

## Status

Done.

## Progress

- **Done** — TUI Pi should take owner priority over headless Pi.
- **Done** — Pi `/resume` should auto-attach for Shepherd-created Pi sessions.
- **Done** — Running TUI owner disconnect marks the run `recovery_required`.
- **Done** — `shepherd open --session` parses CLI options, ensures Shepherd Pi session metadata, and launches `pi --session <pi-session-file>` with Shepherd attach environment.
- **Done** — binding custom entry creation and extension auto-attach exist through `/shepherd attach`, env fallback, and `pi.appendEntry`; stable daemon id persistence and mismatch prevention are implemented.
- **Done** — heartbeat, owner priority, stale-owner fallback, and running-run recovery are implemented.

## Next steps

Complete. CLI open behavior, daemon id mismatch prevention, owner priority, heartbeat, and stale-owner recovery are covered by tests. Manual Pi `/resume` smoke requires an interactive Pi TUI and is not run in repository check.

## UX

Support both entry points:

```bash
shepherd open --session <shepherd-session-id>
```

and inside Pi:

```text
/shepherd attach <session-id>
```

Additionally, when a user selects a Shepherd-created Pi session from Pi `/resume`, the extension should auto-attach based on the stored Shepherd binding.

## Pi session binding

Pi session side binding shape:

```json
{
  "sessionId": "shepherd-session-id",
  "socketPath": "/Users/.../.shepherd/daemon.sock",
  "daemonId": "stable-daemon-id"
}
```

Store it with:

```ts
pi.appendEntry("shepherd.binding", binding)
```

On `session_start`, the extension reads matching custom entries from the current Pi session and auto-attaches only when:

- `daemonId` matches the current daemon.
- `socketPath` is reachable.
- The Shepherd session still exists.

If the socket path changed or daemon id differs, the extension should not silently attach. The user can run `/shepherd attach <session-id>` to update binding.

## `shepherd open`

Flow:

1. Connect to daemon.
2. Resolve Shepherd session.
3. Ensure the session has a Pi session file; create it if missing.
4. Ensure Pi session has Shepherd binding custom entry. This may require launching Pi with an initial attach command or relying on extension attach flow.
5. Execute:
   ```bash
   pi --session <pi-session-file>
   ```
6. `shepherd-pi` auto-attaches on Pi `session_start`.

Future convenience:

- `shepherd open` without `--session` could list/recent-select, but not needed for the first vertical slice.

## Owner priority

When `ctx.mode === "tui"`, the extension owner kind is `tui_pi` and has priority over `headless_pi` for the same Shepherd session.

Expected behavior:

- User opens Pi session via `shepherd open --session <id>` or Pi `/resume`.
- Extension auto-attaches from binding.
- Daemon stops letting headless owner claim new runs for that session.
- Slack messages arrive in the interactive Pi session via `pi.sendUserMessage()`.
- If TUI Pi disconnects while idle, headless owner resumes after heartbeat timeout.
- If TUI Pi disconnects while running, the run becomes `recovery_required`.

## Heartbeat

TUI owners must heartbeat through `pi.heartbeat`.

Heartbeat timeout behavior:

- Idle owner missed timeout: release owner; headless may claim future runs.
- Running owner missed timeout: mark current run `recovery_required`, emit `recovery.note`, release owner.

Headless owners may also heartbeat for monitoring, but daemon can also observe the child process directly.

## Tests

- `shepherd open --session` resolves session and launches Pi with the right session file.
- Pi binding entry is read on `session_start` and calls `pi.attach`.
- Daemon id mismatch prevents auto attach.
- TUI owner beats headless owner in `gateway.claim_next_run`.
- Idle TUI disconnect falls back to headless.
- Running TUI disconnect marks run `recovery_required` and does not auto-replay.
