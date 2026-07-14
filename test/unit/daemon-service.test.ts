import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { resolveMigrationsFolder } from "@/daemon/service.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

describe("daemon service", () => {
  test("finds migrations from the package root instead of the launch cwd", () => {
    const root = mkdtempSync(join(tmpdir(), "shepherd-daemon-service-"));
    tempDirs.push(root);
    const moduleDir = join(root, "dist", "src", "daemon");
    const migrationsFolder = join(root, "drizzle");
    mkdirSync(moduleDir, { recursive: true });
    mkdirSync(join(migrationsFolder, "meta"), { recursive: true });
    writeFileSync(join(migrationsFolder, "meta", "_journal.json"), "{}\n");

    expect(resolveMigrationsFolder(moduleDir)).toBe(migrationsFolder);
  });
});
