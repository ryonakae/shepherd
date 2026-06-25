import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { readOrCreateDaemonId } from "@/daemon/identity.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("readOrCreateDaemonId", () => {
  test("creates and reuses a stable daemon id", () => {
    const dir = mkdtempSync(join(tmpdir(), "shepherd-daemon-id-"));
    tempDirs.push(dir);

    const first = readOrCreateDaemonId(dir);
    const second = readOrCreateDaemonId(dir);

    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).toBe(first);
  });
});
