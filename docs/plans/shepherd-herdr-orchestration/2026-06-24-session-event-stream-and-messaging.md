# Shepherd Session Event Stream and Messaging Sync

Date: 2026-06-24

Parent: [Shepherd Herdr Orchestration Plan](../2026-06-24-shepherd-herdr-orchestration.md)

## Goal

Define the source-of-truth event model and how TUI and messaging platforms stay synchronized.

## Implementation status

Status as of commit `f8d2766`: core event stream, TUI sync, Slack sync, delivery, queueing, and recovery MVP are implemented.

Implemented:

- SQLite tables and stores for sessions, session bindings, events, gateway runs, actors, delivery receipts, working contexts, Herdr bindings, logical tool calls, and session summaries.
- ordered event stream with idempotency keys, replay cursors, and live Unix socket subscriptions.
- TUI client/CLI surface for `send`, `watch`, `rename`, `audit`, approval request, and approval response.
- Slack Socket Mode inbound normalization, thread/session binding, allowlists, and duplicate inbound event handling.
- outbound Slack delivery through delivery fanout, delivery receipts, and `chat:write.customize` presentation when enabled.
- per-session gateway turn queueing with concurrent sessions allowed.
- daemon restart recovery that marks queued/running gateway runs as `recovery_required` and emits recovery note events.
- side-effect idempotency for delivery receipts, event appends, summary updates, and logical tool calls.
- approval request/response events delivered to subscribed TUI clients and platform fanout.

MVP limits:

- Approval responses are recorded and delivered in Shepherd, but provider/worker-agent-specific callback routing is deferred.
- TUI reconnect behavior is supported by replay cursors, but there is no full-screen TUI application yet.
- Herdr state events are represented through logical tool events and wait/read results; a dedicated Herdr event subscription stream is deferred.

## Source of truth

Shepherd DB is the source of truth, not Slack and not Herdr.

Initial tables:

- `sessions`
  - Shepherd session id, title, status, working context id, timestamps
- `session_bindings`
  - session id, platform, channel/chat id, thread/topic id, message ids, TUI client bindings
- `events`
  - ordered event stream, including stable event ids and idempotency keys for externally visible actions
- `gateway_runs`
  - one gateway turn/run per Shepherd session at a time, with status, triggering event ids, and recovery metadata
- `actors`
  - user, Shepherd bot, gateway LLM, Herdr agent, system
- `delivery_receipts`
  - event id, platform, target, remote message id, status
- `working_contexts`
  - slug, label, path, detection metadata, Herdr named session name
- `herdr_bindings`
  - Shepherd session id, Herdr session name, workspace id, created/attached metadata

## Event stream

The event stream records:

- user messages
- gateway assistant messages
- gateway logical tool calls
- gateway logical tool results
- Herdr state events
- structured Herdr progress signals
- approval requests
- delivery events
- summary updates
- errors and recovery notes

All user-visible messages are stored as Shepherd events first, then delivered to subscribed surfaces.

## Gateway turn concurrency

MVP allows only one active gateway turn per Shepherd session.

- Incoming user messages are always persisted to the event stream first.
- If no gateway turn is active for the session, the message wakes a new gateway turn.
- If a gateway turn is already active, the message is marked `queued` for that session.
- Queued messages are processed in event order after the active turn reaches a safe terminal state.
- MVP does not support mid-turn steer or interrupt for user messages.
- TUI and Slack should show that a message was queued instead of silently dropping or merging it.

Different Shepherd sessions may run concurrently.

## Messaging and TUI sync

MVP surfaces:

- TUI
- Slack

Behavior:

- A new Slack thread creates a Shepherd session.
- A TUI `/resume` selects an existing Shepherd session and replays its event stream.
- While TUI is attached, new Slack messages appear in TUI automatically.
- TUI-originated user messages are stored in the same event stream and delivered to Slack.
- Slack-originated user messages are stored in the same event stream and delivered to attached TUI clients.

Cross-surface authorship is a product feature, not a polish item. A message sent from TUI should look like a user-authored message on Slack when the platform supports that safely, and a Slack-originated message should appear in TUI with the same actor identity.

Core events should store platform-neutral actor presentation metadata:

- actor kind: user, gateway, worker agent, system
- display name
- avatar/icon reference
- source platform and source user id when available
- whether presentation was mirrored, labeled fallback, or platform-native

## TUI daemon transport

The TUI connects to the local Shepherd daemon over a Unix domain socket.

- Use newline-delimited JSON-RPC/JSON Lines framing.
- The same connection carries request/response commands and subscribed event stream notifications.
- TUI clients authenticate through local socket permissions in MVP; no remote TUI transport is required.
- A TUI client sends its last seen event id when attaching or reconnecting.
- The daemon replays missed events from SQLite before streaming live events.
- If the daemon restarts, the TUI reconnects and resumes from the last seen event id.

HTTP/WebSocket management surfaces can be added later, but they are not part of the MVP TUI-daemon path.

## Slack behavior

MVP uses Slack Socket Mode.

Slack details:

- Socket Mode avoids public webhook setup.
- A Slack thread maps to one Shepherd session.
- Platform identity must not leak into Herdr workspace names.
- v1 should use `chat:write.customize` for authorship mirroring when the Slack app has the scope and the message is clearly user-initiated.
- TUI-originated user messages should be posted into Slack with the user's configured display name and avatar, so the Slack thread feels synchronized rather than bot-relayed.
- Gateway and worker-agent narration may also use distinct display names/icons, such as `Shepherd`, `Herdr Claude`, or `Herdr Codex`, while still retaining the canonical actor in Shepherd DB.
- If a workspace has not granted `chat:write.customize`, fall back to bot posting with explicit actor labels.
- Do not use authorship mirroring for surprise/background messages that are not tied to an inciting user action.

Core DB should remain platform-neutral:

- `platform`
- `space_id`
- `thread_id`
- `message_id`
- actor presentation metadata
- platform metadata JSON

Avoid Slack-specific concepts in core tables.

## Future adapters

Design messaging adapters so Discord and Telegram can be added later.

Adapter responsibilities:

- receive platform events
- decide whether the event should enter Shepherd
- normalize platform identifiers
- pass normalized inbound messages to core routing
- deliver outbound Shepherd events to the platform

Core responsibilities:

- session lookup/creation
- event persistence
- gateway wake-up
- per-session gateway turn queueing
- delivery receipts
- dedupe and retry policy where it belongs in Shepherd rather than a platform SDK

## Restart, retry, and idempotency

Shepherd DB is the recovery source of truth after daemon restart.

- On startup, inspect `gateway_runs`, logical tool call events, Herdr bindings, and `delivery_receipts`.
- Active gateway runs from a previous daemon process move to a recovery state before any new work starts.
- Do not automatically replay a gateway turn or logical tool call if it may have already produced an external side effect.
- External side effects require idempotency keys stored before execution:
  - Slack/platform delivery
  - `send_agent_message`
  - `run_pane_command`
  - worker agent start
  - Herdr workspace/tab/pane creation when repeated creation would be visible
- Delivery retry uses `delivery_receipts`; sent remote message ids prevent duplicate sends.
- For uncertain tool calls, write a recovery note event and let the gateway/user decide the next action.
- Pure reads may be retried automatically.
- Queued user messages remain queued and are processed after recovery completes.

## Session grouping

Initial behavior:

- Slack thread -> Shepherd session
- TUI client -> attaches to an existing Shepherd session or starts a new one

Future options can add channel-level or user-level grouping, but MVP should avoid Hermes-style complex admin tiers.

## Delivery

Every outbound platform delivery should produce a `delivery_receipts` row.

Delivery receipt fields should support:

- pending
- sent
- failed
- updated
- skipped
- remote message id
- failure reason

This prevents duplicate sends after daemon restart and allows TUI/Slack to converge on the same event stream.

## Context interaction

Gateway LLM does not receive the full event stream each turn.

Prompt builder uses:

- `session_summary`
- recent user/assistant window
- recent structured Herdr progress signals from `herdr.progress` events
- recent relevant tool/Herdr events
- current user message

Old events remain queryable from DB tools.

## Policy

MVP policy is static YAML plus `/reload-config`.

Policy should cover:

- platform/user/channel allowlists
- working context allowed roots
- gateway logical toolset visibility

MVP approval behavior:

- Shepherd policy performs deterministic allow/deny checks before logical tool execution.
- Provider-native approval requests can enter Shepherd through the approval event surface and are delivered to TUI/Slack when recorded.
- Approval responses are recorded and delivered as Shepherd events. Routing those responses back into provider/agent-specific approval APIs is deferred.
- Shepherd does not implement smart approval or adaptive risk scoring in MVP.

Slack access control should be explicit. Do not let arbitrary workspaces/users create sessions unless configured.
