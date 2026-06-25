import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { readOrCreateGatewayId } from "@/gateway/identity.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("readOrCreateGatewayId", () => {
  test("creates and reuses a stable gateway id", () => {
    const dir = mkdtempSync(join(tmpdir(), "shepherd-gateway-id-"));
    tempDirs.push(dir);

    const first = readOrCreateGatewayId(dir);
    const second = readOrCreateGatewayId(dir);

    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).toBe(first);
  });
});
