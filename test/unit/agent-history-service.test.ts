import { describe, expect, test } from "vitest";
import { cacheSourcePathForRef } from "@/agent-history/service.js";
import type { AgentHistoryRef } from "@/observability/contracts.js";

describe("agent history service", () => {
  test("uses session-specific cache keys for OpenCode DB refs", () => {
    const first: AgentHistoryRef = {
      kind: "discovered_file",
      path: "/tmp/opencode.db",
      source: "opencode-sqlite",
      value: "session-a",
    };
    const second: AgentHistoryRef = {
      kind: "discovered_file",
      path: "/tmp/opencode.db",
      source: "opencode-sqlite",
      value: "session-b",
    };

    expect(cacheSourcePathForRef(first)).toBe("/tmp/opencode.db#session=session-a");
    expect(cacheSourcePathForRef(second)).toBe("/tmp/opencode.db#session=session-b");
  });

  test("uses file path cache keys for file-backed refs", () => {
    expect(
      cacheSourcePathForRef({
        kind: "discovered_file",
        path: "/tmp/codex.jsonl",
        source: "codex-jsonl",
        value: "/tmp/codex.jsonl",
      }),
    ).toBe("/tmp/codex.jsonl");
  });
});
