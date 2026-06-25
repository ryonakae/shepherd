# `shepherd-pi` Extension

Date: 2026-06-25

Parent: [Shepherd Pi Runtime Gateway Plan](../2026-06-25-pi-runtime-gateway.md)

## Status

Active child plan. Not started.

## Progress

- **Done** — Extension is the bridge between Pi and Shepherd daemon.
- **Done** — Message injection uses extension `pi.sendUserMessage()`, not daemon Pi RPC `prompt`.
- **Done** — Shepherd tools are registered by the extension from daemon `tool.list`.
- **Done** — Visible user text remains natural; Shepherd metadata is injected through hidden context hooks.
- **Not started** — npm package skeleton.
- **Not started** — daemon socket client and attach/claim loop.

## Next steps

1. Create the `shepherd-pi` package layout.
2. Implement daemon handshake and attach.
3. Implement run claim and final response reporting.
4. Add dynamic tool registration from `tool.list`.
5. Add context injection and TUI status commands.

## Package contents

The Pi package should include:

- Extension entry point.
- Skill describing Shepherd/Herdr orchestration usage.
- Prompt templates for attach/open/debug if useful.

Install command:

```bash
pi install npm:shepherd-pi
```

## Extension startup

On `session_start`:

1. Read Shepherd binding custom entry from the Pi session branch/history.
2. Resolve daemon socket path and daemon identity.
3. Connect to the daemon socket.
4. Call `pi.handshake`.
5. If binding is present and valid, auto-attach.
6. Subscribe to the Shepherd session event stream.
7. Register Shepherd tools from daemon `tool.list`.
8. Set Pi status/footer/widgets when in TUI mode.

## Attach commands

Provide Pi commands:

```text
/shepherd attach <session-id>
/shepherd detach
/shepherd status
```

`/shepherd attach <session-id>` calls `pi.attach`, writes the Pi custom binding entry, subscribes to events, and claims owner priority based on Pi mode.

## Tool registration

Use daemon `tool.list` as the source of truth.

For each tool:

- Register a Pi custom tool with the daemon-provided `name`, `description`, and `inputSchema`.
- Execute by calling daemon `tool.run` with the current Shepherd `sessionId`.
- Preserve daemon policy and idempotency behavior.

MVP can pass schemas through as JSON Schema-compatible TypeBox objects. If model/provider schema issues appear, normalize in the extension, not in the daemon.

The extension may override or add Pi-specific metadata:

- `promptSnippet`
- `promptGuidelines`
- TUI `renderCall` / `renderResult`

## Context injection

Visible user messages should remain natural.

Do not wrap Slack text like this:

```text
Shepherd session: ...
Slack thread: ...
User message: ...
```

Instead:

- `pi.sendUserMessage(userText)` for visible input.
- Use `before_agent_start` or `context` hook to inject Shepherd metadata:
  - Shepherd session id.
  - Slack binding/channel/thread.
  - working context.
  - Herdr agent profiles and `default_agent`.
  - current gateway run id.
  - recovery notes.
  - relevant recent Herdr progress if needed.

## Run claim loop

The extension should claim runs only after seeing `gateway.run.queued` or after attach startup.

Pseudo-flow:

```text
on session.event(gateway.run.queued):
  claim_next_run()

claim_next_run():
  if already running locally: return
  result = rpc.gateway.claim_next_run(ownerId, sessionId)
  if no run: return
  rpc.gateway.start_run(...)
  pi.sendUserMessage(run.userText)
```

The extension must avoid claiming replayed historical `gateway.run.queued` events directly. `claim_next_run` is the durable source of truth and must be idempotent.

## Assistant final capture

Use Pi message lifecycle hooks:

- `message_update` for streaming text delta.
- `tool_execution_start/end` for optional progress and segment breaks.
- `message_end` or `agent_end` for final assistant text.

On final assistant text:

1. Send `gateway.stream_finish` if streaming was active.
2. Call `gateway.complete_run` with final text.

On error/abort:

1. Call `gateway.fail_run` or request `recovery_required` depending on whether the owner disappeared mid-run.
2. Do not fabricate a successful `gateway.message`.

## TUI status behavior

In TUI mode, set concise status indicators:

- Attached Shepherd session id/title.
- Daemon connected/reconnecting state.
- Owner kind (`tui_pi`).
- Current run status if any.

TUI-specific UI should be guarded with `ctx.mode === "tui"`; headless/RPC mode must still work.

## Tests

- Extension handshake succeeds against a fake daemon.
- Binding custom entry is restored on `session_start`.
- `tool.list` registers tools and `tool.run` delegates calls.
- `gateway.run.queued` triggers claim but replay alone does not cause duplicate processing.
- Assistant final text calls `gateway.complete_run` once.
- Error path calls `gateway.fail_run`.
