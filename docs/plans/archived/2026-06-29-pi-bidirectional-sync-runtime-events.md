# Pi Bidirectional Sync and Runtime Events Implementation Plan

## Status

Archived. Superseded by [`2026-06-30-pi-runtime-gateway-rebuild.md`](2026-06-30-pi-runtime-gateway-rebuild.md).

This plan captured the first `pi.*` runtime event design, but the target architecture changed during the 2026-06-30 design pass: `gateway_runs` became `pi_turns`, `gateway.message` became `assistant.message`, legacy provider runner compatibility was dropped, and the DB migration history is reset.

> **For implementers:** Historical reference only. Do not execute this plan task-by-task.

**Goal:** Make Shepherd synchronize Pi TUI/RPC input, Pi assistant output, and Pi tool activity bidirectionally with Slack and the Shepherd event stream without waking duplicate Gateway runs for Pi-originated input.

**Architecture:** Pi runtime-originated facts enter Shepherd through `pi.*` RPC methods, not through `session.user_message` or legacy `gateway.stream_*` completion RPCs. `piTurnId` is the stable correlation id for every Pi agent turn, while `gatewayRunId` remains an optional link when the turn was triggered by an existing Gateway queued run. Slack assistant streaming and tool progress use transient delivery state keyed by `piTurnId`; final user/assistant/tool/lifecycle facts are stored as compact Shepherd events.

**Tech Stack:** TypeScript ESM with NodeNext, Node.js `node:net` JSON Lines RPC, SQLite through existing stores, Slack Web API `chat.postMessage`/`chat.update`, JavaScript/TypeScript `packages/shepherd-pi` Pi extension, Vitest integration/unit tests, Biome via `pnpm check`.

## Global Constraints

- Chat/user-facing progress remains Japanese in this repository, but code and public docs use English unless existing local context differs.
- This repository is not released yet; do not preserve compatibility for old `gateway.stream_delta`, `gateway.stream_finish`, `gateway.stream_segment_break`, `gateway.stream_tool_progress`, `gateway.complete_run`, or `gateway.fail_run` RPCs.
- Do not expose thinking by default.
- Do not persist or send raw Pi tool args, raw tool results, stdout/stderr dumps, file contents, provider request/response payloads, or thinking.
- Slack `platforms.slack.streaming.tool_progress` remains exactly `"off" | "compact" | "verbose"`; default stays `off`.
- `tool_progress: compact` means one editable progress bubble per `piTurnId`.
- `tool_progress: verbose` still uses sanitized preview/text only; no raw result output.
- Slack progress cleanup/deletion is not implemented in this plan; do not add Slack `chat.delete` or new delete scopes.
- `pi.tool.started`, `pi.tool.finished`, and `pi.tool.failed` are persistent events, but only finished/failed compact text enters Gateway context/summary.
- `source === "extension"` Pi input is Shepherd-injected and must not create another `user.message`.
- Pi-originated user messages are mirror-only: store, publish, and deliver, but never queue/wake a Gateway run.
- Final assistant text is still stored as `gateway.message`; payload metadata identifies `sourceRuntime: "pi"`.
- Event writes are append-only. Do not update prior `user.message` events to add `piTurnId`.
- Terminal turn state is first-terminal-wins. A later contradictory terminal RPC records `pi.turn.terminal_conflict` and returns `ignored: true`.
- Validation after implementation should include `pnpm check`. If CLI distribution/import resolution changes, also run `pnpm build`.

## Current Context

- `src/gateway/server.ts` currently has `session.user_message`, `session.append_event`, Pi owner attach/heartbeat, external run queue claim/start/complete/fail, and legacy `gateway.stream_*` RPC handlers.
- `src/gateway/external-run-queue.ts` currently appends `gateway.message`, `gateway.run.completed`, and `gateway.run.failed` from `gateway.complete_run` / `gateway.fail_run` paths.
- `src/platforms/runtime.ts` exposes `GatewayStreamDelivery` keyed by `gatewayRunId`; it should become a Pi/runtime stream delivery keyed by a generic `streamId`/`piTurnId`.
- `src/platforms/slack/delivery.ts` has `SlackStreamDelivery` keyed by `gatewayRunId`; it supports `postMessage` and `update` but not progress bubbles or delete.
- `src/delivery/fanout.ts` only fanouts `approval.requested`, `approval.responded`, `gateway.message`, and `user.message`; keep `pi.tool.*` and `pi.turn.*` out of normal fanout.
- `src/gateway/context.ts` currently treats all `user.message` as user text and all `gateway.message` as assistant text; it needs Pi source/delivery aware formatting.
- `packages/shepherd-pi/src/index.ts` currently claims `gateway.run.queued`, calls `gateway.start_run`, streams via `gateway.stream_delta/finish`, and finalizes via `gateway.complete_run`.
- Pi extension hooks available from Pi docs: `input`, `agent_start`, `agent_end`, `message_update`, `message_end`, `tool_execution_start`, `tool_execution_update`, `tool_execution_end`.
- Existing tests to extend include `test/integration/gateway-rpc.test.ts`, `test/unit/slack-delivery.test.ts`, `test/integration/delivery-fanout.test.ts`, and `test/unit/gateway-context.test.ts`.

## File Structure

- Create: `src/gateway/pi-runtime-events.ts` — shared Pi runtime payload types, validation helpers, idempotency key helpers, text sanitization, and terminal-state helpers used by the Gateway RPC server.
- Create: `src/platforms/slack/tool-progress.ts` — Slack transient Pi tool progress state and rendering for `off`/`compact`/`verbose`.
- Modify: `src/gateway/server.ts` — replace legacy completion/stream RPCs with `pi.*` RPCs, append Pi lifecycle/tool/user/assistant events, and publish/deliver appropriate events.
- Modify: `src/gateway/external-run-queue.ts` — replace old complete/fail helpers with explicit `completeRunFromPiTurn()` and `failRunFromPiTurn()` methods that only append `gateway.run.completed` / `gateway.run.failed` and update run status; `gateway.message` is appended by `pi.complete_turn` in `src/gateway/server.ts`.
- Modify: `src/gateway/turn-queue.ts` — make terminal run transitions first-terminal-wins and return status information instead of blindly overwriting terminal state.
- Modify: `src/gateway/context.ts` — format Pi-originated user, assistant, and tool events for Gateway context/summary.
- Modify: `src/platforms/runtime.ts` — rename/genericize stream delivery to Pi runtime streams, export the platform runtime property as `runtimeDelivery`, and wire Slack tool progress service.
- Modify: `src/platforms/slack/delivery.ts` — genericize stream keys from `gatewayRunId` to `streamId`, render user-message delivery prefixes for Slack, and keep `deliveredByStream` skip behavior.
- Modify: `src/delivery/fanout.ts` — keep fanout allowlist unchanged for normal persisted delivery and add/verify echo behavior for `sourcePlatform: "pi"` and `"pi-rpc"`.
- Modify: `packages/shepherd-pi/src/index.ts` — generate/manage `piTurnId`, mirror input, stream assistant deltas, record tool lifecycle, and complete/fail turns through new `pi.*` RPCs.
- Test: `test/integration/gateway-rpc.test.ts` — Pi RPC contracts, idempotency, first-terminal-wins, no duplicate Gateway wake.
- Test: `test/unit/slack-delivery.test.ts` — generic stream key and Slack user-message prefix rendering.
- Test: `test/unit/gateway-context.test.ts` — Pi source/delivery context formatting and Pi tool context inclusion.
- Test: `test/integration/delivery-fanout.test.ts` — Pi-originated user messages deliver to Slack while Slack-originated messages do not echo.
- Test: add `test/unit/pi-runtime-events.test.ts` — sanitizer, payload validation, idempotency keys, terminal conflict helpers.

## Interfaces to Implement

### Pi RPC Methods

`pi.mirror_user_message`

```ts
type PiMirrorUserMessageParams = {
  delivery: "immediate" | "steer" | "followUp";
  displayName: string;
  ownerId: string;
  ownerKind: "tui_pi" | "headless_pi";
  piSessionFile: string;
  piSessionId: string;
  piTurnId: string;
  sessionId: string;
  source: "interactive" | "rpc";
  text: string;
  avatarUrl?: string;
  deliverySequence?: number;
};
```

Server behavior:
- Upsert actor id `pi:<ownerId>` with kind `user`, `displayName: params.displayName`, and optional `avatarUrl: params.avatarUrl`.
- Append `user.message` with payload:
  - `text`
  - `piTurnId`
  - `delivery`
  - `presentation.sourcePlatform = "pi"` for interactive, `"pi-rpc"` for rpc
  - `presentation.displayName = params.displayName`
  - `presentation.avatarUrl = params.avatarUrl` when present
- Publish and fanout the event.
- Do not wake/queue Gateway.

`pi.start_turn`

```ts
type PiStartTurnParams = {
  gatewayRunId?: string;
  inputEventIds: number[];
  ownerId: string;
  ownerKind: "tui_pi" | "headless_pi";
  piSessionFile: string;
  piSessionId: string;
  piTurnId: string;
  sessionId: string;
  source: "interactive" | "rpc" | "extension";
  triggeringEventId?: number;
};
```

Server behavior:
- Validate owner is attached to `sessionId`.
- Append `pi.turn.started` with idempotency key `pi:turn:<piTurnId>:started`.
- Do not fanout to Slack.

`pi.stream_delta`, `pi.stream_finish`, `pi.stream_segment_break`

```ts
type PiStreamDeltaParams = {
  delta: string;
  gatewayRunId?: string;
  ownerId: string;
  piTurnId: string;
  sessionId: string;
};

type PiStreamFinishParams = {
  finalText?: string;
  gatewayRunId?: string;
  ownerId: string;
  piTurnId: string;
  sessionId: string;
};

type PiStreamSegmentBreakParams = {
  gatewayRunId?: string;
  ownerId: string;
  piTurnId: string;
  sessionId: string;
};
```

Server behavior:
- Use `piTurnId` as `streamId` for Slack stream delivery.
- `segment_break` closes the current assistant stream segment so following text can appear below progress, matching Hermes' segment-boundary model. If implementation cannot support visible segment breaks immediately, record no persisted event and return `{ streamed: false, reason: "segment_break_not_supported" }` until the Slack stream service supports it.

`pi.record_tool_progress`

```ts
type PiRecordToolProgressParams = {
  durationMs?: number;
  gatewayRunId?: string;
  isError?: boolean;
  ownerId: string;
  ownerKind: "tui_pi" | "headless_pi";
  piSessionFile: string;
  piSessionId: string;
  piTurnId: string;
  preview?: string;
  sessionId: string;
  status: "started" | "finished" | "failed";
  text: string;
  toolCallId: string;
  toolName: string;
  triggeringEventId?: number;
};
```

Server behavior:
- Sanitize/truncate `text` and `preview` defensively before storing or rendering.
- Append exactly one of `pi.tool.started`, `pi.tool.finished`, `pi.tool.failed` with idempotency key `pi:turn:<piTurnId>:tool:<toolCallId>:<status>`.
- Publish event to subscribers.
- Do not normal-fanout persisted `pi.tool.*`.
- Forward to Slack transient progress service when Slack `tool_progress` is `compact` or `verbose`.

`pi.complete_turn`

```ts
type PiCompleteTurnParams = {
  finalText: string;
  gatewayRunId?: string;
  ownerId: string;
  ownerKind: "tui_pi" | "headless_pi";
  piSessionFile: string;
  piSessionId: string;
  piTurnId: string;
  sessionId: string;
  triggeringEventId?: number;
};
```

Server behavior:
- First terminal wins per `piTurnId`.
- If a prior terminal is `completed`, return idempotent success.
- If a prior terminal is `failed`, append `pi.turn.terminal_conflict` and return `{ ignored: true, conflict: true }`.
- Finish Slack assistant stream with `piTurnId`; set `gateway.message.payload.deliveredByStream = true` when the stream already delivered final content.
- Append `gateway.message` with idempotency key `pi:turn:<piTurnId>:assistant`, payload `sourceRuntime: "pi"`, `piTurnId`, `gatewayRunId?`, `triggeringEventId?`, `ownerId`, `ownerKind`, `piSessionId`, `piSessionFile`, `text`.
- Append `pi.turn.ended` with idempotency key `pi:turn:<piTurnId>:completed`.
- If `gatewayRunId` is present, mark the run completed first-terminal-wins and append `gateway.run.completed` with idempotency key `gateway:run:<gatewayRunId>:completed`.
- Final-update any Slack compact/verbose progress bubble with `✓ Done`.
- Publish events in user-visible order: `gateway.message`, `pi.turn.ended`, `gateway.run.completed`.

`pi.fail_turn`

```ts
type PiFailTurnParams = {
  gatewayRunId?: string;
  message: string;
  ownerId: string;
  ownerKind: "tui_pi" | "headless_pi";
  piSessionFile: string;
  piSessionId: string;
  piTurnId: string;
  sessionId: string;
  triggeringEventId?: number;
};
```

Server behavior:
- First terminal wins per `piTurnId`.
- If a prior terminal is `failed`, return idempotent success.
- If a prior terminal is `completed`, append `pi.turn.terminal_conflict` and return `{ ignored: true, conflict: true }`.
- Append `pi.turn.failed` with idempotency key `pi:turn:<piTurnId>:failed`.
- If `gatewayRunId` is present, mark the run failed first-terminal-wins and append `gateway.run.failed` with idempotency key `gateway:run:<gatewayRunId>:failed`.
- Final-update Slack progress bubble with `✗ Failed: <short message>`.
- Do not fabricate `gateway.message`.

### Persistent Event Payloads

`pi.turn.started`

```ts
type PiTurnStartedPayload = {
  gatewayRunId?: string;
  inputEventIds: number[];
  ownerId: string;
  ownerKind: "tui_pi" | "headless_pi";
  piSessionFile: string;
  piSessionId: string;
  piTurnId: string;
  source: "interactive" | "rpc" | "extension";
  triggeringEventId?: number;
};
```

`pi.turn.ended`

```ts
type PiTurnEndedPayload = PiTurnStartedPayload & {
  durationMs?: number;
  status: "completed";
};
```

`pi.turn.failed`

```ts
type PiTurnFailedPayload = Omit<PiTurnStartedPayload, "inputEventIds"> & {
  message: string;
  status: "failed";
};
```

`pi.turn.terminal_conflict`

```ts
type PiTurnTerminalConflictPayload = {
  existingTerminal: "completed" | "failed";
  gatewayRunId?: string;
  ignoredTerminal: "completed" | "failed";
  message?: string;
  ownerId: string;
  ownerKind: "tui_pi" | "headless_pi";
  piTurnId: string;
};
```

`pi.tool.*` payload uses the `PiRecordToolProgressParams` shape after sanitization and with `status` matching the event type.

### Slack Rendering Rules

- `user.message` display text:
  - `delivery: "immediate"` or absent: `<text>`
  - `delivery: "steer"`: `↪ Steer: <text>`
  - `delivery: "followUp"`: `⏭ Follow-up: <text>`
- `payload.text` is never prefixed.
- `allow_customize` uses `presentation.displayName`/`avatarUrl` as today.
- Pi TUI display name: `Pi / <local user>`.
- Pi RPC display name: `Pi RPC / <local user>`.
- Slack stream final `gateway.message` with `deliveredByStream: true` remains skipped by normal `SlackDeliveryAdapter.deliver()`.

### Gateway Context Formatting

`buildGatewayMessagesFromEvents()` should format:

- Slack-originated `user.message`: `<text>`
- `presentation.sourcePlatform === "pi"` and `delivery === "immediate"`: `Pi: <text>`
- `presentation.sourcePlatform === "pi-rpc"` and `delivery === "immediate"`: `Pi RPC: <text>`
- `delivery === "steer"`: `Pi steer: <text>`
- `delivery === "followUp"`: `Pi follow-up: <text>`
- `gateway.message.payload.sourceRuntime === "pi"`: assistant role with `Pi assistant: <text>`
- `pi.tool.finished` / `pi.tool.failed`: system role with `Pi tool: <payload.text>`
- `pi.tool.started`, `pi.turn.*`, and `pi.turn.terminal_conflict`: not included in Gateway context/summary.

## Tasks

### Task 1: Add Pi Runtime Payload Helpers and Sanitization

**Objective:** Define the shared Pi runtime contracts, idempotency keys, sanitizer, and first-terminal inspection helpers without changing RPC behavior.

**Files:**
- Create: `src/gateway/pi-runtime-events.ts`
- Test: `test/unit/pi-runtime-events.test.ts`

**Interfaces:**
- Produces `sanitizePiPreviewText`, `piTurnIdempotencyKey`, `piToolIdempotencyKey`, `terminalConflictPayload`, `parsePi*Params` helper functions for later server tasks.

- [ ] **Step 1: Write failing tests**

Create `test/unit/pi-runtime-events.test.ts` with cases:

1. `sanitizePiPreviewText()` truncates long strings to 240 chars for compact text and replaces secret-like values:
   - `token=abc123456789` → `token=[redacted]`
   - `Authorization: Bearer abcdef` → `Authorization: Bearer [redacted]`
   - `OPENAI_API_KEY=sk-abc` → `OPENAI_API_KEY=[redacted]`
2. `piTurnIdempotencyKey("turn-1", "completed")` returns `pi:turn:turn-1:completed`.
3. `piToolIdempotencyKey("turn-1", "tool-1", "started")` returns `pi:turn:turn-1:tool:tool-1:started`.
4. Param parsers reject missing `sessionId`, `ownerId`, `piTurnId`, or invalid `status` with specific error messages.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test test/unit/pi-runtime-events.test.ts`

Expected: test runner fails because `src/gateway/pi-runtime-events.ts` does not exist.

- [ ] **Step 3: Implement helper module**

Create `src/gateway/pi-runtime-events.ts` exporting:

```ts
export type PiOwnerKind = "headless_pi" | "tui_pi";
export type PiInputSource = "extension" | "interactive" | "rpc";
export type PiInputDelivery = "followUp" | "immediate" | "steer";
export type PiToolStatus = "failed" | "finished" | "started";
export type PiTerminalStatus = "completed" | "failed";

export function piTurnIdempotencyKey(piTurnId: string, suffix: "assistant" | "completed" | "failed" | "started"): string;
export function piToolIdempotencyKey(piTurnId: string, toolCallId: string, status: PiToolStatus): string;
export function gatewayRunTerminalIdempotencyKey(gatewayRunId: string, status: PiTerminalStatus): string;
export function sanitizePiPreviewText(value: unknown, options?: { maxLength?: number }): string;
```

Sanitizer requirements:
- Convert non-string values with `String(value ?? "")`.
- Replace these case-insensitive patterns:
  - `(authorization\s*:\s*bearer\s+)[^\s]+` → `$1[redacted]`
  - `((?:api[_-]?key|token|password|secret)\s*[=:]\s*)[^\s]+` → `$1[redacted]`
- Collapse runs of more than 3 newlines to 2 newlines.
- Truncate to `maxLength` or 240 chars with `...` suffix.

Add parser helpers returning typed params or throwing `Error` with messages matching tests:

```ts
export function parsePiMirrorUserMessageParams(value: unknown): PiMirrorUserMessageParams;
export function parsePiStartTurnParams(value: unknown): PiStartTurnParams;
export function parsePiRecordToolProgressParams(value: unknown): PiRecordToolProgressParams;
export function parsePiCompleteTurnParams(value: unknown): PiCompleteTurnParams;
export function parsePiFailTurnParams(value: unknown): PiFailTurnParams;
export function parsePiStreamDeltaParams(value: unknown): PiStreamDeltaParams;
export function parsePiStreamFinishParams(value: unknown): PiStreamFinishParams;
export function parsePiStreamSegmentBreakParams(value: unknown): PiStreamSegmentBreakParams;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test test/unit/pi-runtime-events.test.ts`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/pi-runtime-events.ts test/unit/pi-runtime-events.test.ts
git commit -m "gateway: add pi runtime event contracts"
```

### Task 2: Genericize Slack Streaming and Add Tool Progress State

**Objective:** Convert Slack streaming from `gatewayRunId` to generic `streamId` and add transient Pi tool progress rendering without normal event fanout.

**Files:**
- Create: `src/platforms/slack/tool-progress.ts`
- Modify: `src/platforms/slack/delivery.ts`
- Modify: `src/platforms/runtime.ts`
- Test: `test/unit/slack-delivery.test.ts`

**Interfaces:**
- Consumes sanitizer from Task 1.
- Produces a `runtimeDelivery` platform runtime property with methods for `delta`, `finish`, `segmentBreak`, `recordToolProgress`, and `finishToolProgress` keyed by `piTurnId`.

- [ ] **Step 1: Write failing tests**

Update `test/unit/slack-delivery.test.ts`:

1. `SlackStreamDelivery.delta({ streamId: "turn-1" })` posts and updates by `streamId`, and `hasFinished("turn-1")` returns true after finish.
2. `SlackDeliveryAdapter` renders `user.message` with `payload.delivery === "steer"` as `↪ Steer: text` and `followUp` as `⏭ Follow-up: text`, while leaving payload text unchanged.
3. `SlackToolProgressDelivery` in compact mode posts one message per `piTurnId`, updates the same message for subsequent tools, and appends `✓ Done` on completion.
4. Compact failure appends `✗ Failed: short error` and uses `chat.update`.
5. Verbose mode does not include raw `result` or `args` fields and only renders `text`/`preview`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test test/unit/slack-delivery.test.ts`

Expected: TypeScript/test failures because APIs are still `gatewayRunId`-based and tool progress class does not exist.

- [ ] **Step 3: Genericize `SlackStreamDelivery`**

In `src/platforms/slack/delivery.ts`:

- Rename method param fields from `gatewayRunId` to `streamId`:

```ts
hasFinished(streamId: string): boolean
async delta(input: { delta: string; streamId: string; targetId: string }): Promise<void>
async finish(input: { finalText?: string; streamId: string }): Promise<void>
```

- Internally key `#states` and `#finishedRunIds` by `streamId`.
- Keep class name `SlackStreamDelivery`.
- Update `SlackDeliveryAdapter.eventText()` to use delivery prefix only for display:

```ts
if (event.type === "user.message") {
  if (payload.delivery === "steer") return `↪ Steer: ${payload.text}`;
  if (payload.delivery === "followUp") return `⏭ Follow-up: ${payload.text}`;
}
```

- [ ] **Step 4: Add `SlackToolProgressDelivery`**

Create `src/platforms/slack/tool-progress.ts` exporting:

```ts
export type SlackToolProgressMode = "compact" | "off" | "verbose";
export class SlackToolProgressDelivery {
  constructor(options: { client: SlackPostMessageClient; mode: SlackToolProgressMode; now?: () => number });
  record(input: { piTurnId: string; targetId: string; status: "started" | "finished" | "failed"; text: string; preview?: string; toolName: string; durationMs?: number }): Promise<void>;
  complete(input: { piTurnId: string; targetId: string }): Promise<void>;
  fail(input: { message: string; piTurnId: string; targetId: string }): Promise<void>;
}
```

Compact behavior:
- `off`: no-op.
- First record: `chat.postMessage` into thread target.
- Later records: append one sanitized line and `chat.update` the same message.
- Final complete: update same message appending `✓ Done` once.
- Final fail: update same message appending `✗ Failed: <message>` once.

Verbose behavior:
- Reuse the same post/update infrastructure, but render `preview` when present and allow longer sanitized text. Do not render raw args/result.

- [ ] **Step 5: Update `src/platforms/runtime.ts`**

Replace `GatewayStreamDelivery` with:

```ts
export type PiRuntimeDelivery = {
  delta(input: { delta: string; sessionId: string; streamId: string }): Promise<void>;
  finish(input: { finalText?: string; streamId: string }): Promise<void>;
  hasFinished(streamId: string): boolean;
  segmentBreak?(input: { sessionId: string; streamId: string }): Promise<void>;
  recordToolProgress(input: { durationMs?: number; preview?: string; sessionId: string; status: "started" | "finished" | "failed"; text: string; toolName: string; piTurnId: string }): Promise<void>;
  completeToolProgress(input: { piTurnId: string; sessionId: string }): Promise<void>;
  failToolProgress(input: { message: string; piTurnId: string; sessionId: string }): Promise<void>;
};
```

In Slack runtime:
- Use `slack.streaming?.tool_progress ?? "off"` for tool progress mode.
- For every Slack binding of `sessionId`, call stream/tool progress services with target id `${binding.spaceId}:${binding.threadId}`.
- Return the delivery object from `createPlatformRuntime()` as `runtimeDelivery`, not `streamDelivery`:

```ts
return {
  async close() { /* existing close loop */ },
  deliveryFanout,
  ...(runtimeDelivery !== undefined ? { runtimeDelivery } : {}),
  async start() { /* existing start loop */ },
};
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm test test/unit/slack-delivery.test.ts`

Expected: all Slack delivery tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/platforms/slack/delivery.ts src/platforms/slack/tool-progress.ts src/platforms/runtime.ts test/unit/slack-delivery.test.ts
git commit -m "slack: support pi runtime streams and progress"
```

### Task 3: Replace Gateway Completion/Stream RPCs with Pi Runtime RPCs

**Objective:** Add `pi.*` RPC methods to `ShepherdGatewayServer`, remove legacy Gateway stream/complete/fail RPCs, and persist compact Pi lifecycle/tool events.

**Files:**
- Modify: `src/gateway/server.ts`
- Modify: `src/gateway/external-run-queue.ts`
- Modify: `src/gateway/turn-queue.ts`
- Test: `test/integration/gateway-rpc.test.ts`

**Interfaces:**
- Consumes Task 1 parsers/idempotency helpers and Task 2 `PiRuntimeDelivery`.
- Produces server RPC behavior for Pi extension tasks.

- [ ] **Step 1: Write failing tests**

In `test/integration/gateway-rpc.test.ts`, replace legacy stream/complete/fail test coverage with cases:

1. `pi.mirror_user_message` stores `user.message`, publishes it, fanouts it, and does not append `gateway.run.queued`.
2. `pi.start_turn` appends idempotent `pi.turn.started` with `inputEventIds`.
3. `pi.stream_delta` calls runtime delivery with `{ streamId: piTurnId, sessionId, delta }`.
4. `pi.record_tool_progress` appends `pi.tool.started/finished/failed` idempotently and calls transient progress delivery without normal fanout.
5. `pi.complete_turn` appends `gateway.message`, `pi.turn.ended`, and linked `gateway.run.completed` when `gatewayRunId` exists.
6. Repeated `pi.complete_turn` with same `piTurnId` does not duplicate events.
7. `pi.fail_turn` appends `pi.turn.failed`, and linked `gateway.run.failed` when `gatewayRunId` exists.
8. Complete after fail or fail after complete returns `ignored: true`, appends `pi.turn.terminal_conflict`, and does not change run terminal state.
9. Unknown legacy methods `gateway.stream_delta`, `gateway.stream_finish`, `gateway.stream_segment_break`, `gateway.stream_tool_progress`, `gateway.complete_run`, and `gateway.fail_run` return unknown method errors.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test test/integration/gateway-rpc.test.ts`

Expected: failures because new RPC methods do not exist and old methods still exist.

- [ ] **Step 3: Update server option and delivery type names**

In `src/gateway/server.ts`:

- Replace `GatewayStreamDeliveryService` with `PiRuntimeDeliveryService` matching Task 2.
- Rename field `#streamDelivery` to `#runtimeDelivery`.
- Update constructor option from `streamDelivery` to `runtimeDelivery`.
- Update `src/gateway/service.ts` to pass `platformRuntime.runtimeDelivery` into `ShepherdGatewayServer` as `runtimeDelivery`.

- [ ] **Step 4: Remove legacy RPC dispatch**

Delete dispatch branches and methods for:

- `gateway.complete_run`
- `gateway.stream_delta`
- `gateway.stream_finish`
- `gateway.stream_segment_break`
- `gateway.stream_tool_progress`
- `gateway.fail_run`

Keep:

- `gateway.claim_next_run`
- `gateway.start_run`
- `gateway.run.queued` event behavior

- [ ] **Step 5: Add new `pi.*` dispatch branches**

Add handlers in `#handleMessage()`:

```ts
if (request.method === "pi.mirror_user_message") { void this.#mirrorPiUserMessage(socket, request); return; }
if (request.method === "pi.start_turn") { void this.#startPiTurn(socket, request); return; }
if (request.method === "pi.stream_delta") { void this.#streamPiDelta(socket, request); return; }
if (request.method === "pi.stream_finish") { void this.#finishPiStream(socket, request); return; }
if (request.method === "pi.stream_segment_break") { void this.#segmentPiStream(socket, request); return; }
if (request.method === "pi.record_tool_progress") { void this.#recordPiToolProgress(socket, request); return; }
if (request.method === "pi.complete_turn") { void this.#completePiTurn(socket, request); return; }
if (request.method === "pi.fail_turn") { void this.#failPiTurn(socket, request); return; }
```

- [ ] **Step 6: Implement owner validation helper**

Add a private helper:

```ts
#requirePiOwner(ownerId: string, sessionId: string): PiOwnerRecord
```

It should:
- Call `#pruneStaleOwners()`.
- Return owner only if `owner.sessionId === sessionId`.
- Throw `Error("Pi owner is not attached to this session")` otherwise.

Use it in every new `pi.*` method that includes `ownerId`.

- [ ] **Step 7: Implement `pi.mirror_user_message`**

Use `#store.upsertActor()` and `#store.appendEvent()` directly, not `#storeUserMessage()` and not `#wakeGatewayForUserMessage()`.

Idempotency key:

```ts
`pi:turn:${params.piTurnId}:user:${params.delivery}:${params.deliverySequence ?? 0}:${hashText(params.text)}`
```

Implement `hashText` locally with Node `createHash("sha256").update(text).digest("hex").slice(0, 16)` so repeated retries dedupe while different steer messages in the same turn do not collide.

Response: `{ event: toWireEvent(event) }`.

- [ ] **Step 8: Implement `pi.start_turn` and tool progress**

`pi.start_turn` appends `pi.turn.started` with idempotency key `pi:turn:<piTurnId>:started`.

`pi.record_tool_progress`:
- Sanitize params text/preview.
- Append event type `pi.tool.${statusName}` where `finished` maps to `pi.tool.finished`.
- Publish event.
- Call `runtimeDelivery.recordToolProgress()` after append.
- Response includes `{ event: toWireEvent(event) }`.

- [ ] **Step 9: Implement `pi.stream_*`**

`pi.stream_delta`:
- Validate owner.
- If runtime delivery missing, respond `{ streamed: false }`.
- Else call `delta({ delta, sessionId, streamId: piTurnId })` and respond `{ streamed: true }`.

`pi.stream_finish`:
- Call `finish({ finalText, streamId: piTurnId })`.

`pi.stream_segment_break`:
- If delivery has `segmentBreak`, call it.
- Else respond `{ streamed: false, reason: "segment_break_not_supported" }`.

- [ ] **Step 10: Implement first-terminal-wins helpers**

Add server helper:

```ts
#existingPiTerminal(sessionId: string, piTurnId: string): "completed" | "failed" | undefined
```

It must not use `#store.listEvents(sessionId)` with the default limit, because that only returns 100 events. Implement it by checking stable idempotency keys directly:

1. Try `#store.getEventByIdempotencyKey(sessionId, piTurnIdempotencyKey(piTurnId, "completed"))`; if found, return `"completed"`.
2. If not found, try `#store.getEventByIdempotencyKey(sessionId, piTurnIdempotencyKey(piTurnId, "failed"))`; if found, return `"failed"`.
3. If both lookups throw `Event not found for idempotency key`, return `undefined`.

Do not scan paginated event history for terminal detection.

Add helper to append conflict:

```ts
#appendPiTerminalConflict(params, existingTerminal, ignoredTerminal): EventRecord
```

with idempotency key `pi:turn:<piTurnId>:terminal_conflict:<existing>:<ignored>`.

- [ ] **Step 11: Implement `pi.complete_turn`**

Behavior:
- Validate owner.
- Check existing terminal.
- If existing is `completed`, return `{ ignored: false, idempotent: true }` and do not append.
- If existing is `failed`, append conflict and return `{ ignored: true, conflict: true, event }`.
- Determine `deliveredByStream` with `runtimeDelivery?.hasFinished(piTurnId) === true`.
- Append `gateway.message` with idempotency key `pi:turn:<piTurnId>:assistant`.
- Append `pi.turn.ended` with idempotency key `pi:turn:<piTurnId>:completed`.
- If `gatewayRunId`, update `GatewayRunStore` via `ExternalGatewayRunQueue` helper and append `gateway.run.completed` with idempotency key `gateway:run:<gatewayRunId>:completed`.
- Call `runtimeDelivery.completeToolProgress({ piTurnId, sessionId })`.
- Publish all appended events in order.
- Return `{ events: [...wireEvents], ignored: false }`.

- [ ] **Step 12: Implement `pi.fail_turn`**

Behavior mirrors complete:
- Existing `failed`: idempotent success.
- Existing `completed`: conflict.
- Append `pi.turn.failed`.
- If `gatewayRunId`, mark linked run failed and append `gateway.run.failed`.
- Call `runtimeDelivery.failToolProgress({ piTurnId, sessionId, message })`.
- Publish events.

- [ ] **Step 13: Make Gateway run terminal transitions first-terminal-wins**

In `src/gateway/turn-queue.ts`, add methods or alter `markCompleted`/`markFailed` so terminal statuses are not overwritten:

```ts
markCompletedIfRunning(id: string): { changed: boolean; run: GatewayRunRecord }
markFailedIfRunning(id: string, error: unknown): { changed: boolean; run: GatewayRunRecord }
```

They should update only when status is `queued` or `running`. Existing terminal states return `{ changed: false }`.

Update `ExternalGatewayRunQueue` to use these methods for Pi completion/failure helpers.

- [ ] **Step 14: Run test to verify it passes**

Run: `pnpm test test/integration/gateway-rpc.test.ts`

Expected: all gateway RPC tests pass with old method assertions updated to unknown method behavior.

- [ ] **Step 15: Commit**

```bash
git add src/gateway/server.ts src/gateway/external-run-queue.ts src/gateway/turn-queue.ts src/gateway/service.ts test/integration/gateway-rpc.test.ts
git commit -m "gateway: replace run completion with pi turn rpc"
```

### Task 4: Update Gateway Context and Fanout Behavior

**Objective:** Make stored Pi mirror events appear correctly in Gateway context/summary and Slack fanout while keeping Pi tool/turn events out of normal Slack delivery.

**Files:**
- Modify: `src/gateway/context.ts`
- Modify: `src/delivery/fanout.ts`
- Test: `test/unit/gateway-context.test.ts`
- Test: `test/integration/delivery-fanout.test.ts`

**Interfaces:**
- Consumes persistent event payload shapes from Task 3.
- Produces stable context strings and verified echo prevention.

- [ ] **Step 1: Write failing context tests**

In `test/unit/gateway-context.test.ts`, add cases:

1. Pi immediate user message becomes role `user`, content `Pi: inspect this`.
2. Pi RPC immediate becomes `Pi RPC: inspect this`.
3. Pi steer becomes `Pi steer: stop and check tests`.
4. Pi followUp becomes `Pi follow-up: summarize after that`.
5. `gateway.message` with `sourceRuntime: "pi"` becomes role `assistant`, content `Pi assistant: done`.
6. `pi.tool.finished` and `pi.tool.failed` become role `system`, content `Pi tool: <text>`.
7. `pi.tool.started`, `pi.turn.started`, `pi.turn.ended`, `pi.turn.failed`, and `pi.turn.terminal_conflict` are omitted.

- [ ] **Step 2: Write failing fanout tests**

In `test/integration/delivery-fanout.test.ts`, add cases:

1. `user.message` with `presentation.sourcePlatform: "pi"` delivers to Slack binding.
2. `user.message` with `presentation.sourcePlatform: "pi-rpc"` delivers to Slack binding.
3. `pi.tool.finished` and `pi.turn.ended` do not normal-fanout.

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
pnpm test test/unit/gateway-context.test.ts test/integration/delivery-fanout.test.ts
```

Expected: context tests fail because formatting is not Pi-aware; fanout tests for Pi tool/turn should pass if allowlist is unchanged, while Pi user cases may pass already. Keep the tests as regression coverage.

- [ ] **Step 4: Implement context formatting**

In `src/gateway/context.ts`:

- Replace plain `payloadText()` use for `user.message` with a formatter that inspects `payload.presentation.sourcePlatform` and `payload.delivery`.
- Keep Slack-originated messages unchanged.
- Add Pi tool handling only for `pi.tool.finished` and `pi.tool.failed`.
- Add assistant prefix only when `payload.sourceRuntime === "pi"`.

Expected formatting:

```ts
function userContextText(payload: unknown): string | undefined {
  const text = payloadText(payload);
  if (!text) return undefined;
  const delivery = payloadDelivery(payload);
  const source = payloadSourcePlatform(payload);
  if (delivery === "steer") return `Pi steer: ${text}`;
  if (delivery === "followUp") return `Pi follow-up: ${text}`;
  if (source === "pi") return `Pi: ${text}`;
  if (source === "pi-rpc") return `Pi RPC: ${text}`;
  return text;
}
```

- [ ] **Step 5: Confirm fanout allowlist stays narrow**

In `src/delivery/fanout.ts`, do not add `pi.tool.*` or `pi.turn.*` to `deliverableEventTypes`. If no code change is needed, only commit test additions for this file's behavior.

- [ ] **Step 6: Run tests to verify they pass**

Run:

```bash
pnpm test test/unit/gateway-context.test.ts test/integration/delivery-fanout.test.ts
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/gateway/context.ts src/delivery/fanout.ts test/unit/gateway-context.test.ts test/integration/delivery-fanout.test.ts
git commit -m "gateway: format pi mirrored events in context"
```

### Task 5: Update Shepherd Pi Extension to Mirror Input, Stream, Tools, and Turns

**Objective:** Make `packages/shepherd-pi` emit the new `pi.*` RPCs for all Pi agent turns and remove legacy completion/stream calls.

**Files:**
- Modify: `packages/shepherd-pi/src/index.ts`
- Test: package syntax and pack checks through existing `pnpm pi-package:check` or root `pnpm check`.

**Interfaces:**
- Consumes Task 3 RPCs.
- Produces bidirectional Pi-originated events and new completion/failure flow.

- [ ] **Step 1: Add extension state fields and RPC response map entries**

In `packages/shepherd-pi/src/index.ts`, update types:

```ts
type ShepherdRun = {
  actorId?: string | null;
  id: string;
  presentation?: unknown;
  triggeringEventId?: number | null;
  userText: string;
};

type ShepherdState = {
  activeInputEventIds: number[];
  activePiTurnId: string | undefined;
  activeSource: "extension" | "interactive" | "rpc" | undefined;
  pendingFollowUps: Array<{ inputEventId?: number; piTurnId: string; text: string }>;
  pendingImmediate: { inputEventId?: number; piTurnId: string; source: "interactive" | "rpc"; text: string } | undefined;
  toolStartTimes: Map<string, number>;
  // existing fields...
};
```

Add response map entries for new RPCs:

```ts
"pi.mirror_user_message": { event?: { id?: number } };
"pi.start_turn": unknown;
"pi.stream_delta": unknown;
"pi.stream_finish": unknown;
"pi.stream_segment_break": unknown;
"pi.record_tool_progress": unknown;
"pi.complete_turn": unknown;
"pi.fail_turn": unknown;
```

Remove `gateway.complete_run`, `gateway.stream_delta`, and `gateway.stream_finish` from `GatewayResponseMap`.

- [ ] **Step 2: Add local helpers**

Add helpers in extension:

```ts
function newPiTurnId(): string { return `pi_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`; }
function localUserName(): string { return process.env.USER || process.env.LOGNAME || "local"; }
function sourcePlatformFor(source: "interactive" | "rpc"): "pi" | "pi-rpc";
function displayNameFor(source: "interactive" | "rpc"): string;
function inputDelivery(event: { streamingBehavior?: string }): "followUp" | "immediate" | "steer";
function textFromUnknownToolPreview(toolName: string, args: unknown): { text: string; preview?: string };
```

Preview rules:
- `bash` with `command`: `bash: <first line capped>`.
- `read` with `path`: `read: <path>`.
- `edit` with `path` or first edit path if available: `edit: <path>`.
- Fallback: `<toolName>`.
- Cap preview locally before sending, for example 160 chars.
- Do not send raw args or result.

- [ ] **Step 3: Mirror direct input in `pi.on("input")`**

Add an `input` hook:

- If not attached or no client/session/owner, return `continue`.
- If `event.source === "extension"`, do not mirror user message; set up the pending/active source from `state.currentRun` before `pi.sendUserMessage()` in `claimNext()`.
- If `event.source === "interactive"` or `"rpc"`:
  - Determine delivery: `event.streamingBehavior === "steer" ? "steer" : event.streamingBehavior === "followUp" ? "followUp" : "immediate"`.
  - `steer`: use `state.activePiTurnId` if present, otherwise create a new id.
  - `followUp`: create a new pending `piTurnId` per input.
  - `immediate`: create a new `piTurnId` and store as pending immediate.
  - Call `pi.mirror_user_message` with source, delivery, text, displayName from `displayNameFor(source)`, owner/session ids, Pi session ids, ownerKind, and `piTurnId`.
  - Store returned event id for immediate/followUp pending records.
- Always return `{ action: "continue" }`.

- [ ] **Step 4: Start turns in `agent_start`**

Add `pi.on("agent_start")`:

- If `state.currentRun` exists, this is `source: "extension"`:
  - Use `state.pendingImmediate?.piTurnId` if already set for extension injection; otherwise create a new one.
  - `inputEventIds = triggeringEventId ? [triggeringEventId] : []`.
  - Include `gatewayRunId = state.currentRun.id` and `triggeringEventId`.
- Else if `state.pendingImmediate` exists, use that id and event id.
- Else if `state.pendingFollowUps.length > 0`, shift one pending follow-up and use its id/event id.
- Else create a new `piTurnId` with `inputEventIds: []`.
- Set `state.activePiTurnId`, `state.activeSource`, `state.activeInputEventIds`, reset `lastAssistantText`, `streamedAssistantText`, and `toolStartTimes`.
- Call `pi.start_turn`.

- [ ] **Step 5: Update Gateway-run claim path**

In `claimNext()`:

- Keep `gateway.claim_next_run` and `gateway.start_run`.
- Before `pi.sendUserMessage(result.run.userText)`, set `state.currentRun = result.run`.
- Do not call any user mirror RPC; `source === "extension"` input hook will skip mirror.
- Let `agent_start` create `pi.turn.started` with `triggeringEventId`.

- [ ] **Step 6: Stream assistant deltas through `pi.stream_delta`**

Update `recordAssistantTextDelta()`:

- Require `state.activePiTurnId`, `state.client`, `state.ownerId`, and `state.sessionId`.
- Call `pi.stream_delta` with `piTurnId`, `gatewayRunId: state.currentRun?.id`, `sessionId`, `ownerId`, and `delta`.
- Do not call `gateway.stream_delta`.

Update `message_end` to keep `state.lastAssistantText` as today.

- [ ] **Step 7: Record tool lifecycle hooks**

Add hooks:

```ts
pi.on("tool_execution_start", async (event, ctx) => { ... });
pi.on("tool_execution_end", async (event, ctx) => { ... });
```

Start behavior:
- Store `state.toolStartTimes.set(event.toolCallId, Date.now())`.
- Build sanitized preview/text locally from `event.toolName` and `event.args`.
- Call `pi.record_tool_progress` with status `started`.

End behavior:
- Calculate duration from stored start time.
- Use status `failed` when `event.isError === true`, otherwise `finished`.
- Use text like:
  - finished: `${toolName} completed`
  - failed: `${toolName} failed`
  - Include preview if known from start state; if not, fallback to toolName.
- Do not send `event.result`.

Do not persist `tool_execution_update`; leave it unused in MVP.

- [ ] **Step 8: Complete turns through `pi.complete_turn`**

Update `agent_end`:

- If no active turn, return.
- Compute `finalText = state.lastAssistantText.trim()`.
- Call `pi.stream_finish` with `piTurnId`, `finalText`, optional `gatewayRunId`, `sessionId`, `ownerId`.
- Call `pi.complete_turn` with `finalText`, `piTurnId`, optional `gatewayRunId`, `triggeringEventId`, owner/session metadata.
- Clear active turn state and `state.currentRun`.
- Call `claimNext()` after successful completion.

- [ ] **Step 9: Failure path through `pi.fail_turn`**

Wrap turn-completion logic so if finalization throws after an active turn exists, call `pi.fail_turn` with the short error message and optional `gatewayRunId`.

Also add a `session_shutdown` handler if Pi exposes it in current extension API:
- If active turn exists and owner is still attached, best-effort call `pi.fail_turn` with message `Pi session shut down before turn completed.`.
- Ignore failures in shutdown cleanup.

- [ ] **Step 10: Run extension validation**

Run: `pnpm pi-package:check`

Expected: TypeScript/package check passes. If `pnpm pi-package:check` is not available in package scripts, run `pnpm check` and confirm it includes Pi package validation.

- [ ] **Step 11: Commit**

```bash
git add packages/shepherd-pi/src/index.ts
git commit -m "pi: mirror turns and tools through runtime rpc"
```

### Task 6: End-to-End Integration Tests for Bidirectional Sync

**Objective:** Cover the complete behavior across server, delivery, and extension-facing RPC without requiring a real Slack workspace or real Pi process.

**Files:**
- Modify: `test/integration/gateway-rpc.test.ts`
- Modify: `test/integration/platform-runtime.test.ts` if runtime wiring needs coverage
- Optional Create: `test/integration/pi-runtime-sync.test.ts` if `gateway-rpc.test.ts` becomes too large

**Interfaces:**
- Consumes all previous tasks.
- Produces regression tests for the 24/365 sync contract.

- [ ] **Step 1: Add no-duplicate-wake test**

Test flow:
1. Start server with `enableGatewayRuns: true` and fake delivery fanout collecting events.
2. Create session and attach Pi owner.
3. Call `pi.mirror_user_message` with `source: "interactive"`, `delivery: "immediate"`.
4. Assert events include `user.message` and do not include `gateway.run.queued`.
5. Assert delivery fanout saw the `user.message`.

Run: `pnpm test test/integration/gateway-rpc.test.ts`

Expected before implementation if not already covered: failure; after previous tasks: pass.

- [ ] **Step 2: Add Slack-originated run linked to Pi turn test**

Test flow:
1. Append Slack `session.user_message` and assert queued run.
2. Claim run from Pi owner.
3. Call `gateway.start_run`.
4. Call `pi.start_turn` with `source: "extension"`, `gatewayRunId`, `triggeringEventId`, `inputEventIds: [triggeringEventId]`.
5. Call `pi.record_tool_progress` started/finished.
6. Call `pi.complete_turn`.
7. Assert ordered events include:
   - original `user.message`
   - `gateway.run.queued`
   - `gateway.run.started`
   - `pi.turn.started`
   - `pi.tool.started`
   - `pi.tool.finished`
   - `gateway.message`
   - `pi.turn.ended`
   - `gateway.run.completed`
8. Assert run store status is `completed`.

- [ ] **Step 3: Add Pi direct input full turn test**

Test flow:
1. Call `pi.mirror_user_message` from interactive source.
2. Call `pi.start_turn` with the returned event id in `inputEventIds`.
3. Call `pi.stream_delta`, `pi.stream_finish`, and `pi.complete_turn`.
4. Assert no `gateway.run.*` events exist.
5. Assert `gateway.message.payload.sourceRuntime === "pi"`.

- [ ] **Step 4: Add terminal conflict test**

Test flow:
1. Start and complete a Pi turn.
2. Call `pi.fail_turn` with same `piTurnId`.
3. Assert response has `ignored: true`, `conflict: true`.
4. Assert `pi.turn.terminal_conflict` exists.
5. Assert no `gateway.run.failed` was appended after a completed linked run.

- [ ] **Step 5: Add context integration test**

In `test/unit/gateway-context.test.ts` or the new integration file, build events for immediate, steer, followUp, Pi assistant, and Pi tool finished. Assert generated messages exactly match the agreed prefixes.

- [ ] **Step 6: Run focused integration tests**

Run:

```bash
pnpm test test/integration/gateway-rpc.test.ts test/unit/gateway-context.test.ts test/unit/slack-delivery.test.ts
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add test/integration/gateway-rpc.test.ts test/integration/platform-runtime.test.ts test/integration/pi-runtime-sync.test.ts test/unit/gateway-context.test.ts test/unit/slack-delivery.test.ts
git commit -m "test: cover pi bidirectional runtime sync"
```

### Task 7: Remove Legacy References and Run Full Validation

**Objective:** Remove references to deleted legacy RPCs from code/tests/plans that are active, keep archived docs as history unless touched by active code docs, and run repository validation.

**Files:**
- Modify: `packages/shepherd-pi/src/index.ts`
- Modify: `src/gateway/server.ts`
- Modify: tests updated above
- Modify docs only if README or active instructions mention removed RPC names

**Interfaces:**
- Consumes all implementation tasks.
- Produces clean validation and no stale active code references.

- [ ] **Step 1: Search for stale legacy RPC names**

Run:

```bash
rg -n "gateway\.stream_delta|gateway\.stream_finish|gateway\.stream_segment_break|gateway\.stream_tool_progress|gateway\.complete_run|gateway\.fail_run" src packages test README.md docs/plans -g '!docs/plans/archived/**'
```

Expected: no matches in active code/tests/README/active plans. Matches in `docs/plans/archived/**` are acceptable historical records.

- [ ] **Step 2: Search for new RPC coverage**

Run:

```bash
rg -n "pi\.complete_turn|pi\.fail_turn|pi\.stream_delta|pi\.record_tool_progress|pi\.mirror_user_message|pi\.start_turn" src packages test
```

Expected: server handlers, extension calls, and tests are present.

- [ ] **Step 3: Run full validation**

Run:

```bash
pnpm check
```

Expected: typecheck, Vitest, Biome, and Drizzle check all pass.

- [ ] **Step 4: Build if import surfaces changed**

Run:

```bash
pnpm build
```

Expected: TypeScript build and alias rewriting complete successfully. Run this because the implementation changes exported/imported TypeScript modules under `src/platforms` and `src/gateway`.

- [ ] **Step 5: Commit**

```bash
git add src packages test README.md docs/plans/2026-06-29-pi-bidirectional-sync-runtime-events.md
git commit -m "chore: validate pi runtime sync migration"
```

## Validation

- `pnpm test test/unit/pi-runtime-events.test.ts` — sanitizer, idempotency keys, and parser tests pass.
- `pnpm test test/unit/slack-delivery.test.ts` — Slack stream/progress/prefix rendering tests pass.
- `pnpm test test/unit/gateway-context.test.ts` — Pi source/delivery context formatting tests pass.
- `pnpm test test/integration/delivery-fanout.test.ts` — Pi user messages fanout to Slack and Slack user messages do not echo.
- `pnpm test test/integration/gateway-rpc.test.ts` — Pi runtime RPC contract, idempotency, terminal conflict, and no duplicate wake tests pass.
- `pnpm pi-package:check` — Shepherd Pi extension package validation passes.
- `pnpm check` — repository typecheck, tests, Biome, and Drizzle check pass.
- `pnpm build` — run because this plan changes import/export surfaces in `src/gateway` and `src/platforms`; expected to pass.

## Risks, Tradeoffs, and Open Questions

- `pi.turn.started` uses append-only `inputEventIds`. Steer messages that arrive after turn start are related by `user.message.payload.piTurnId`, not by updating `inputEventIds`.
- `#existingPiTerminal()` uses idempotency-key lookups instead of paginated event scans. A dedicated turn table is unnecessary for MVP unless future query patterns need indexed turn listings.
- Slack progress bubbles remain in the thread by design. This preserves breadcrumbs and avoids adding Slack delete scopes.
- `pi.stream_segment_break` may initially be a no-op if generic segment support is not added to Slack streaming in the same task. It must still return a clear `{ streamed: false, reason: "segment_break_not_supported" }` response rather than pretending success.
- `tool_progress: verbose` intentionally remains sanitized and does not show raw args/result. This differs from Hermes' more detailed raw-args verbose behavior but matches Shepherd's Slack safety requirements.
- The Pi extension cannot update prior events if a later hook discovers better metadata. Keep later metadata in subsequent lifecycle events.
- Archived plans may mention old `gateway.stream_*` and `gateway.complete_run` RPCs. Leave archived docs unchanged unless the user asks for historical cleanup.
