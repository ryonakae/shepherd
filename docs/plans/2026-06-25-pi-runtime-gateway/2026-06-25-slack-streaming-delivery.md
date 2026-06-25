# Slack Streaming Delivery

Date: 2026-06-25

Parent: [Shepherd Pi Runtime Gateway Plan](../2026-06-25-pi-runtime-gateway.md)

## Status

Active child plan. Not started.

## Progress

- **Done** — Streaming should follow Hermes' edit-in-place model.
- **Done** — Token deltas are transient and not persisted.
- **Done** — Final assistant text is persisted as `gateway.message`.
- **Done** — Slack tool progress defaults to `off`.
- **Not started** — Slack `chat.update` support.
- **Not started** — Stream delivery state and delta RPC.

## Next steps

1. Extend Slack delivery client with `chat.update`.
2. Add transient stream RPC handlers.
3. Implement in-memory stream state keyed by `gatewayRunId`.
4. Wire Pi `message_update` deltas through `shepherd-pi`.
5. Add tests for throttling, cursor removal, and final delivery.

## Hermes reference

Follow Hermes' gateway streaming architecture:

- Delta producer and platform delivery consumer are decoupled by a queue/state object.
- Platform message updates are throttled by time and buffer size.
- Streaming presentation is not persisted to conversation history.
- Final response is persisted and delivered as the canonical assistant message.
- Tool boundaries can segment assistant text so final text appears below progress bubbles.

Relevant Hermes behavior:

- `gateway/stream_consumer.py`: progressive edit consumer.
- `gateway/display_config.py`: per-platform display defaults; Slack defaults tool progress off.
- Structured stream event protocol PR: presentation-only stream events are not persisted to conversation history.

## Stream state

Use daemon memory state keyed by `gatewayRunId`:

```ts
type StreamDeliveryState = {
  accumulatedText: string;
  bufferSinceLastEdit: string;
  cursor: string;
  editIntervalMs: number;
  bufferThresholdChars: number;
  lastEditAt: number;
  platform: "slack";
  targetId: string;
  remoteMessageId?: string;
  disabled: boolean;
  failureCount: number;
};
```

Do not persist stream deltas or stream delivery state.

Daemon crash behavior:

- Existing daemon restart recovery marks running runs `recovery_required`.
- Partial Slack stream message may remain in the thread.
- Future improvement: update partial stream to “interrupted; recovery required” during graceful shutdown or recovery.

## Slack mechanics

Current Slack adapter supports `chat.postMessage`. Add update support:

- `chat.update` for streaming edits.
- Keep `chat.postMessage` for initial placeholder and normal final-only delivery.
- Preserve thread routing with `thread_ts` from binding target.
- Use `delivery_receipts` only for final persisted events. Streaming placeholder state is memory-only for MVP.

Streaming flow:

```text
first delta:
  post placeholder text + cursor
  store remote ts in memory

subsequent deltas:
  append to accumulated text
  if edit interval or buffer threshold reached:
    chat.update accumulated + cursor

finish:
  chat.update final accumulated text without cursor
  clear memory stream state
```

If progressive update fails repeatedly:

- Disable progressive edits for that run.
- Continue buffering text in memory.
- On final, best-effort update or post final message.
- Do not mark run completed until final text is safely handled or a clear fallback path is chosen.

## RPC methods

### `gateway.stream_delta`

Transient, not persisted.

```json
{
  "ownerId": "...",
  "gatewayRunId": "...",
  "delta": "..."
}
```

### `gateway.stream_segment_break`

Transient, not persisted. Mirrors Hermes' tool-boundary segment break.

```json
{
  "ownerId": "...",
  "gatewayRunId": "..."
}
```

### `gateway.stream_finish`

Transient. Final cosmetic update, cursor removal, and delivery state cleanup.

### `gateway.stream_tool_progress`

Optional / post-MVP for Slack. Initial Slack default is off.

## Tool progress

Initial Slack default:

```yaml
tool_progress: off
```

Meaning:

- Do not send per-tool Slack progress bubbles by default.
- Pi tool events may still be recorded as Shepherd tool events when useful.
- Final answer streaming remains enabled.

Future opt-in:

- `compact`: one editable progress bubble or Slack-native progress card when available.
- `verbose`: detailed tool start/finish lines.

Do not make tool progress part of Pi conversation history.

## Delivery receipts

Keep `delivery_receipts` event-id based for persisted events.

Streaming placeholders are not delivery receipts in MVP. Final `gateway.message` remains the persisted delivery unit. If final content was already delivered by stream update, mark/send receipt consistently when final event is appended.

## Tests

- First delta posts placeholder in the correct Slack thread.
- Subsequent deltas call `chat.update`, not `postMessage`.
- Updates throttle by interval and buffer threshold.
- Final update removes cursor.
- Repeated update failures disable progressive edits and still deliver final text.
- Final content is not double-posted when streaming already delivered it.
