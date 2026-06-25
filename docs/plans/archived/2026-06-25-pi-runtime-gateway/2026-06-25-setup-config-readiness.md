# Setup, Config, and Pi Readiness

Date: 2026-06-25

Parent: [Shepherd Pi Runtime Gateway Plan](../2026-06-25-pi-runtime-gateway.md)

## Status

Done.

## Progress

- **Done** — Setup command shape decided: `brew install shepherd` and `pi install npm:shepherd-pi`.
- **Done** — Dedicated `shepherd setup` and `shepherd doctor` are deferred for MVP.
- **Done** — Gateway startup should fail fast when Pi readiness fails.
- **Done** — Config schema accepts `gateway.pi` and Slack streaming settings; old provider fields remain accepted only as a temporary legacy path for existing tests/compatibility.
- **Done** — Pi readiness probe launches `pi --mode rpc --no-session`, waits for Gateway `pi.handshake`, and requires `get_available_models` to return at least one model before Slack starts.

## Next steps

Complete. The Pi runtime path uses readiness checks, stable Gateway identity, `shepherd-pi` package validation, and skips old provider runtime construction when only `gateway.pi` is configured.

## Distribution

Expected user setup:

```bash
brew install shepherd
pi install npm:shepherd-pi
```

The `shepherd-pi` Pi package must be installed in the user's Pi environment. Missing extension means setup is incomplete.

## Config changes

### Remove Shepherd-owned LLM provider config

Remove or deprecate these config concepts from the active Pi runtime config shape:

```yaml
gateway:
  default_provider: codex
  model: gpt-5.3-codex
  provider_overrides: ...

providers:
  codex: ...
  openai: ...
  anthropic: ...
  openrouter: ...
```

Pi owns provider authentication, model selection, OAuth/API key storage, and model switching through normal Pi settings.

### Add Pi supervisor config

Use `gateway.pi` rather than `gateway.runtime: pi`; Pi is the only planned runtime.

```yaml
gateway:
  pi:
    idle_timeout_ms: 600000
    readiness_timeout_ms: 10000
```

Initial defaults:

- `idle_timeout_ms`: 10 minutes.
- `readiness_timeout_ms`: 10 seconds.

### Keep Herdr agent config

Keep Shepherd-owned Herdr worker profile config:

```yaml
default_agent: implementer
agents:
  implementer:
    command: codex
    args: []
    when: "Use for implementation, test fixes, and CLI-heavy coding work."
```

The Gateway/tool backend owns these profiles. The Pi extension reads tool/profile metadata from the Gateway and injects concise guidance into Pi's prompt context.

### Add Slack streaming config

Add under `platforms.slack`:

```yaml
platforms:
  slack:
    streaming:
      enabled: true
      edit_interval_ms: 750
      buffer_threshold_chars: 40
      cursor: " ▉"
      tool_progress: off # off | compact | verbose
```

Tool progress defaults to `off` for Slack, following Hermes' Slack default.

## Gateway readiness check

`shepherd gateway start` must verify Pi readiness before starting Slack Socket Mode.

Startup checks:

1. Resolve Shepherd config, DB path, socket path, and Gateway identity.
2. Verify `pi` exists on `PATH`.
3. Launch a short-lived readiness process:
   ```bash
   pi --mode rpc --no-session
   ```
4. Wait for a `shepherd-pi` extension handshake.
5. Call Pi RPC `get_available_models` and require at least one available model.
6. Stop the readiness process.
7. Start Slack and normal Gateway services only after success.

Failure examples:

```text
Shepherd Pi extension is not installed.

Install it with:
  pi install npm:shepherd-pi

Then restart:
  shepherd gateway start
```

```text
Pi has no available authenticated model.

Run:
  pi
  /login
```

## CLI behavior

The Gateway requires Pi readiness. CLI-only commands can remain Pi-independent:

- `shepherd audit`
- config parsing helpers
- future read-only inspection commands

## Tests

- Config accepts `gateway.pi` and rejects/ignores old provider shape according to migration policy.
- Missing `pi` command fails Gateway startup with actionable message.
- Missing extension handshake fails Gateway startup.
- Empty `get_available_models` fails Gateway startup.
- Successful readiness probe allows Gateway startup.
