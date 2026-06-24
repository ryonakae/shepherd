import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { applyMigrations } from "@/db/apply-migrations.js";
import { openSqlite } from "@/db/client.js";
import { WorkingContextStore } from "@/db/working-contexts.js";
import { WorkingContextResolver } from "@/gateway/working-contexts.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("WorkingContextResolver", () => {
  test("resolves allowed paths into stored working contexts", () => {
    const { root, store } = openHarness();
    const project = join(root, "shepherd");
    mkdirSync(project);
    const resolver = new WorkingContextResolver({
      allowedRoots: [root],
      store,
    });

    const context = resolver.resolve({
      label: "Shepherd",
      path: project,
    });

    expect(context).toMatchObject({
      herdrSessionName: "shepherd-shepherd",
      label: "Shepherd",
      path: project,
      slug: "shepherd",
    });
    expect(resolver.resolve({ slug: "shepherd" })).toEqual(context);
  });

  test("does not scan allowed roots unless explicitly requested", () => {
    const { root, store } = openHarness();
    mkdirSync(join(root, "api"));
    const resolver = new WorkingContextResolver({
      allowedRoots: [root],
      store,
    });

    expect(resolver.discover()).toMatchObject({
      allowedRoots: [root],
      candidates: [],
      recent: [],
    });
    expect(resolver.discover({ scanAllowedRoots: true }).candidates).toEqual([
      { label: "api", path: join(root, "api") },
    ]);
  });

  test("rejects paths outside allowed roots", () => {
    const { root, store } = openHarness();
    const resolver = new WorkingContextResolver({
      allowedRoots: [join(root, "allowed")],
      store,
    });

    expect(() => resolver.resolve({ path: join(root, "outside") })).toThrow(
      "outside allowed roots",
    );
  });
});

function openHarness(): {
  root: string;
  store: WorkingContextStore;
} {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-working-contexts-"));
  tempDirs.push(dir);
  const dbDir = join(dir, "db");
  const root = join(dir, "root");
  mkdirSync(dbDir);
  mkdirSync(root);

  const { sqlite } = openSqlite(join(dbDir, "test.sqlite"));
  applyMigrations(sqlite, { migrationsFolder: "drizzle" });

  return {
    root,
    store: new WorkingContextStore(sqlite),
  };
}
