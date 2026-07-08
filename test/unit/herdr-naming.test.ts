import { describe, expect, test } from "vitest";
import {
  herdrSessionNameForWorkingContext,
  herdrWorkspaceNameForTask,
  slugifyHerdrName,
  validateHerdrName,
} from "@/herdr/naming.js";

describe("Herdr naming", () => {
  test("creates Shepherd-managed Herdr names", () => {
    expect(herdrSessionNameForWorkingContext("My Project")).toBe("shepherd-my-project");
    expect(herdrWorkspaceNameForTask("Review Agent Sync", "abc123")).toBe(
      "shepherd-review-agent-sync-abc123",
    );
  });

  test("keeps names within Herdr's 64 byte limit", () => {
    const name = herdrSessionNameForWorkingContext("a".repeat(120));

    expect(Buffer.byteLength(name, "utf8")).toBeLessThanOrEqual(64);
    expect(() => validateHerdrName(name)).not.toThrow();
  });

  test("rejects names with unsupported characters", () => {
    expect(slugifyHerdrName("Agent thread / deploy")).toBe("agent-thread-deploy");
    expect(() => validateHerdrName("agent/thread")).toThrow("Invalid Herdr name");
  });
});
