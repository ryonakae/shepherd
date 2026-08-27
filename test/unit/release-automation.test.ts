import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const prepareReleaseScript = new URL("../../scripts/prepare-release.mjs", import.meta.url);
const fixtureRoots: string[] = [];
const releasePaths = [
  "package.json",
  "packages/shepherd-pi/package.json",
  "packages/shepherd-herdr-plugin/package.json",
  "packages/shepherd-herdr-plugin/herdr-plugin.toml",
  "README.md",
  "README.ja.md",
  "packages/shepherd-herdr-plugin/README.md",
];

async function createReleaseFixture(version = "0.5.0"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shepherd-release-"));
  fixtureRoots.push(root);
  await mkdir(join(root, "packages/shepherd-pi"), { recursive: true });
  await mkdir(join(root, "packages/shepherd-herdr-plugin"), { recursive: true });

  for (const path of [
    "package.json",
    "packages/shepherd-pi/package.json",
    "packages/shepherd-herdr-plugin/package.json",
  ]) {
    await writeFile(join(root, path), `${JSON.stringify({ name: path, version }, null, 2)}\n`);
  }

  await writeFile(
    join(root, "packages/shepherd-herdr-plugin/herdr-plugin.toml"),
    `id = "shepherd.agents"\nversion = "${version}"\n`,
  );

  for (const path of ["README.md", "README.ja.md", "packages/shepherd-herdr-plugin/README.md"]) {
    await writeFile(
      join(root, path),
      `herdr plugin install ryonakae/shepherd/packages/shepherd-herdr-plugin --ref v${version} --yes\n`,
    );
  }

  return root;
}

async function runPrepare(root: string, ...args: string[]) {
  return execFileAsync(process.execPath, [prepareReleaseScript.pathname, ...args], {
    cwd: root,
  });
}

async function readReleaseFiles(root: string): Promise<Map<string, string>> {
  return new Map(
    await Promise.all(
      releasePaths.map(async (path) => [path, await readFile(join(root, path), "utf8")] as const),
    ),
  );
}

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("release preparation", () => {
  test("keeps repository release references synchronized", async () => {
    const root = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { scripts?: Record<string, string>; version: string };
    expect(root.scripts?.["release:prepare"]).toBe("node scripts/prepare-release.mjs");

    for (const path of [
      "packages/shepherd-pi/package.json",
      "packages/shepherd-herdr-plugin/package.json",
    ]) {
      const manifest = JSON.parse(
        await readFile(new URL(`../../${path}`, import.meta.url), "utf8"),
      ) as { version: string };
      expect(manifest.version).toBe(root.version);
    }

    const pluginToml = await readFile(
      new URL("../../packages/shepherd-herdr-plugin/herdr-plugin.toml", import.meta.url),
      "utf8",
    );
    expect(pluginToml.match(/^version = "([^"]+)"$/m)?.[1]).toBe(root.version);
    for (const path of ["README.md", "README.ja.md", "packages/shepherd-herdr-plugin/README.md"]) {
      const readme = await readFile(new URL(`../../${path}`, import.meta.url), "utf8");
      expect([...readme.matchAll(/--ref v([^ ]+) --yes/g)].map((match) => match[1])).toEqual([
        root.version,
      ]);
    }
  });

  test("updates every release-owned version reference", async () => {
    const root = await createReleaseFixture();

    await runPrepare(root, "0.6.0");

    for (const path of [
      "package.json",
      "packages/shepherd-pi/package.json",
      "packages/shepherd-herdr-plugin/package.json",
    ]) {
      const manifest = JSON.parse(await readFile(join(root, path), "utf8")) as {
        version: string;
      };
      expect(manifest.version).toBe("0.6.0");
    }

    await expect(
      readFile(join(root, "packages/shepherd-herdr-plugin/herdr-plugin.toml"), "utf8"),
    ).resolves.toContain('version = "0.6.0"');
    for (const path of ["README.md", "README.ja.md", "packages/shepherd-herdr-plugin/README.md"]) {
      await expect(readFile(join(root, path), "utf8")).resolves.toContain("--ref v0.6.0 --yes");
    }
  });

  test("rejects a divergent manifest before writing any file", async () => {
    const root = await createReleaseFixture();
    const divergentPath = "packages/shepherd-pi/package.json";
    await writeFile(
      join(root, divergentPath),
      `${JSON.stringify({ name: divergentPath, version: "0.4.0" }, null, 2)}\n`,
    );
    const before = await readReleaseFiles(root);

    const error = await runPrepare(root, "0.6.0").catch((reason: unknown) => reason);

    expect(error).toMatchObject({ stderr: expect.stringContaining(divergentPath) });
    expect(await readReleaseFiles(root)).toEqual(before);
  });

  test("rejects a missing TOML version before writing any file", async () => {
    const root = await createReleaseFixture();
    const path = "packages/shepherd-herdr-plugin/herdr-plugin.toml";
    await writeFile(join(root, path), 'id = "shepherd.agents"\n');
    const before = await readReleaseFiles(root);

    const error = await runPrepare(root, "0.6.0").catch((reason: unknown) => reason);

    expect(error).toMatchObject({ stderr: expect.stringContaining(path) });
    expect(await readReleaseFiles(root)).toEqual(before);
  });

  test("rejects duplicate README references before writing any file", async () => {
    const root = await createReleaseFixture();
    const path = "README.md";
    const original = await readFile(join(root, path), "utf8");
    await writeFile(join(root, path), `${original}${original}`);
    const before = await readReleaseFiles(root);

    const error = await runPrepare(root, "0.6.0").catch((reason: unknown) => reason);

    expect(error).toMatchObject({ stderr: expect.stringContaining(path) });
    expect(await readReleaseFiles(root)).toEqual(before);
  });

  test.each([
    ["v prefix", ["v0.6.0"]],
    ["incomplete version", ["0.6"]],
    ["prerelease", ["0.6.0-beta.1"]],
    ["build metadata", ["0.6.0+build.1"]],
    ["leading zero", ["01.2.3"]],
    ["extra argument", ["0.6.0", "extra"]],
  ])("rejects %s without changing release files", async (_label, args) => {
    const root = await createReleaseFixture();
    const before = await readReleaseFiles(root);

    await expect(runPrepare(root, ...args)).rejects.toThrow();

    expect(await readReleaseFiles(root)).toEqual(before);
  });
});
