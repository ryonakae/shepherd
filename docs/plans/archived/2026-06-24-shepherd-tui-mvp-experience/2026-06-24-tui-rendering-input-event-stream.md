# TUI Rendering, Input, and Event Stream UX

Date: 2026-06-24

Parent: [Shepherd TUI MVP Experience Plan](../2026-06-24-shepherd-tui-mvp-experience.md)

## Status

Archived. Superseded. See [Shepherd Pi Runtime Gateway Plan](../2026-06-25-pi-runtime-gateway.md) for the later Pi runtime direction.

## Progress

- **Done** — Historical event rendering, input, and stream UX requirements were captured.
- **Superseded** — Custom Shepherd TUI rendering components should not be implemented from this plan.

## Next steps

- Reuse relevant event formatting and Slack/TUI sync requirements as reference for Pi extension and Slack streaming work.

## Goal

Specify the first full-screen TUI surface for Shepherd using Pi's TUI package as the implementation reference.

The TUI should be light, stable, and event-stream native. It should not become a second gateway implementation. It renders Shepherd events and sends user messages to the daemon.

## Reference

Preferred package:

```ts
import {
  TUI,
  ProcessTerminal,
  Editor,
  Markdown,
  Text,
  Container,
  SelectList,
  matchesKey,
  Key,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
```

Relevant Pi TUI properties to preserve:

- Component interface with `render(width): string[]`.
- Differential rendering instead of full React-style reconciliation.
- `ProcessTerminal` raw-mode handling.
- `Editor` multiline input, paste handling, history, and IME cursor support.
- `matchesKey()` and `Key.*` for terminal key handling.
- Strict line-width handling using `truncateToWidth()` / `wrapTextWithAnsi()`.

Hermes TUI should not be used as the UX model. Hermes remains a gateway architecture reference.

## TUI architecture

Proposed files:

```text
src/tui/app.ts                 # high-level TUI lifecycle
src/tui/components/chat.ts     # message stream component
src/tui/components/header.ts   # header/status component
src/tui/components/footer.ts   # footer/status component
src/tui/event-format.ts        # EventRecord -> display blocks
src/tui/theme.ts               # minimal Shepherd TUI theme
src/tui/session-selector.ts    # resume selector
```

Keep `src/tui/client.ts` as the daemon RPC client.

The TUI app should depend on daemon RPC and event records, not SQLite stores directly.

## Screen layout

Initial layout:

```text
┌ Shepherd ─ session title/id ─ working context ─ daemon status ┐
│ message stream                                                 │
│                                                                │
│ user / gateway / progress / approval events                    │
│                                                                │
├ editor ────────────────────────────────────────────────────────┤
│ user input                                                     │
└ model/gateway status ─ last event id ─ key hints ──────────────┘
```

The exact border style can be simple. The main requirement is stability and readability.

### Header

Show:

- `Shepherd`
- session title or short id
- working context label/path
- connection state: connected, reconnecting, offline

### Message stream

Show events in chronological order.

The stream should preserve scrollback by letting the terminal scroll naturally where possible. A complex virtual scrollback is not required for MVP.

For long sessions, the TUI can render the latest N events after replay and rely on future `/history` or search commands for older content. The daemon still has the full history.

### Editor

Use Pi TUI `Editor`.

Behavior:

- Enter submits when not empty.
- Shift+Enter / Alt+Enter inserts newline per Pi TUI behavior.
- On submit, send `session.user_message` to daemon with a per-message idempotency key.
- Clear editor only after the daemon accepts the message.
- If send fails, keep the text and show an error notification/status.
- For the first message in a Slack auto-bind eligible session, show a sending/binding status while the daemon posts the Slack thread parent and records binding state.

### Footer

Show:

- last seen event id
- gateway state if inferable from events
- queued/running indicator
- key hints: `enter send`, `shift+enter newline`, `/resume`, `/quit`

## Event formatting

The TUI should convert raw events into display blocks. Formatting should be deterministic and unit-tested.

### `user.message`

Display:

- actor display name if available
- source platform if not TUI, for example `Slack / Ryo`
- text payload

TUI-originated user messages should appear immediately through the same subscribed event stream. Avoid a separate optimistic local-only message unless latency becomes a problem.

### `gateway.message`

Display as assistant/gateway message.

Use Markdown rendering for text if stable. If Markdown rendering causes layout issues, start with wrapped text and add Markdown later.

### `gateway.run.started`

Display compact status:

```text
Shepherd started a gateway turn
```

May update footer working indicator.

### `gateway.run.completed`

Display compact status or only update footer. Avoid noisy duplicate messages when a `gateway.message` already contains the useful output.

### `gateway.run.failed`

Display visible error with reason.

### `gateway.tool.call` and `gateway.tool.result`

Default MVP rendering should be compact:

```text
tool ensure_herdr_workspace started
工具 ensure_herdr_workspace completed
```

Show key output fields for Herdr tools when useful, for example workspace id or agent name. Do not dump full JSON into the main stream.

A later inspect view can show raw JSON.

### `herdr.progress`

Display compact progress lines.

Examples:

```text
Herdr agent.status status=idle agent=claude-impl
Herdr workspace.created workspace=shepherd-task-abc123
```

The payload already contains compact `text`; prefer that when available.

### `approval.requested`

Display a clear prompt-like block:

```text
Approval requested by codex: codex-tool-1
<text>
[a] approve  [d] deny
```

MVP can start with display-only if provider callback routing is deferred, but Shepherd already records `approval.respond`. TUI should support approval/deny if the daemon method exists.

### `approval.responded`

Display decision and responder.

### `session.renamed`

Update header and show a small status line.

### `platform.binding_failed`

Display a prominent warning, but do not make it look like an assistant response.

Suggested rendering:

```text
Slack binding failed: <reason>
Continuing this session as TUI-only.
```

This event is persistent so it appears after `/resume` and in audit output. It is operational state for the user, not gateway context.

### Recovery and error events

Display prominently. These events usually require user/gateway judgment.

## Input handling

Global keys:

- Ctrl+C:
  - If editor has text, clear editor.
  - If editor is empty and pressed twice within a short window, exit.
- Ctrl+D: exit when editor is empty.
- Escape: close overlay/selector; otherwise no-op for MVP.
- Ctrl+L: optional future session selector or redraw.

Editor slash commands:

- `/quit`: exit TUI.
- `/new`: create new cwd-bound session.
- `/resume`: open session selector.
- `/rename <title>`: rename current session.

Future slash commands, not required for MVP:

- `/bind slack`: explicitly bind the current session to Slack.
- `/retry-bind slack`: retry a failed automatic Slack binding.

Slash command implementation can be simple string handling before sending a message. Full autocomplete can use Pi TUI's autocomplete later.

## Resume selector

Use `SelectList` from `@earendil-works/pi-tui`.

Item label should include:

- title or first preview
- working context label
- updated time
- platform binding hint if available

Example:

```text
Review Slack sync              shepherd        10m ago   slack:C123
session-abcdef                 mog-app         2h ago
```

Controls:

- Up/down navigate.
- Enter attach.
- Escape cancel and return to current session.

When selecting a session:

1. Unsubscribe/close current client subscription if needed.
2. Attach to selected session.
3. Replay events from 0 or from cached last id if already known.
4. Update header/footer.

For MVP, restarting the TUI app state on selection is acceptable if simpler.

## Reconnect behavior

The TUI should survive daemon restarts if practical.

Minimum MVP:

- On socket close, show `reconnecting` status.
- Keep the current session id and latest seen event id.
- Retry connection periodically with a bounded backoff.
- On reconnect, call `session.subscribe` with `afterEventId = latestSeenEventId`.
- Render missed events and resume live stream.

If daemon autostart owns restart behavior, the TUI can attempt autostart again after a connection loss, but this should avoid respawn loops.

## Queue/running display

The current daemon queues gateway turns per session. The TUI should make queued/running visible instead of silently accepting input.

MVP approach:

- Infer running state from `gateway.run.started` / terminal event.
- If a user submits while running, still send the message because daemon persists and queues it.
- Show a footer hint like `message queued` when the next relevant event indicates queueing, if such an event exists.

If the event stream lacks explicit queued events, add one later rather than guessing in the TUI.

## Theming

Start with a minimal internal theme:

- user: accent
- gateway: normal text / markdown
- progress: dim
- success: green
- warning: yellow
- error: red
- border/status: muted

Avoid large theme infrastructure in the first implementation. If Shepherd later supports themes, use the same component boundaries.

## Performance rules

Follow Pi TUI rules:

- Every rendered line must fit the provided width.
- Cache formatted lines where useful.
- Invalidate caches on state changes.
- Avoid reformatting the full event history on every keypress.
- Keep raw event data separate from rendered lines.

A simple structure:

```ts
type DisplayEvent = {
  eventId: number;
  linesByWidth: Map<number, string[]>;
  event: WireEventRecord;
};
```

The stream component can cache per width and clear only when events change or terminal width changes.

## Testing

Unit-test pure formatting:

- user message with TUI presentation
- user message from Slack presentation
- gateway message markdown/text
- herdr progress payload text
- approval requested/responded
- long lines are truncated or wrapped to width

Component tests can use a fake terminal if practical, but pure formatting tests are enough for initial confidence.

Manual smoke tests are required because raw-mode terminal behavior is hard to cover fully:

1. Start from cwd with `shepherd`.
2. Verify header shows cwd working context.
3. Send single-line message.
4. Send multiline message.
5. Receive gateway events.
6. Open `/resume` and cancel.
7. With Slack `tui_default_channel` configured, send the first TUI message and verify Slack parent creation, binding, and no duplicate thread reply.
8. Reply in the Slack thread as an allowed user and verify the TUI receives the message and gateway wakes.
9. Exit TUI; daemon remains alive.
10. Reopen with `--session` and verify replay.

## Deferred

- Full session tree/branch UI like Pi.
- File reference autocomplete with `@`.
- Image paste.
- Collapsible tool output.
- Raw JSON event inspector.
- Theme files.
- Mouse support.
- Explicit `/bind slack` and `/retry-bind slack` commands.
- Gateway abort/interrupt UI.

## Open questions

1. Should the MVP TUI render Markdown from `gateway.message`, or use plain wrapped text first?
2. Should approval request handling be interactive in the first TUI implementation?
3. How much event history should the TUI render after replay by default?
4. Should slash commands be part of MVP, or should the first version rely only on CLI flags?
