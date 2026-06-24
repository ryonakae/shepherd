# Shepherd Architecture References

Date: 2026-06-24

Parent: [Shepherd Herdr Orchestration Plan](../2026-06-24-shepherd-herdr-orchestration.md)

## Goal

Record which existing systems Shepherd should learn from, and what not to copy.

## Implementation status

Status as of 2026-06-24 latest `main`: reference decisions have been applied to the MVP implementation.

Applied:

- Hermes-inspired gateway/provider/session-summary shape, while keeping Herdr as the execution surface.
- Pi/OpenCode-inspired provider registry, `default_agent`, and `when` agent descriptions.
- Herdr-first terminal/workspace/agent orchestration through named sessions and socket APIs.
- NanoClaw-style platform adapter separation and delivery router with platform identifiers mapped to Shepherd sessions.
- NemoClaw-style conservative policy/recovery mindset, without adding sandbox lifecycle machinery to MVP.
- AI SDK provider packages for OpenAI, Anthropic, OpenRouter, and Codex app-server.

Deferred by design:

- complex plugin hooks, smart approval, admin tiers, full dashboard machinery, arbitrary npm provider loading, direct Codex OAuth Responses integration, and sandbox/network policy systems.

## Hermes Agent

Hermes is the primary reference for:

- gateway process and messaging platforms
- session persistence and resume
- layered system prompt: stable / context / volatile
- provider registry and auth handling
- auxiliary models
- context compression
- Slack/Discord/Telegram-style gateway UX

Ideas to borrow:

- DB-backed full session history with active context window
- provider registry with API-key and OAuth providers
- `auxiliary` task model slots
- summary/compression only when context pressure requires it
- prompt assembly that avoids mutating the stable prompt unnecessarily

Things not to copy into Shepherd MVP:

- Hermes as the execution runtime
- general coding-agent behavior in the gateway LLM
- complex plugin hooks, smart approval, admin tiers, and full dashboard machinery
- Hermes TUI design

## Pi

Pi is a reference for:

- SDK/model registry pieces
- TUI packages if useful
- custom provider extension shape
- provider config that separates API shape from model metadata
- OAuth provider callbacks and credential storage patterns

Ideas to borrow:

- provider config with explicit API type
- replaceable custom providers
- OAuth login/refresh/getApiKey abstraction
- model capability metadata

Things not to copy into Shepherd MVP:

- making Shepherd gateway a full Pi coding agent
- direct project editing tools in the gateway LLM

## OpenCode

OpenCode is a reference for:

- provider configuration with many AI SDK providers
- custom provider config using npm provider packages
- agent definitions with description/prompt/tool metadata
- default agent concept

Ideas to borrow:

- map-style named agents
- `default_agent`
- `when`/description text for gateway agent selection
- provider options such as `baseURL`, `apiKey`, `headers`, model maps

Things not to copy into Shepherd MVP:

- exposing arbitrary npm provider package loading in Shepherd config
- making Herdr worker agents part of the gateway provider registry
- OpenCode's internal agent model as Shepherd's core abstraction

## Herdr

Herdr is not just a reference; it is Shepherd's execution surface.

Herdr facts that shape Shepherd:

- panes are real terminals
- agents are recognized processes inside panes
- `agent.start` is the correct API for terminals that should be agent targets
- `pane` APIs are correct for tests, logs, shells, servers, and low-level input
- Herdr server owns process state; clients can detach while processes continue
- named sessions are separate runtime namespaces
- socket API exposes workspace/tab/pane/agent/event control

## NanoClaw

NanoClaw is relevant as a compact messaging-agent host architecture, not as Shepherd's gateway LLM runner.

Useful ideas:

- channel adapters return platform-level identifiers; core routing maps those IDs to internal sessions
- DB-backed message routing before delivery or agent wake-up
- explicit separation between shared conversation, same agent with separate sessions, and separate agent groups
- scheduled work represented as message rows rather than a separate scheduler subsystem
- outbound delivery through a host-side delivery router with per-platform capability fallback

Things not to copy into Shepherd MVP:

- per-session Docker containers as the primary execution model; Herdr already owns execution surfaces
- Claude Code / Claude Agent SDK as the default worker model
- customization-by-code-change as the main configuration mechanism

## NemoClaw

NemoClaw is relevant as a sandbox lifecycle and policy reference, not as Shepherd's core framework.

Useful ideas later:

- host-owned credentials and gateway-mediated inference/network access
- deny-by-default network policy with operator-visible approval flow
- versioned blueprint/policy artifacts for reproducible sandbox setup
- clear separation between host CLI, sandbox runtime integration, and provider routing

Things not to copy into Shepherd MVP:

- OpenShell sandbox orchestration as the core runtime; Shepherd's runtime target is Herdr
- heavyweight onboarding, blueprint, and sandbox lifecycle machinery
- provider/inference routing inside a sandbox unless Shepherd later adds isolated worker environments

## AI SDK and Codex providers

AI SDK is useful as an implementation layer, not the Shepherd architecture boundary.

Use initially:

- OpenRouter provider package
- OpenAI provider package
- Anthropic provider package
- `ai-sdk-provider-codex-cli` for Codex app-server gateway

For Codex app-server tool access, expose a curated Shepherd/Herdr tool subset while keeping Shepherd as the policy and execution owner. The MVP implementation uses the AI SDK executable tool bridge; a Hermes-style internal callback can replace the transport later without changing Shepherd logical tools.

Do not depend on:

- Vercel AI Gateway
- Vercel account

`EvanZhouDev/openai-oauth` is a useful optional proxy/reference, but not a core dependency for MVP because it is unofficial, AGPL-licensed, and directly targets ChatGPT/Codex backend endpoints.

Pi/OpenCode-style direct Codex OAuth Responses integration remains a future experiment, not the MVP path.
