# Implementation Slices and Verification

Date: 2026-06-25

Parent: [Shepherd Pi Runtime Gateway Plan](../2026-06-25-pi-runtime-gateway.md)

## Status

Active child plan. Not started.

## Progress

- **Done** — Implementation should start with a vertical final-only path.
- **Done** — Streaming and TUI takeover are in MVP but come after the final-only path.
- **Not started** — Slice 1 implementation.
- **Not started** — Test harnesses for fake Pi and fake Slack.

## Next steps

1. Build slice 1 until Slack final reply works through headless Pi.
2. Add dynamic tools.
3. Add Slack streaming.
4. Add TUI takeover.
5. Add optional tool progress.

## Slice 1: final-only vertical path

Goal:

```text
Slack -> Shepherd daemon -> headless Pi + shepherd-pi -> final response -> Slack
```

No streaming, no TUI takeover, no tool progress.

Steps:

1. Config schema
   - Remove provider requirements from new config shape.
   - Add `gateway.pi`.
   - Keep `agents`, `default_agent`, `context`, `platforms.slack`.
   - Add migration/test fixtures for the new config shape.

2. Pi readiness
   - Add startup check in `shepherd daemon`.
   - Launch `pi --mode rpc --no-session`.
   - Require extension handshake.
   - Call `get_available_models`.
   - Fail daemon startup with actionable errors.

3. Minimal `shepherd-pi` extension package
   - Handshake.
   - Daemon attach.
   - `gateway.run.queued` subscription and claim.
   - `pi.sendUserMessage()`.
   - Assistant final -> `gateway.complete_run`.

4. Session Pi metadata
   - Create or assign Pi session file for new Slack-created Shepherd sessions.
   - Store `metadata.pi.sessionFile` and `metadata.pi.sessionId`.

5. External run queue RPC
   - Add `gateway.run.queued` event.
   - Add `gateway.claim_next_run`, `gateway.start_run`, `gateway.complete_run`, `gateway.fail_run`.
   - Keep one running run per Shepherd session.

6. Headless Pi supervisor
   - Lazy-start Pi RPC process per Shepherd session.
   - Ensure extension auto-attaches to the session.
   - Stop after idle timeout.

7. End-to-end final delivery
   - Slack inbound creates/uses session binding.
   - User message creates queued run.
   - Extension claims and calls `pi.sendUserMessage()`.
   - Extension returns final assistant text.
   - Daemon appends `gateway.message` and delivers to Slack.

Verification:

- Unit tests for config schema.
- Integration tests for readiness handshake success/failure with fake Pi RPC process.
- Integration tests for claim lifecycle.
- Integration tests for Slack inbound -> queued run -> complete -> delivery with fake extension.
- Manual smoke with real Pi and Slack.

## Slice 2: dynamic Shepherd tools in Pi

Goal: Pi can call Shepherd/Herdr logical tools through the extension.

Steps:

1. Extension calls daemon `tool.list` after attach.
2. Extension registers Pi tools dynamically.
3. Each tool delegates to `tool.run` with current Shepherd session id.
4. Add extension metadata overrides for critical Herdr tools:
   - clear prompt guidance.
   - compact rendering where useful.
5. Inject Herdr agent profile summaries into `before_agent_start`.

Verification:

- Unit/integration tests with fake daemon `tool.list` and `tool.run`.
- Manual prompt that causes Pi to call `session_read` or `herdr_read`.

## Slice 3: Slack final-answer streaming

Goal: Hermes-style token streaming for assistant text.

Steps:

1. Add Slack `chat.update` support to delivery adapter or streaming-specific Slack client.
2. Add transient stream RPC methods.
3. Extension forwards Pi `message_update` text deltas.
4. Daemon accumulates and throttles updates.
5. Final response clears cursor and stores only final `gateway.message`.
6. Add fallback behavior for update failures.

Verification:

- Unit tests for stream state throttle.
- Unit tests for final cursor removal.
- Integration test with fake Slack client proving `postMessage` then `chat.update` calls.
- Manual Slack smoke: visible growing response.

## Slice 4: TUI takeover and auto attach

Goal: open the same Pi session interactively and let it own future runs.

Steps:

1. Add `shepherd open --session <id>`.
2. Ensure Pi session binding custom entry is written.
3. Extension auto-attaches on Pi `/resume` when binding matches daemon identity.
4. Add owner priority and heartbeat.
5. Stop headless claiming while TUI owner is active.
6. Mark running TUI-owned run `recovery_required` on disconnect.

Verification:

- Integration tests for owner priority and heartbeat timeout.
- Manual smoke:
  - Slack creates session.
  - `shepherd open --session <id>` opens Pi.
  - Slack message appears in Pi TUI and is answered by TUI Pi.
  - Close Pi while idle; next Slack message uses headless Pi.
  - Close Pi while running; run becomes recovery_required.

## Slice 5: tool progress and polish

Goal: optional, Hermes-inspired progress display without Slack spam by default.

Steps:

1. Add `platforms.slack.streaming.tool_progress` handling.
2. Keep default `off`.
3. Add `compact` mode if needed:
   - one editable progress bubble or Slack-native stream/task card if available.
4. Add cleanup/collapse behavior later if useful.

## Test plan

### Unit tests

- Config parsing:
  - valid Pi runtime config.
  - old provider config rejection or migration behavior.
  - Slack streaming config defaults.
- Gateway run store/queue:
  - queued creation.
  - claim is atomic.
  - higher-priority owner wins.
  - running owner disconnect marks recovery_required.
- Stream state:
  - first delta posts placeholder.
  - updates throttle by interval and buffer threshold.
  - final removes cursor.
  - failures disable progressive updates.
- Pi binding serialization:
  - custom binding shape.
  - daemon id mismatch prevents auto attach.

### Integration tests

- Daemon startup readiness:
  - missing Pi command.
  - missing extension handshake.
  - no available models.
  - success path.
- Slack final-only vertical slice with fake Pi extension.
- `tool.list` -> extension tool registration contract with fake Pi extension harness if practical.
- Slack streaming with fake Slack client.
- TUI owner priority with fake owner clients.

### Manual smoke tests

1. Install:
   ```bash
   brew install shepherd
   pi install npm:shepherd-pi
   ```
2. Start daemon:
   ```bash
   shepherd daemon --config ~/.shepherd/config.yaml
   ```
3. Send Slack message in an allowed channel/thread.
4. Confirm:
   - Shepherd session created/bound.
   - Pi session file created.
   - Slack receives final reply.
5. Enable streaming and confirm Slack message updates live.
6. Open session:
   ```bash
   shepherd open --session <id>
   ```
7. Send Slack message and confirm it appears in Pi TUI and TUI owner responds.
8. Resume same Pi session through Pi `/resume`; confirm auto attach.
9. Close TUI while idle; confirm headless fallback.
10. Close TUI while running; confirm recovery note.

## Risks and mitigations

### Pi extension not loaded in headless mode

Mitigation: daemon readiness handshake is required before Slack starts.

### Pi session file concurrent writes

Mitigation: one owner can claim runs at a time. Headless owner pauses when TUI owner is active. Running owner loss does not auto-replay.

### Slack streaming duplicate/final missing

Mitigation: follow Hermes lessons:

- Track whether final content was actually delivered, not merely whether any stream update was sent.
- Final `gateway.message` remains the durable event.
- Delivery fallback must avoid double-posting when final stream update succeeded.

### Tool side effects on recovery

Mitigation: keep existing logical tool idempotency and conservative recovery. Running run owner loss becomes `recovery_required`.

### Schema mismatch between daemon tools and Pi providers

Mitigation: MVP passes JSON Schema through. Add extension-side normalization only for observed incompatibilities.

### Slack progress spam

Mitigation: Slack tool progress default is `off`, following Hermes' platform default.
