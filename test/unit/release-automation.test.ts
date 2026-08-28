import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import { parse as parseYaml } from "yaml";

const execFileAsync = promisify(execFile);
const prepareReleaseScript = new URL("../../scripts/prepare-release.mjs", import.meta.url);
const verifyReleaseScript = new URL("../../scripts/verify-release-packages.mjs", import.meta.url);
const releaseRegistryScript = new URL("../../scripts/release-registry.mjs", import.meta.url);
const validateReleaseTagScript = new URL("../../scripts/validate-release-tag.mjs", import.meta.url);
const releaseNotesScript = new URL("../../scripts/release-notes.mjs", import.meta.url);
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

async function createChangelogFixture(
  changelog: string,
  packageVersion = "0.6.0",
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shepherd-changelog-"));
  fixtureRoots.push(root);
  await writeFile(join(root, "package.json"), `${JSON.stringify({ version: packageVersion })}\n`);
  await writeFile(join(root, "CHANGELOG.md"), changelog);
  return root;
}

async function runReleaseNotes(root: string, ...args: string[]) {
  return execFileAsync(process.execPath, [releaseNotesScript.pathname, ...args], { cwd: root });
}

async function createArtifactFixture(version = "0.6.0"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shepherd-artifacts-"));
  fixtureRoots.push(root);
  const packages = await Promise.all(
    [
      ["@ryonakae/shepherd", `ryonakae-shepherd-${version}.tgz`, "root tarball"] as const,
      ["@ryonakae/shepherd-pi", `ryonakae-shepherd-pi-${version}.tgz`, "pi tarball"] as const,
    ].map(async ([name, filename, content]) => {
      await writeFile(join(root, filename), content);
      return {
        filename,
        integrity: `sha512-${createHash("sha512").update(content).digest("base64")}`,
        name,
        version,
      };
    }),
  );
  await writeFile(
    join(root, "release-packages.json"),
    `${JSON.stringify({ packages, version }, null, 2)}\n`,
  );
  return root;
}

type RegistryState = "absent" | "conflict" | "expected";
type PublishMode = "ambiguous" | "conflict" | "delayed" | "success";

async function createFakeRegistryHarness(
  artifactRoot: string,
  states: [RegistryState, RegistryState],
  modes: Partial<Record<string, PublishMode>> = {},
) {
  const harness = await mkdtemp(join(tmpdir(), "shepherd-registry-"));
  fixtureRoots.push(harness);
  const manifest = JSON.parse(
    await readFile(join(artifactRoot, "release-packages.json"), "utf8"),
  ) as { packages: Array<{ integrity: string; name: string }> };
  const integrities = Object.fromEntries(
    manifest.packages.map((entry, index) => [
      entry.name,
      states[index] === "expected"
        ? entry.integrity
        : states[index] === "conflict"
          ? "sha512-conflict"
          : null,
    ]),
  );
  const statePath = join(harness, "registry-state.json");
  const logPath = join(harness, "npm-log.jsonl");
  const npmPath = join(harness, "fake-npm.mjs");
  await writeFile(statePath, JSON.stringify({ delays: {}, integrities, modes }));
  await writeFile(logPath, "");
  await writeFile(
    npmPath,
    `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_NPM_LOG_FILE, JSON.stringify(args) + "\\n");
const state = JSON.parse(readFileSync(process.env.FAKE_NPM_STATE_FILE, "utf8"));
if (args[0] === "view") {
  const name = args[1].replace(/@0\\.6\\.0$/, "");
  if ((state.delays[name] ?? 0) > 0) {
    state.delays[name] -= 1;
    writeFileSync(process.env.FAKE_NPM_STATE_FILE, JSON.stringify(state));
    process.stderr.write("npm error code E404\\n");
    process.exit(1);
  }
  const integrity = state.integrities[name];
  if (!integrity) {
    process.stderr.write("npm error code E404\\n");
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(integrity));
} else if (args[0] === "publish") {
  const artifacts = dirname(args[1]);
  const manifest = JSON.parse(readFileSync(join(artifacts, "release-packages.json"), "utf8"));
  const entry = manifest.packages.find((candidate) => candidate.filename === basename(args[1]));
  const mode = state.modes[entry.name] ?? "success";
  state.integrities[entry.name] = mode === "conflict" ? "sha512-conflict" : entry.integrity;
  if (mode === "delayed") state.delays[entry.name] = 1;
  writeFileSync(process.env.FAKE_NPM_STATE_FILE, JSON.stringify(state));
  if (mode === "ambiguous") process.exit(1);
} else {
  process.exit(2);
}
`,
  );
  await chmod(npmPath, 0o755);
  return {
    env: {
      ...process.env,
      FAKE_NPM_LOG_FILE: logPath,
      FAKE_NPM_STATE_FILE: statePath,
      SHEPHERD_NPM_COMMAND: npmPath,
      SHEPHERD_REGISTRY_RETRY_ATTEMPTS: "3",
      SHEPHERD_REGISTRY_RETRY_DELAY_MS: "1",
    },
    logPath,
  };
}

async function readNpmCalls(logPath: string): Promise<string[][]> {
  const log = await readFile(logPath, "utf8");
  return log.trim()
    ? log
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[])
    : [];
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

describe("release artifacts", () => {
  test("accepts exactly the tarballs recorded by the integrity manifest", async () => {
    const root = await createArtifactFixture();

    const { stdout } = await execFileAsync(process.execPath, [verifyReleaseScript.pathname, root]);

    const result = JSON.parse(stdout) as { packages: Array<{ name: string }>; version: string };
    expect(result.version).toBe("0.6.0");
    expect(result.packages.map(({ name }) => name)).toEqual([
      "@ryonakae/shepherd",
      "@ryonakae/shepherd-pi",
    ]);
  });

  test("rejects a tarball changed after its manifest was written", async () => {
    const root = await createArtifactFixture();
    await writeFile(join(root, "ryonakae-shepherd-0.6.0.tgz"), "modified");

    await expect(
      execFileAsync(process.execPath, [verifyReleaseScript.pathname, root]),
    ).rejects.toThrow(/Integrity mismatch/);
  });

  test("rejects files outside the bounded artifact set", async () => {
    const root = await createArtifactFixture();
    await writeFile(join(root, "unexpected.txt"), "unexpected");

    await expect(
      execFileAsync(process.execPath, [verifyReleaseScript.pathname, root]),
    ).rejects.toThrow(/Unexpected release artifacts/);
  });
});

describe("release registry state", () => {
  test("allows only resumable root-before-Pi states", async () => {
    const { assertReleaseState, classifyRegistryState } = (await import(
      releaseRegistryScript.href
    )) as {
      assertReleaseState: (states: [string, string]) => void;
      classifyRegistryState: (actual: string | undefined, expected: string) => string;
    };

    expect(classifyRegistryState(undefined, "sha512-expected")).toBe("absent");
    expect(classifyRegistryState("sha512-expected", "sha512-expected")).toBe("expected");
    expect(classifyRegistryState("sha512-other", "sha512-expected")).toBe("conflict");
    expect(() => assertReleaseState(["absent", "absent"])).not.toThrow();
    expect(() => assertReleaseState(["expected", "absent"])).not.toThrow();
    expect(() => assertReleaseState(["expected", "expected"])).not.toThrow();
    expect(() => assertReleaseState(["absent", "expected"])).toThrow();
    expect(() => assertReleaseState(["conflict", "absent"])).toThrow();
    expect(() => assertReleaseState(["expected", "conflict"])).toThrow();
  });

  test.each([
    ["publishes both absent packages", ["absent", "absent"], ["shepherd", "shepherd-pi"]],
    ["resumes with an absent Pi package", ["expected", "absent"], ["shepherd-pi"]],
    ["skips two matching packages", ["expected", "expected"], []],
  ] as const)("%s", async (_label, states, expectedPublished) => {
    const root = await createArtifactFixture();
    const harness = await createFakeRegistryHarness(root, [...states]);

    await execFileAsync(process.execPath, [releaseRegistryScript.pathname, "publish", root], {
      env: harness.env,
    });

    const published = (await readNpmCalls(harness.logPath)).filter(
      ([command]) => command === "publish",
    );
    expect(
      published.map(([, path]) =>
        path
          ?.split("/")
          .at(-1)
          ?.replace(/^ryonakae-/, "")
          .replace(/-0\.6\.0\.tgz$/, ""),
      ),
    ).toEqual(expectedPublished);
    for (const args of published) {
      expect(args.slice(2)).toEqual(["--access", "public", "--provenance"]);
    }
  });

  test.each([
    ["Pi exists before root", ["absent", "expected"]],
    ["root conflicts", ["conflict", "absent"]],
    ["Pi conflicts after a matching root", ["expected", "conflict"]],
    ["Pi conflicts after an absent root", ["absent", "conflict"]],
  ] as const)("rejects %s before publishing", async (_label, states) => {
    const root = await createArtifactFixture();
    const harness = await createFakeRegistryHarness(root, [...states]);

    await expect(
      execFileAsync(process.execPath, [releaseRegistryScript.pathname, "publish", root], {
        env: harness.env,
      }),
    ).rejects.toThrow();

    expect(
      (await readNpmCalls(harness.logPath)).filter(([command]) => command === "publish"),
    ).toEqual([]);
  });

  test.each([
    ["ambiguous", 1],
    ["delayed", 2],
  ] as const)("verifies %s publication results before continuing", async (mode, rootViews) => {
    const root = await createArtifactFixture();
    const harness = await createFakeRegistryHarness(root, ["absent", "absent"], {
      "@ryonakae/shepherd": mode,
    });

    await execFileAsync(process.execPath, [releaseRegistryScript.pathname, "publish", root], {
      env: harness.env,
    });

    const calls = await readNpmCalls(harness.logPath);
    const rootPublish = calls.findIndex(
      ([command, path]) => command === "publish" && path?.includes("shepherd-0.6.0.tgz"),
    );
    const piPublish = calls.findIndex(
      ([command, path]) => command === "publish" && path?.includes("shepherd-pi-0.6.0.tgz"),
    );
    expect(rootPublish).toBeGreaterThan(-1);
    expect(piPublish).toBeGreaterThan(rootPublish);
    expect(
      calls
        .slice(rootPublish + 1, piPublish)
        .filter(
          ([command, specifier]) => command === "view" && specifier === "@ryonakae/shepherd@0.6.0",
        ),
    ).toHaveLength(rootViews);
    expect(calls.slice(piPublish + 1)).toContainEqual([
      "view",
      "@ryonakae/shepherd-pi@0.6.0",
      "dist.integrity",
      "--json",
    ]);
  });

  test("stops before Pi when published root integrity conflicts", async () => {
    const root = await createArtifactFixture();
    const harness = await createFakeRegistryHarness(root, ["absent", "absent"], {
      "@ryonakae/shepherd": "conflict",
    });

    await expect(
      execFileAsync(process.execPath, [releaseRegistryScript.pathname, "publish", root], {
        env: harness.env,
      }),
    ).rejects.toThrow(/integrity conflicts/i);

    const published = (await readNpmCalls(harness.logPath)).filter(
      ([command]) => command === "publish",
    );
    expect(published.map(([, path]) => path?.split("/").at(-1))).toEqual([
      "ryonakae-shepherd-0.6.0.tgz",
    ]);
  });

  test("verifies artifact bytes before reading registry state", async () => {
    const root = await createArtifactFixture();
    const harness = await createFakeRegistryHarness(root, ["absent", "absent"]);
    await writeFile(join(root, "ryonakae-shepherd-0.6.0.tgz"), "modified");

    await expect(
      execFileAsync(process.execPath, [releaseRegistryScript.pathname, "check", root], {
        env: harness.env,
      }),
    ).rejects.toThrow(/Integrity mismatch/);

    expect(await readNpmCalls(harness.logPath)).toEqual([]);
  });
});

describe("release changelog", () => {
  const validChangelog = `# Changelog

## v0.6.0

_2026-08-28_

### Added

- Adds contextual CLI help.

### Removed

- **Breaking:** Removes \`shepherd help\`.

## v0.5.0

### Changed

- Keeps agent identity across renames.
`;

  test("accepts an ordered changelog matching the package version", async () => {
    const root = await createChangelogFixture(validChangelog);

    await expect(runReleaseNotes(root, "check")).resolves.toMatchObject({ stdout: "0.6.0\n" });
    await expect(runReleaseNotes(root, "check", "0.6.0")).resolves.toMatchObject({
      stdout: "0.6.0\n",
    });
  });

  test("requires the package version and latest changelog version to match", async () => {
    const root = await createChangelogFixture(validChangelog, "0.7.0");

    const error = await runReleaseNotes(root, "check").catch((reason: unknown) => reason);

    expect(error).toMatchObject({
      stderr: expect.stringMatching(/latest changelog version 0\.6\.0.*package version 0\.7\.0/i),
    });
  });

  test("requires an explicit release target to be the latest entry", async () => {
    const root = await createChangelogFixture(validChangelog);

    const error = await runReleaseNotes(root, "check", "0.5.0").catch((reason: unknown) => reason);

    expect(error).toMatchObject({
      stderr: expect.stringMatching(/target version 0\.5\.0.*latest changelog version 0\.6\.0/i),
    });
  });

  test.each([
    ["missing target", validChangelog, "0.7.0", /target version 0\.7\.0.*not found/i],
    [
      "duplicate version",
      `${validChangelog}\n## v0.6.0\n\n### Fixed\n\n- Duplicate.\n`,
      "0.6.0",
      /duplicate changelog version 0\.6\.0/i,
    ],
    [
      "out-of-order version",
      validChangelog.replace("## v0.5.0", "## v0.7.0"),
      "0.6.0",
      /strictly descending/i,
    ],
    [
      "unknown category",
      validChangelog.replace("### Added", "### Highlights"),
      "0.6.0",
      /unknown category Highlights/i,
    ],
    [
      "empty category",
      validChangelog.replace("### Added\n\n- Adds contextual CLI help.\n", "### Added\n"),
      "0.6.0",
      /category Added.*at least one bullet/i,
    ],
    [
      "section without a bullet",
      validChangelog.replaceAll(/^- .*$/gm, "Description without a bullet."),
      "0.6.0",
      /category Added.*at least one bullet/i,
    ],
  ])("rejects %s", async (_label, changelog, target, message) => {
    const root = await createChangelogFixture(changelog);

    const error = await runReleaseNotes(root, "check", target).catch((reason: unknown) => reason);

    expect(error).toMatchObject({ stderr: expect.stringMatching(message) });
  });

  test("preserves the breaking marker in extracted release notes", async () => {
    const root = await createChangelogFixture(validChangelog);

    const { stdout } = await runReleaseNotes(root, "render", "0.6.0");

    expect(stdout).toContain("- **Breaking:** Removes `shepherd help`.");
  });
});

describe("release tag validation", () => {
  test.each([
    "v0.5",
    "v0.5.0-beta.1",
    "v01.5.0",
    "0.5.0",
  ])("rejects unsupported tag %s before invoking git", async (tag) => {
    const root = await mkdtemp(join(tmpdir(), "shepherd-tag-"));
    fixtureRoots.push(root);
    await writeFile(join(root, "package.json"), '{"version":"0.5.0"}\n');
    const gitLog = join(root, "git.log");
    await writeFile(gitLog, "");
    const gitPath = join(root, "fake-git.mjs");
    await writeFile(
      gitPath,
      `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(process.env.FAKE_GIT_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
`,
    );
    await chmod(gitPath, 0o755);

    await expect(
      execFileAsync(process.execPath, [validateReleaseTagScript.pathname, tag, "commit"], {
        cwd: root,
        env: {
          ...process.env,
          FAKE_GIT_LOG: gitLog,
          SHEPHERD_GIT_COMMAND: gitPath,
        },
      }),
    ).rejects.toThrow(/Usage: node scripts\/validate-release-tag/);
    expect(await readFile(gitLog, "utf8")).toBe("");
  });

  test("rejects a stable tag whose version differs from package.json", async () => {
    const root = await mkdtemp(join(tmpdir(), "shepherd-tag-"));
    fixtureRoots.push(root);
    await writeFile(join(root, "package.json"), '{"version":"0.5.0"}\n');

    await expect(
      execFileAsync(process.execPath, [validateReleaseTagScript.pathname, "v0.6.0", "commit"], {
        cwd: root,
        env: { ...process.env, SHEPHERD_GIT_COMMAND: join(root, "missing-git") },
      }),
    ).rejects.toThrow(/does not match package version/);
  });

  test.each([
    ["1", true],
    ["0", false],
  ])("checks that the tagged commit belongs to origin/main", async (ancestor, succeeds) => {
    const root = await mkdtemp(join(tmpdir(), "shepherd-tag-"));
    fixtureRoots.push(root);
    await writeFile(join(root, "package.json"), '{"version":"0.5.0"}\n');
    const gitPath = join(root, "fake-git.mjs");
    await writeFile(
      gitPath,
      `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(process.env.FAKE_GIT_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.argv[2] === "merge-base" && process.env.FAKE_GIT_ANCESTOR !== "1") process.exit(1);
`,
    );
    await chmod(gitPath, 0o755);
    const gitLog = join(root, "git.log");
    const invocation = execFileAsync(
      process.execPath,
      [validateReleaseTagScript.pathname, "v0.5.0", "commit"],
      {
        cwd: root,
        env: {
          ...process.env,
          FAKE_GIT_ANCESTOR: ancestor,
          FAKE_GIT_LOG: gitLog,
          SHEPHERD_GIT_COMMAND: gitPath,
        },
      },
    );

    if (succeeds) {
      await expect(invocation).resolves.toMatchObject({ stdout: "0.5.0\n" });
    } else {
      await expect(invocation).rejects.toThrow();
    }
    const calls = (await readFile(gitLog, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls).toEqual([
      ["fetch", "origin", "main:refs/remotes/origin/main", "--no-tags"],
      ["merge-base", "--is-ancestor", "commit", "origin/main"],
    ]);
  });
});

describe("release workflow", () => {
  test("gates trusted publication and release creation behind independent checks", async () => {
    const source = await readFile(
      new URL("../../.github/workflows/release.yml", import.meta.url),
      "utf8",
    );
    type Job = {
      environment?: string;
      needs?: string | string[];
      permissions?: Record<string, string>;
      steps: Array<{ run?: string; uses?: string }>;
    };
    const workflow = parseYaml(source) as {
      jobs: Record<string, Job>;
      on: { push: { tags: string[] } };
      permissions: Record<string, string>;
    };

    expect(workflow.on.push.tags).toEqual(["v*.*.*"]);
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(Object.keys(workflow.jobs)).toEqual([
      "validate",
      "publish",
      "registry-smoke",
      "github-release",
    ]);

    const validate = workflow.jobs.validate;
    const publish = workflow.jobs.publish;
    const smoke = workflow.jobs["registry-smoke"];
    const release = workflow.jobs["github-release"];
    const commands = (job: Job | undefined) =>
      job?.steps.flatMap((step) => step.run ?? []).join("\n") ?? "";

    expect(commands(validate)).toContain("validate-release-tag.mjs");
    expect(commands(validate)).toContain("pnpm install --frozen-lockfile --ignore-scripts");
    expect(commands(validate)).toContain("pnpm rebuild");
    expect(commands(validate)).toContain("pnpm check");
    expect(commands(validate)).toContain("pnpm build");
    expect(commands(validate)).toContain("pnpm package:smoke");
    expect(commands(validate)).toContain("release-registry.mjs check");
    expect(commands(validate)).not.toContain("|| true");
    const validateSmoke = validate?.steps.findIndex((step) => step.run?.includes("package:smoke"));
    const validateRegistry = validate?.steps.findIndex((step) =>
      step.run?.includes("release-registry.mjs check"),
    );
    const validateUpload = validate?.steps.findIndex((step) =>
      step.uses?.startsWith("actions/upload-artifact@"),
    );
    expect(validateSmoke).toBeGreaterThan(-1);
    expect(validateRegistry).toBeGreaterThan(validateSmoke ?? -1);
    expect(validateUpload).toBeGreaterThan(validateRegistry ?? -1);

    expect(publish?.needs).toBe("validate");
    expect(publish?.environment).toBe("npm");
    expect(publish?.permissions).toEqual({ contents: "read", "id-token": "write" });
    expect(commands(publish)).toContain("release-registry.mjs publish");
    const publishDownload = publish?.steps.findIndex((step) =>
      step.uses?.startsWith("actions/download-artifact@"),
    );
    const publishVerify = publish?.steps.findIndex((step) =>
      step.run?.includes("verify-release-packages.mjs"),
    );
    const publishRegistry = publish?.steps.findIndex((step) =>
      step.run?.includes("release-registry.mjs publish"),
    );
    expect(publishDownload).toBeGreaterThan(-1);
    expect(publishVerify).toBeGreaterThan(publishDownload ?? -1);
    expect(publishRegistry).toBeGreaterThan(publishVerify ?? -1);

    expect(smoke?.needs).toBe("publish");
    expect(smoke?.environment).toBeUndefined();
    expect(smoke?.permissions).toEqual({ contents: "read" });
    expect(commands(smoke)).toContain("@ryonakae/shepherd@$VERSION");
    expect(commands(smoke)).toContain("@ryonakae/shepherd-pi@$VERSION");
    expect(commands(smoke)).toContain('bin/shepherd" --help');
    expect(commands(smoke)).toContain('bin/shepherd" --version');
    expect(commands(smoke)).toContain("src/index.ts");
    expect(commands(smoke)).toContain("tsconfig.json");

    expect(release?.needs).toBe("registry-smoke");
    expect(release?.permissions).toEqual({ contents: "write" });
    expect(commands(release)).toContain("releases/generate-notes");
    expect(commands(release)).toContain("gh release create");

    for (const job of Object.values(workflow.jobs)) {
      for (const step of job.steps.filter((candidate) => candidate.uses)) {
        expect(step.uses).toMatch(/@[0-9a-f]{40}$/);
      }
    }
  });

  test("publishes only verified tarball paths with public provenance", async () => {
    const source = await readFile(
      new URL("../../scripts/release-registry.mjs", import.meta.url),
      "utf8",
    );

    expect(source).toContain('["publish", entry.path, "--access", "public", "--provenance"]');
    expect(source).not.toContain("npm pack");
  });
});

describe("hosted CI", () => {
  test("runs full package validation on pull requests and main pushes", async () => {
    const source = await readFile(
      new URL("../../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    );
    const workflow = parseYaml(source) as {
      jobs: Record<
        string,
        {
          "runs-on": string;
          steps: Array<{ run?: string; uses?: string; with?: Record<string, unknown> }>;
        }
      >;
      on: { pull_request: unknown; push: { branches: string[] } };
      permissions: Record<string, string>;
    };

    expect(workflow.on.pull_request).toBeDefined();
    expect(workflow.on.push.branches).toEqual(["main"]);
    expect(workflow.permissions).toEqual({ contents: "read" });
    const [job] = Object.values(workflow.jobs);
    expect(job?.["runs-on"]).toBe("ubuntu-latest");
    const setupNode = job?.steps.find((step) => step.uses?.startsWith("actions/setup-node@"));
    const setupPnpm = job?.steps.find((step) => step.uses?.startsWith("pnpm/action-setup@"));
    expect(setupNode?.with?.["node-version"]).toBe("24.18.0");
    expect(setupPnpm).toBeDefined();
    const commands = job?.steps.flatMap((step) => step.run ?? []).join("\n") ?? "";
    expect(commands).toContain("pnpm install --frozen-lockfile --ignore-scripts");
    expect(commands).toContain("pnpm rebuild");
    expect(commands.indexOf("pnpm rebuild")).toBeGreaterThan(commands.indexOf("pnpm install"));
    expect(commands.indexOf("pnpm check")).toBeGreaterThan(commands.indexOf("pnpm rebuild"));
    expect(commands).toContain("pnpm build");
    expect(commands).toContain("pnpm package:smoke");
    expect(commands).not.toContain("npm publish");
  });
});

describe("release preparation", () => {
  test("keeps repository release references synchronized", async () => {
    const root = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { packageManager?: string; scripts?: Record<string, string>; version: string };
    expect(root.packageManager).toBe("pnpm@11.9.0");
    expect(root.scripts?.["release:prepare"]).toBe("node scripts/prepare-release.mjs");
    expect(root.scripts?.["package:smoke"]).toBe("node scripts/check-release-packages.mjs");

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
