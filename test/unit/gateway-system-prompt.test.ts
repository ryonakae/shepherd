import { describe, expect, test } from "vitest";
import { buildGatewaySystemPrompt } from "@/gateway/system-prompt.js";

describe("buildGatewaySystemPrompt", () => {
  test("describes Herdr control-plane behavior and progress narration", () => {
    const prompt = buildGatewaySystemPrompt({
      agents: {
        implementer: {
          command: "codex",
          when: "Use for implementation and test fixes.",
        },
        reviewer: {
          command: "claude",
          when: "Use for review.",
        },
      },
      defaultAgent: "implementer",
      projectName: "Shepherd",
    });

    expect(prompt).toContain("Shepherd");
    expect(prompt).toContain("Herdr");
    expect(prompt).toContain("progress");
    expect(prompt).toContain("gateway");
    expect(prompt).toContain("explicitly asks");
    expect(prompt).toContain("Default Herdr agent profile: implementer");
    expect(prompt).toContain("reviewer: Use for review.");
  });
});
