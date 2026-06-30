import { describe, expect, test } from "vitest";
import { parseShepherdConfig } from "@/config/schema.js";

describe("Shepherd config schema", () => {
  test("accepts Pi gateway config with a default agent that exists", () => {
    const result = parseShepherdConfig(minimalConfig());

    expect(result.ok).toBe(true);
  });

  test("rejects configs without any configured agents", () => {
    const result = parseShepherdConfig(minimalConfig({ agents: {} }));

    expect(result.ok).toBe(false);
  });

  test("rejects a default agent that is not configured", () => {
    const result = parseShepherdConfig(
      minimalConfig({
        agents: {
          reviewer: {
            command: "claude",
          },
        },
        default_agent: "implementer",
      }),
    );

    expect(result.ok).toBe(false);
  });

  test("accepts Slack platform config with env-backed tokens and streaming settings", () => {
    const result = parseShepherdConfig(
      minimalConfig({
        platforms: {
          slack: {
            allow_customize: true,
            allowed_channels: ["C123"],
            allowed_teams: ["T123"],
            allowed_users: ["U123"],
            app_token_env: "SLACK_APP_TOKEN",
            bot_token_env: "SLACK_BOT_TOKEN",
            streaming: {
              buffer_threshold_chars: 40,
              cursor: " ▉",
              edit_interval_ms: 750,
              enabled: true,
              tool_progress: "off",
            },
            tui_default_channel: "C123",
          },
        },
      }),
    );

    expect(result.ok).toBe(true);
  });

  test("rejects Slack platform config without allowed users", () => {
    const result = parseShepherdConfig(
      minimalConfig({
        platforms: {
          slack: {
            allowed_channels: ["C123"],
            app_token_env: "SLACK_APP_TOKEN",
            bot_token_env: "SLACK_BOT_TOKEN",
          },
        },
      }),
    );

    expect(result.ok).toBe(false);
  });

  test("rejects a Slack TUI default channel outside the allowed channel list", () => {
    const result = parseShepherdConfig(
      minimalConfig({
        platforms: {
          slack: {
            allowed_channels: ["C123"],
            allowed_users: ["U123"],
            app_token_env: "SLACK_APP_TOKEN",
            bot_token_env: "SLACK_BOT_TOKEN",
            tui_default_channel: "C999",
          },
        },
      }),
    );

    expect(result.ok).toBe(false);
  });

  test("rejects removed provider config surfaces", () => {
    const gateway = {
      pi: {
        idle_timeout_ms: 600_000,
        readiness_timeout_ms: 10_000,
      },
    };
    for (const override of [
      { providers: { openai: { api_key_env: "OPENAI_API_KEY", type: "openai" } } },
      { gateway: { ...gateway, default_provider: "openai" } },
      { gateway: { ...gateway, model: "gpt-5.3" } },
      {
        gateway: {
          ...gateway,
          provider_overrides: { sessions: { "session-1": { provider: "openai" } } },
        },
      },
    ]) {
      const result = parseShepherdConfig(minimalConfig(override));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((error) => error.keyword === "additionalProperties")).toBe(true);
      }
    }
  });

  test("accepts runtime path overrides", () => {
    const result = parseShepherdConfig(
      minimalConfig({
        runtime: {
          db_path: "data/state.db",
          log_path: "logs/gateway.log",
          pid_path: "gateway.pid",
          socket_path: "gateway.sock",
        },
      }),
    );

    expect(result.ok).toBe(true);
  });

  test("rejects unknown runtime path keys", () => {
    const result = parseShepherdConfig(
      minimalConfig({
        runtime: {
          db_path: "data/state.db",
          extra: "nope",
        },
      }),
    );

    expect(result.ok).toBe(false);
  });

  test("rejects literal Slack tokens in platform config", () => {
    const result = parseShepherdConfig(
      minimalConfig({
        platforms: {
          slack: {
            app_token: "xapp-secret",
            app_token_env: "SLACK_APP_TOKEN",
            bot_token_env: "SLACK_BOT_TOKEN",
          },
        },
      }),
    );

    expect(result.ok).toBe(false);
  });
});

function minimalConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agents: {
      implementer: {
        args: [],
        command: "codex",
        when: "Use for implementation work.",
      },
    },
    default_agent: "implementer",
    gateway: {
      pi: {
        idle_timeout_ms: 600_000,
        readiness_timeout_ms: 10_000,
      },
    },
    ...overrides,
  };
}
