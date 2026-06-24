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
