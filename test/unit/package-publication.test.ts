import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

type PackageManifest = {
  files?: string[];
  name: string;
  private?: boolean;
  publishConfig?: { access?: string };
  repository?: { directory?: string; type?: string; url?: string };
  scripts?: Record<string, string>;
  version: string;
};

async function readManifest(relativePath: string): Promise<PackageManifest> {
  return JSON.parse(
    await readFile(new URL(relativePath, import.meta.url), "utf8"),
  ) as PackageManifest;
}

describe("npm publication metadata", () => {
  test("keeps public packages scoped and the Herdr integration private", async () => {
    const root = await readManifest("../../package.json");
    const pi = await readManifest("../../packages/shepherd-pi/package.json");
    const herdr = await readManifest("../../packages/shepherd-herdr-plugin/package.json");
    const pluginToml = await readFile(
      new URL("../../packages/shepherd-herdr-plugin/herdr-plugin.toml", import.meta.url),
      "utf8",
    );
    const pluginVersion = /^version = "([^"]+)"$/m.exec(pluginToml)?.[1];

    expect(root.name).toBe("@ryonakae/shepherd");
    expect(root.files).toEqual(["dist", "drizzle"]);
    expect(root.publishConfig?.access).toBe("public");
    expect(root.scripts).toMatchObject({
      "clean:dist": "node scripts/clean-dist.mjs",
      "package:check": "node scripts/check-root-package.mjs",
      prepack: "pnpm build",
    });
    expect(root.scripts?.build).toContain("pnpm clean:dist");
    expect(root.scripts?.check).toContain("pnpm package:check");

    expect(pi.name).toBe("@ryonakae/shepherd-pi");
    expect(pi.files).toEqual(["src"]);
    expect(pi.publishConfig?.access).toBe("public");
    expect(pi.repository).toEqual({
      type: "git",
      url: "git+https://github.com/ryonakae/shepherd.git",
      directory: "packages/shepherd-pi",
    });

    expect(herdr.private).toBe(true);
    expect(pluginVersion).toBeDefined();
    expect(new Set([root.version, pi.version, herdr.version, pluginVersion])).toEqual(
      new Set([root.version]),
    );
  });
});
