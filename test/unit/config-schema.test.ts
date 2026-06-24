import { describe, expect, test } from "vitest";
import { parseShepherdConfig } from "@/config/schema.js";

describe("Shepherd config schema", () => {
  test("accepts a default agent that exists in the configured agent map", () => {
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

  test("accepts Slack platform config with env-backed tokens", () => {
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
          },
        },
      }),
    );

    expect(result.ok).toBe(true);
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
      default_provider: "codex",
      model: "gpt-5.3-codex",
    },
    providers: {
      codex: {
        auth_source: "codex_cli",
        mode: "app_server",
        type: "codex_cli",
      },
    },
    ...overrides,
  };
}
