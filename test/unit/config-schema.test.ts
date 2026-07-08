import { describe, expect, test } from "vitest";
import { parseShepherdConfig } from "@/config/schema.js";

describe("Shepherd config schema", () => {
  test("accepts minimal observability config with runtime paths", () => {
    const result = parseShepherdConfig({
      observability: { telemetry: { max_excerpt_bytes: 2048 } },
      runtime: {
        db_path: "data/state.db",
        log_path: "logs/shepherd.log",
        pid_path: "shepherd.pid",
        socket_path: "shepherd.sock",
      },
    });

    expect(result.ok).toBe(true);
  });

  test("defaults telemetry excerpt limit", () => {
    const result = parseShepherdConfig({ observability: { telemetry: {} } });
    expect(result).toMatchObject({
      ok: true,
      value: { observability: { telemetry: { max_excerpt_bytes: 4096 } } },
    });
  });

  test("rejects unknown top-level config surfaces", () => {
    for (const config of [
      { old_agents: { enabled: true } },
      { providers: { example: {} } },
      { orchestration: { queue: {} } },
    ]) {
      const result = parseShepherdConfig(config);
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(result.errors.some((error) => error.keyword === "additionalProperties")).toBe(true);
    }
  });

  test("rejects unknown runtime and observability keys", () => {
    expect(parseShepherdConfig({ runtime: { extra: "nope" } }).ok).toBe(false);
    expect(parseShepherdConfig({ observability: { retention: { days: 7 } } }).ok).toBe(false);
  });
});
