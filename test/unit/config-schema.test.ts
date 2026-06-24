import { describe, expect, test } from "vitest";
import { parseShepherdConfig } from "@/config/schema.js";

describe("Shepherd config schema", () => {
  test("accepts a default agent that exists in the configured agent map", () => {
    const result = parseShepherdConfig({
      agents: {
        implementer: {
          args: [],
          command: "codex",
          when: "Use for implementation work.",
        },
      },
      default_agent: "implementer",
    });

    expect(result.ok).toBe(true);
  });

  test("rejects configs without any configured agents", () => {
    const result = parseShepherdConfig({
      agents: {},
      default_agent: "implementer",
    });

    expect(result.ok).toBe(false);
  });

  test("rejects a default agent that is not configured", () => {
    const result = parseShepherdConfig({
      agents: {
        reviewer: {
          command: "claude",
        },
      },
      default_agent: "implementer",
    });

    expect(result.ok).toBe(false);
  });
});
