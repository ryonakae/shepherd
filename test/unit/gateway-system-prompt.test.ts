import { describe, expect, test } from "vitest";
import { buildGatewaySystemPrompt } from "@/gateway/system-prompt.js";

describe("buildGatewaySystemPrompt", () => {
  test("describes Herdr control-plane behavior and progress narration", () => {
    const prompt = buildGatewaySystemPrompt({
      projectName: "Shepherd",
    });

    expect(prompt).toContain("Shepherd");
    expect(prompt).toContain("Herdr");
    expect(prompt).toContain("progress");
    expect(prompt).toContain("gateway");
  });
});
