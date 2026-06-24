# Shepherd Gateway Providers, Herdr Agents, and Context

Date: 2026-06-24

Parent: [Shepherd Herdr Orchestration Plan](../2026-06-24-shepherd-herdr-orchestration.md)

## Goal

Define how Shepherd configures the gateway LLM, Herdr worker agents, and conversation context.

## Implementation status

Status as of commit `f8d2766`: core gateway/provider/context MVP is implemented, with provider-specific bridges deferred where noted.

Implemented:

- config schema for provider registry, `gateway.default_provider`, `gateway.model`, `providers.*`, `default_agent`, `agents.*`, `context.allowed_roots`, and `auxiliary.summary`.
- Codex app-server provider factory through `ai-sdk-provider-codex-cli`, plus OpenAI, Anthropic, and OpenRouter API-key providers.
- environment-only API key lookup for API-key providers.
- provider-independent logical tool registry converted to AI SDK tools with TypeBox/Ajv runtime validation.
- gateway prompt builder with Herdr control-plane role, progress narration guidance, default agent, and `when` descriptions.
- recent event context builder and threshold-based `session_summary` updates.
- Herdr orchestration tools listed below, including `herdr_read`, attach, pane text send, waits, and agent messaging.
- deterministic tool visibility/policy gates and logical tool call/result/denial events.
- approval request/response event surface in the daemon/TUI/delivery layer.

MVP limits:

- The dedicated Hermes-style `shepherd-tools` stdio helper is not a separate binary; MVP uses the AI SDK executable tool bridge around the same Shepherd logical tools.
- Provider-native approval requests can be recorded and delivered as Shepherd events, but response plumbing back into Codex app-server or worker-agent-specific approval APIs is deferred.
- `auxiliary.summary` is reserved in config, but summary generation currently uses the gateway provider/model.
- Rich Herdr progress detection is prompt and event-context based, not a separate auxiliary progress model.

## Gateway LLM role

The gateway LLM is a Herdr control-plane operator. It decides how to use Shepherd and Herdr tools. It is not the main coding agent.

It may:

- resolve working contexts
- inspect Herdr sessions, workspaces, tabs, panes, and agents
- create Shepherd-managed Herdr resources
- start agents in panes
- send prompts/input to agents or panes
- wait for Herdr agent status changes
- read pane/agent output
- summarize Herdr results back to the user

It should not:

- directly edit project files outside Herdr
- directly run implementation commands outside Herdr
- act as the main coding agent
- attach to non-Shepherd Herdr resources without explicit user instruction

## Provider architecture

Shepherd owns:

- provider registry
- config schema
- provider selection
- auth source policy
- toolset policy
- Shepherd logical tool registry
- gateway prompt
- Herdr tool execution

AI SDK provider packages can implement requests and streaming behind Shepherd's provider interface. They are replaceable implementation details. Shepherd must not depend on Vercel AI Gateway or a Vercel account.

## Shepherd logical tools

Gateway tools are provider-independent Shepherd logical tools. Shepherd owns the tool names, descriptions, JSON Schemas, policy checks, execution, DB event logging, and result projection.

Provider adapters only translate the same logical tool registry into provider-specific wire formats:

- Codex app-server uses the MVP AI SDK executable tool bridge. A standalone internal `shepherd-tools` stdio callback remains an implementation option after MVP.
- OpenAI, OpenRouter, and Anthropic use normal function/tool calling through their AI SDK-backed adapters.
- A future direct Codex OAuth Responses provider would use normal Responses function tools.

The gateway prompt and policy should describe the same logical tool surface regardless of provider. Do not create Codex-only and OpenAI-only tool definitions unless a provider cannot represent a tool at all.

"High-level tools" does not mean the gateway LLM cannot operate Herdr. It means the gateway LLM operates Herdr through Shepherd-owned orchestration tools rather than raw Herdr socket methods. Shepherd remains responsible for binding validation, policy, event logging, and translating each logical tool into the appropriate Herdr CLI/socket calls.

Provider capabilities:

- `tool_transport: codex_app_server_callback | function_tools | none`
- `supports_tool_calling: true | false`

MVP gateway providers must support tool calling. Providers with `tool_transport: none` are planner-only and should not be selected as the default gateway provider.

## MVP gateway providers

```yaml
gateway:
  default_provider: codex
  model: gpt-5.3-codex

providers:
  codex:
    type: codex_cli
    mode: app_server
    auth_source: codex_cli
    settings:
      minCodexVersion: "0.130.0"
      approvalPolicy: on-failure
      sandboxPolicy:
        type: readOnly

  openrouter:
    type: openrouter
    api_key_env: OPENROUTER_API_KEY

  openai:
    type: openai
    api_key_env: OPENAI_API_KEY

  anthropic:
    type: anthropic
    api_key_env: ANTHROPIC_API_KEY
```

Decisions:

- `providers` is a map.
- `gateway.default_provider` is required.
- MVP uses `default_provider` and `model`; session/channel/message model switching is later.
- API-key providers read credentials from environment variables only.
- Do not allow API key literals in config for MVP.
- Codex OAuth reads the Shepherd daemon user's existing Codex CLI login.
- Gateway Codex auth and Herdr worker Codex auth are separate when Shepherd and Herdr run on different machines.
- `approvalPolicy` configures provider-native approval behavior where the provider supports it. Shepherd has an approval event surface for recording and delivery; provider-specific response plumbing is deferred.

## Codex gateway provider

Use `ai-sdk-provider-codex-cli` as the initial implementation.

MVP mode:

- `codexAppServer`, not `codexExec`
- persistent Codex app-server process inside the Shepherd daemon
- stateless calls by default
- Shepherd DB provides conversation history each turn
- Codex `threadId` may be stored as provider metadata but is not the source of truth

Rationale:

- The target UX is close to talking with Hermes on Slack using Codex GPT.
- `codexExec` is simpler but slower and usually emits final text in one chunk.
- `codexAppServer` fits a daemon and supports better streaming.

Important limitation:

- Codex CLI providers do not use normal AI SDK custom tools the same way API providers do.
- MVP uses the same Shepherd logical tool registry through the AI SDK tool bridge. A later Codex-specific `shepherd-tools` stdio callback can replace this transport without changing logical tool definitions.
- Any callback remains an implementation detail, not a user-facing MCP integration surface.
- Do not let Codex operate directly on the Shepherd daemon environment.

Initial Shepherd logical tools:

- `resolve_working_context`
- `session_read`
- `workspace_discovery`
- `herdr_read`
- `ensure_herdr_workspace`
- `ensure_agent_pane`
- `start_agent`
- `open_pane`
- `run_pane_command`
- `read_pane`
- `send_pane_text`
- `wait_for_herdr_event`
- `send_agent_message`
- `wait_for_agent`
- `read_agent_output`
- gateway progress narration for long-running Herdr agents

Do not expose through the Shepherd logical tool bridge:

- generic shell/file/edit tools already owned by Codex or worker agents
- arbitrary Herdr raw socket methods
- non-Shepherd Herdr resources unless the user explicitly attached them

`run_pane_command` is allowed only inside Shepherd-managed Herdr panes. It is for tests, dev servers, logs, and controlled terminal workflows; it is not a general Shepherd-daemon shell escape.

## External OAuth proxy option

`EvanZhouDev/openai-oauth` is useful as a reference or optional external proxy:

- It reads `~/.codex/auth.json` / `$CODEX_HOME/auth.json`.
- It exposes `/v1/responses`, `/v1/chat/completions`, and `/v1/models`.
- It also provides an AI SDK provider.

Do not make it a core dependency in MVP:

- license is `AGPL-3.0-only`
- it is unofficial and uses ChatGPT/Codex backend endpoints directly
- it depends on AI SDK internal APIs

Users can still run it separately and configure Shepherd as an OpenAI-compatible provider later.

## Direct Codex OAuth Responses option

A Pi/OpenCode-style direct Codex OAuth Responses provider is a useful future experiment:

- Shepherd would own ChatGPT OAuth token storage and refresh.
- Shepherd/Herdr tools would be passed as normal Responses function tools.
- It avoids the Codex app-server tool callback, but directly targets ChatGPT/Codex backend endpoints and carries more maintenance risk.

Do not make this the MVP default. Keep `codexAppServer` plus Shepherd logical tools as the MVP path.

## Herdr worker agents

Herdr agents are command profiles. They are not gateway LLM provider definitions.

`default_agent` is required. `agents` is a map keyed by name.

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
    when: "Use for careful code review, architecture critique, and design feedback."
```

Rules:

- `command` is resolved by the Herdr server side `$PATH`.
- Shepherd does not preflight `command -v`; it tries `agent.start` and reports failures.
- `args` is an argv array.
- `when` is only for the gateway LLM. It is not sent to the worker agent.
- If no `when` clearly matches, use `default_agent`.
- Ask the user only when agent choice materially changes risk, cost, or expected outcome.

## Worker handoff

Gateway LLM sends a worker task through `send_agent_message`, not raw Herdr APIs.

Task prompts are flexible, but the gateway prompt should recommend this shape when useful:

- Goal
- Working context / cwd
- Relevant constraints
- Expected output or done criteria
- How to report back

Do not include empty sections or boilerplate that adds no value.

## Context management

Shepherd DB stores full history. Gateway LLM receives active context only.

Sent to Gateway LLM:

- stable prompt
- session metadata
- configured agents and `when`
- `session_summary`
- recent user/assistant window
- recent relevant tool/Herdr events
- current user message

Fetched on demand:

- old messages
- old tool results
- Herdr pane logs
- full Herdr state

MVP context strategy:

- `session_summary` updates manually or when thresholds are exceeded.
- recent window is bounded by message count and rough token budget.
- Hermes-style full compression engine is later.

Example config:

```yaml
context:
  recent_window:
    max_messages: 40
    max_tokens: 24000
  summary:
    enabled: true
    update_threshold_tokens: 32000
```

## Auxiliary models

MVP includes auxiliary schema but uses only `summary`.

```yaml
auxiliary:
  summary:
    provider: auto
    model: ""
    timeout: 120
```

`auto` means gateway provider/model for MVP.

Future slots can include:

- `title`
- `herdr_progress`
- `slack_digest`

Hermes has many auxiliary slots such as compression, vision, web extract, approval, session search, and curator. Shepherd should add only slots that map to Shepherd needs.

## Prompt structure

Borrow Hermes' layered prompt idea, but keep it small.

```text
stable:
  - Shepherd identity and role
  - Herdr control-plane rules
  - non-implementation boundary
  - policy/toolset summary
  - platform rendering hint

context:
  - Shepherd session metadata
  - platform binding metadata
  - working context binding
  - Herdr named session/workspace binding
  - configured agents + when
  - session summary

volatile:
  - current user message
  - current Herdr state summary
  - recent structured Herdr progress signals
  - recent relevant events
  - pending decisions
```

Avoid large catalogs in the system prompt. Use tools to search working contexts and Herdr state on demand.

## Progress narration

User-facing progress should be authored by the gateway LLM as short conversational narration, not generated from daemon templates and not streamed as raw Herdr logs.

The daemon only provides lightweight structured progress signals and small relevant tails, for example:

- agent started or became idle
- task message sent to an agent
- review/test/log pane started
- notable tool result or Herdr state transition
- agent finished, blocked, or needs follow-up

The gateway prompt should instruct the LLM to narrate meaningful milestones:

- say when it starts implementation in a Herdr agent
- say when implementation finishes and review starts
- say review results and the next handoff
- avoid noisy play-by-play for routine pane output
- keep Slack progress terse, while TUI may show richer raw state around the narrated message

This is primarily prompt behavior. Program logic only decides when to wake the gateway for a narration opportunity and what compact structured progress context to include.
