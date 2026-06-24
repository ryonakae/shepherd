# Shepherd MVP Implementation Roadmap

Date: 2026-06-24

Parent: [Shepherd Herdr Orchestration Plan](../2026-06-24-shepherd-herdr-orchestration.md)

## Goal

Break the Shepherd MVP into implementation phases while preserving the design decisions from the parent and child plans.

## Phase 0: Implementation foundation

Deliverables:

- `mise` tool versions for Node.js latest LTS and pnpm latest stable
- single TypeScript package setup
- ESM + `NodeNext` TypeScript configuration
- Vitest unit and integration test setup
- Biome linting, formatting, and import organization
- Husky pre-commit hook
- lint-staged staged-file Biome auto-fix
- strict pre-commit quality gate:
  - typecheck
  - tests
  - full Biome check
  - Drizzle migration/schema consistency check
- SQLite foundation with `node:sqlite` and Drizzle
- generated SQL migrations committed to the repo
- TypeBox + Ajv runtime schema validation foundation
- initial real tested utility, not a placeholder test

Rules:

- Keep the repo as a single package for MVP.
- Do not include Markdown docs in the Biome gate.
- Use Drizzle as a typed SQL/schema layer, not as a way to hide recovery or idempotency SQL.
- Use TypeBox/Ajv for JSON Schema first runtime contracts and logical tool schemas.
- Keep external Herdr, Slack, and gateway provider SDKs out of the foundation commit unless they are required by the first tested scaffold.

## Phase 1: Core daemon and DB

Deliverables:

- SQLite schema
- event store
- config loader
- `/reload-config`
- basic daemon command
- Unix domain socket listener for local TUI clients
- newline-delimited JSON-RPC/JSON Lines protocol
- TUI event subscription, replay cursor, and reconnect handling

Schema areas:

- sessions
- session_bindings
- events
- gateway_runs
- logical tool call idempotency keys
- actors
- delivery_receipts
- working_contexts
- herdr_bindings
- session_summary storage or summary events

Config areas:

- gateway provider registry
- `gateway.default_provider`
- `gateway.model`
- `providers.*`
- `default_agent`
- `agents.*`
- `context.*`
- `auxiliary.summary`
- platform allowlists
- working context allowed roots
- deterministic logical tool policy gates
- provider-native approval forwarding and event recording

## Phase 2: Herdr integration

Deliverables:

- named session resolution
- Herdr named-session CLI lifecycle for ensure/create
- Herdr socket client wrapper
- create/list/get workspace
- create/list/get tab
- create/list/read/send pane
- start/list/get/read/send/focus agent
- event subscription or polling for agent status
- Shepherd-managed naming
- `send_agent_message` high-level tool using `pane.send_input`

Rules:

- Use `agent.start` for configured agents.
- Use `pane` APIs for tests, logs, shells, and servers.
- Do not attach to non-Shepherd Herdr resources unless the user explicitly asks.
- Record Herdr bindings in Shepherd DB.

## Phase 3: Gateway LLM runner

Deliverables:

- Shepherd provider registry
- AI SDK-backed provider adapters
  - Codex app-server via `ai-sdk-provider-codex-cli`
  - OpenRouter
  - OpenAI
  - Anthropic
- provider selection from `gateway.default_provider`
- env-only API key resolution for API-key providers
- Codex app-server process lifecycle
- stateless Codex app-server calls using Shepherd DB history
- internal `shepherd-tools` stdio callback for Codex app-server
- provider-independent Shepherd logical tool registry
- provider adapter translation from logical tools to provider wire format
- policy-based toolset selection
- layered prompt builder
- context window builder
- structured Herdr progress signals for gateway narration
- threshold-based `session_summary` update
- Herdr orchestration tools

Initial gateway tools:

- `session_read`
- `workspace_discovery`
- `herdr_read`
- `resolve_working_context`
- `ensure_herdr_workspace`
- `ensure_agent_pane`
- `start_agent`
- `open_pane`
- `run_pane_command`
- `read_pane`
- `wait_for_herdr_event`
- `send_agent_message`
- `wait_for_agent`
- `read_agent_output`
- gateway progress narration for long-running Herdr agents

## Phase 4: Herdr agent profiles

Deliverables:

- `default_agent` required validation
- `agents` map validation
- Herdr-side `$PATH` command resolution by `agent.start`
- no preflight `command -v`
- `when` descriptions included in gateway prompt
- default agent fallback when no `when` matches
- task handoff prompt guidance

Example:

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

## Phase 5: Slack MVP

Deliverables:

- Slack Socket Mode adapter
- thread-to-session creation
- session event delivery to Slack
- Slack messages mirrored into DB
- TUI resume/live sync with Slack session
- delivery receipts and duplicate-send prevention
- per-session gateway turn queueing
- Slack authorship mirroring with `chat:write.customize` and fallback actor labels
- platform/user/channel allowlist checks

Implemented so far:

- outbound Slack delivery through Web API `chat.postMessage`
- Slack thread/session binding store
- Slack message event normalization and DB append path
- session delivery fanout with Slack echo prevention
- daemon delivery publication hook
- Bolt Socket Mode wrapper for Slack message events
- Slack platform config schema using environment variable names for tokens
- CLI daemon wiring for Slack runtime, delivery fanout, and daemon-backed inbound messages
- local session client plus `shepherd send` / `shepherd watch` for TUI-style attach and resume
- startup recovery notes for queued/running gateway runs without automatic replay
- API-key backed gateway providers for OpenAI, Anthropic, and OpenRouter
- recent event context builder for gateway turns
- threshold-based `session_summary` updates and summary-aware gateway context
- Herdr named-session CLI lifecycle wrapper before socket requests
- plan-name Herdr logical tools for pane run/read/open and wait operations
- allowed-root working context discovery and resolution tools
- persisted logical tool idempotency records with completed-result reuse
- session title rename flow through daemon RPC and CLI
- basic SQLite event audit log through `shepherd audit`

Slack behavior:

- new Slack thread creates a Shepherd session
- TUI can resume the same session
- TUI-originated messages are delivered to Slack with mirrored user presentation when possible
- Slack-originated messages appear in TUI

## Phase 6: Attach and polish

Deliverables:

- explicit attach to existing Herdr session/workspace
- title/rename flow
- conservative daemon restart recovery from DB
- recovery notes for uncertain in-flight gateway/tool work
- clearer tool errors for Herdr command start failures
- gateway progress narration for long-running Herdr agents

## Deferred

- session/channel/message provider override
- full Hermes-style auxiliary model suite
- `codexExec` fallback for Codex gateway
- Pi/OpenCode-style direct Codex OAuth Responses provider
- direct `openai-oauth` integration
- arbitrary npm provider package loading
- Discord / Telegram adapters
- complex admin tiers and smart approval
- sandbox/network policy beyond static YAML
