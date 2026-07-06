import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { loadShepherdConfig } from "@/config/load.js";
import { parseShepherdConfig } from "@/config/schema.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("Shepherd config loader", () => {
  test("loads a valid observability runtime YAML config", () => {
    const path = writeTempConfig(`
runtime:
  db_path: data/state.db
  socket_path: shepherd.sock
  pid_path: shepherd.pid
  log_path: logs/shepherd.log
observability:
  telemetry:
    max_excerpt_bytes: 2048
`);

    const result = loadShepherdConfig(path);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.runtime?.db_path).toBe("data/state.db");
      expect(result.value.runtime?.socket_path).toBe("shepherd.sock");
      expect(result.value.observability?.telemetry?.max_excerpt_bytes).toBe(2048);
    }
  });

  test("rejects unknown config fields", () => {
    const result = parseShepherdConfig({ providers: { example: {} }, workers: { enabled: true } });

    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.errors.some((error) => error.keyword === "additionalProperties")).toBe(true);
  });

  test("returns YAML parse errors without throwing", () => {
    const path = writeTempConfig("runtime: [");

    const result = loadShepherdConfig(path);

    expect(result.ok).toBe(false);
  });
});

function writeTempConfig(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-config-"));
  tempDirs.push(dir);

  const path = join(dir, "shepherd.yaml");
  writeFileSync(path, contents);

  return path;
}
