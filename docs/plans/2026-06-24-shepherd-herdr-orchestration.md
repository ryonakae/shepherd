# Shepherd Herdr Orchestration Plan

Date: 2026-06-24

## Goal

Shepherd is a lightweight orchestration gateway for Herdr-managed agents.

Users talk to Shepherd from a TUI or messaging platforms such as Slack. Shepherd stores the conversation and orchestration state, then controls Herdr sessions, workspaces, tabs, panes, and agents. The gateway LLM acts as a Herdr control-plane operator. It should not become a general coding agent; implementation work is delegated to agents and terminals running inside Herdr panes.

## Product direction

Shepherd differs from Hermes Agent in two ways:

1. Herdr is the execution surface. Shepherd orchestrates real terminal panes, coding agents, logs, tests, and shells inside Herdr.
2. TUI and messaging platforms share the same live Shepherd session event stream. A user can move between Slack and TUI without manual continuation, and messages/events appear in both surfaces in real time.

The local TUI talks to the Shepherd daemon over a Unix domain socket using newline-delimited JSON-RPC/JSON Lines. TUI clients attach with a last seen event id so the daemon can replay missed SQLite events before live streaming.

Hermes, Pi, OpenCode, NanoClaw, and NemoClaw are implementation references. Shepherd should keep the implementation smaller and focused on Herdr orchestration.

## Plan structure

This file is the parent plan. Detailed decisions live in child plans:

- [Herdr control-plane mapping](shepherd-herdr-orchestration/2026-06-24-herdr-control-plane.md)
- [Gateway providers, Herdr agents, and context](shepherd-herdr-orchestration/2026-06-24-gateway-providers-agents-context.md)
- [Session event stream and messaging sync](shepherd-herdr-orchestration/2026-06-24-session-event-stream-and-messaging.md)
- [Architecture references](shepherd-herdr-orchestration/2026-06-24-architecture-references.md)
- [MVP implementation roadmap](shepherd-herdr-orchestration/2026-06-24-implementation-roadmap.md)

## Core decisions

### Source of truth

Shepherd DB is the source of truth, not Slack and not Herdr.

Initial tables:

- `sessions`
- `session_bindings`
- `events`
- `gateway_runs`
- `actors`
- `delivery_receipts`
- `working_contexts`
- `herdr_bindings`

The `events` table is the ordered event stream for user messages, assistant messages, gateway logical tool calls/results, Herdr state events, approval requests, and delivery events.

MVP runs at most one gateway turn per Shepherd session. New user messages arriving while a turn is active are persisted and queued in event order; they are handled after the active turn reaches a safe terminal state. Different Shepherd sessions may run concurrently.

Daemon restart recovery is conservative. Shepherd inspects DB state on startup, does not automatically replay gateway/tool work that may have produced external side effects, uses idempotency keys for deliveries and Herdr-affecting logical tools, and emits recovery note events when user or gateway judgment is needed.

### Working context

A working context is the filesystem or project area where work should happen. It is not necessarily a Git repository.

Resolution order:

1. explicit configured catalog
2. previous Shepherd DB bindings and recent working contexts
3. allowed roots scan
4. user clarification when ambiguous

Allowed root scanning must be opt-in. Shepherd must not scan the whole home directory by default.

### Herdr mapping

```text
working context
  -> Herdr named session: shepherd-<working-context-slug>

Shepherd session
  -> Herdr workspace: shepherd-<task-slug>-<short-id>

Herdr tabs
  -> agents / tests / logs / review / scratch

Herdr panes
  -> actual terminals, coding agents, test runners, dev servers
```

One working context gets one Herdr named session. Multiple Shepherd sessions for the same working context become separate Herdr workspaces inside that named session.

Shepherd uses Herdr's named-session CLI lifecycle to ensure/create the `shepherd-<working-context-slug>` session, then uses the Herdr socket API for normal workspace, tab, pane, agent, and event operations. Shepherd should not directly manage `herdr server` processes in MVP.

### Gateway LLM role

The gateway LLM is a Herdr control-plane operator.

It may:

- resolve working contexts
- inspect Herdr sessions, workspaces, tabs, panes, and agents
- create Shepherd-managed Herdr sessions/workspaces/tabs/panes
- start agents in panes
- send prompts/input to agents or panes
- wait for Herdr agent status changes
- read pane/agent output
- summarize Herdr results back to the user

It should not:

- directly edit project files outside Herdr
- directly run implementation commands outside Herdr
- act as the main coding agent
- attach to existing non-Shepherd Herdr sessions/workspaces unless the user explicitly asks

### Gateway providers

Shepherd should support multiple gateway LLM providers. The provider registry/config/auth policy is owned by Shepherd. The actual LLM request implementation can use AI SDK provider packages as replaceable internals.

MVP providers:

- `codex` via `ai-sdk-provider-codex-cli` `codexAppServer`
- `openrouter`
- `openai`
- `anthropic`

Shepherd must not depend on Vercel AI Gateway or a Vercel account.

For the Codex gateway, Shepherd uses a Hermes-style internal `shepherd-tools` stdio callback to expose curated Shepherd/Herdr orchestration tools to the Codex app-server runtime. This is an implementation detail, not a user-facing MCP integration surface.

Gateway tools are provider-independent Shepherd logical tools. Shepherd owns the tool registry, policy checks, execution, event logging, and result projection; each provider adapter only translates those tools to its own transport.

### Herdr agents

Herdr agents are user-environment command profiles, not provider abstractions. Shepherd starts them through Herdr and sends task messages; the agent runtime owns its own auth, local config, and tool behavior.

`default_agent` is required. `agents` is a map keyed by agent name.

```yaml
default_agent: implementer

agents:
  implementer:
    command: codex
    args: []
    when: "Use for implementation, test fixes, and CLI-heavy coding work."

  reviewer:
    command: claude
    args: []
    when: "Use for careful review and architecture critique."
```

`when` is read only by the gateway LLM. It is not sent to the worker agent.

### Context management

Shepherd DB stores the full session history. Gateway turns receive a compact active context:

- stable system prompt
- session metadata
- configured agents and `when` descriptions
- `session_summary`
- recent user/assistant window
- recent structured Herdr progress signals
- recent relevant tool/Herdr events
- current user message

Long histories are summarized with threshold-based `session_summary` updates. MVP uses the gateway provider for summary generation, with `auxiliary.summary` schema reserved for future model overrides.

Long-running Herdr progress is surfaced as gateway-authored conversational narration. The daemon provides compact structured progress signals; the gateway prompt tells the LLM to speak at meaningful milestones such as implementation start/finish, review start/results, handoff, blocked state, or completion.

### Messaging scope

MVP platforms:

- TUI
- Slack

Discord and Telegram should be possible later through adapter abstraction. Core DB fields should stay platform-neutral.

Cross-surface authorship is a core UX goal. TUI-originated user messages should look user-authored on Slack when allowed by Slack scopes and user intent, using `chat:write.customize` with a safe fallback to bot messages plus actor labels. Other messaging adapters should expose the same platform-neutral actor presentation capability where possible.

### Policy

Use static YAML plus `/reload-config` for MVP.

Policy combines:

- platform/user/channel allowlists
- working context allowed roots
- gateway logical toolset visibility

MVP approval handling is limited to deterministic policy gates plus provider-native approval forwarding. Shepherd records approval requests/responses and delivers them to TUI/Slack, but it does not make smart approval decisions.

Avoid Hermes-style plugin hooks, smart approval, and complex admin tiers in the first version.
