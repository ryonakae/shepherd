# Scoped npm Publication Implementation Plan

> **For implementers:** Execute this plan task-by-task. Complete each checkbox step, run the listed validation, and commit after each task.

**Status:** Approved

**Goal:** Publish the Shepherd CLI/daemon and Pi extension as `@ryonakae/shepherd` and `@ryonakae/shepherd-pi`, keep the Herdr plugin on its existing GitHub-subdirectory distribution path, and document a repeatable release process.

**Architecture:** Keep the root package as the CLI/daemon distribution and keep `packages/shepherd-pi` as the Pi-native installation unit. Leave `packages/shepherd-herdr-plugin` in place so existing Herdr GitHub install paths remain valid, but mark it private because Herdr 0.7.2 installs plugins from `owner/repo/subdir`, not npm. Restrict the root npm tarball to built runtime files and migrations, and clean `dist` before every build so removed modules cannot leak into a release.

**Tech Stack:** Node.js 24.18.0, pnpm 11.9.0, npm public registry, TypeScript ESM, Vitest, Biome, GitHub CLI, Pi 0.80.6, Herdr 0.7.2.

## Global Constraints

- Publish exactly two npm packages:
  - `@ryonakae/shepherd`
  - `@ryonakae/shepherd-pi`
- Do not publish `packages/shepherd-herdr-plugin` to npm. Keep its GitHub install path `ryonakae/shepherd/packages/shepherd-herdr-plugin` and add `"private": true` to its package manifest.
- Do not turn the repository into a pnpm workspace. `pnpm-workspace.yaml` remains reserved for pnpm 11 `allowBuilds` configuration.
- Release the scoped packages as `0.3.1`. The existing `v0.3.0` tag predates scoped package names and must not move.
- Keep all four release versions synchronized:
  - root `package.json`
  - `packages/shepherd-pi/package.json`
  - `packages/shepherd-herdr-plugin/package.json`
  - `packages/shepherd-herdr-plugin/herdr-plugin.toml`
- Set `publishConfig.access` to `public` in both public package manifests. Keep the explicit `npm publish --access public` flag in the release procedure as an additional guard.
- Preserve the CLI binary name `shepherd`.
- Root package runtime content must include compiled `dist/` output and `drizzle/` migrations. It must not include source, tests, plans, nested packages, repository configuration, assets, or stale removed modules.
- `packages/shepherd-pi` continues to ship TypeScript source because Pi loads its extension entrypoint directly.
- Do not publish from a dirty worktree, an unpushed commit, or a commit that is not on `main`.
- Do not place npm credentials, OTP values, tokens, or generated tarballs in the repository.
- npm versions are immutable. If a published artifact is wrong, do not move a tag or reuse the version; use the next unused patch version.
- Publish npm packages only after all dry-runs and isolated tarball installs pass.
- Create the GitHub Release only after both npm packages are visible at `0.3.1`.
- Keep the active plan under `docs/plans/` during execution. After npm and GitHub verification, mark it completed and archive it in a separate docs-only commit.

## Current Context

- `v0.3.0` points to `be3906bc2259207a6b5f8e17bea6a893014bdf43` and is already a public GitHub Release.
- The npm account is `ryonakae`; email is verified and 2FA mode is `auth-and-writes`.
- The root package currently packs 403 files, about 1.3 MB compressed and 3.0 MB unpacked. It includes `src/`, `test/`, `docs/plans/`, `packages/`, repository configuration, the cover image, and stale removed `dist` modules.
- The stale output exists because `pnpm build` emits into `dist` without removing the previous build.
- The Pi package currently packs seven files and has an appropriate runtime boundary, but it lacks an explicit file allowlist, scoped name, public access setting, and repository metadata.
- Herdr 0.7.2 exposes `herdr plugin install <owner>/<repo>[/subdir...]`. The installed Shepherd plugin records `source.kind: "github"` and `subdir: "packages/shepherd-herdr-plugin"`.
- The repository deliberately is not a pnpm workspace. Root scripts validate nested packages with `pnpm --dir`.
- `pnpm check` currently passes 33 test files and 199 tests.

## File Structure

- Create: `scripts/clean-dist.mjs` — remove root `dist` portably before TypeScript emission.
- Create: `scripts/check-root-package.mjs` — inspect the root npm dry-run manifest and reject missing runtime files or unexpected paths.
- Create: `test/unit/package-publication.test.ts` — public/private package boundary, scope, access, file allowlist, repository metadata, and synchronized-version contract.
- Create: `docs/releasing.md` — authoritative version, validation, npm publication, GitHub Release, verification, and recovery procedure.
- Modify: `package.json` — scoped name, root file allowlist, public access, clean build, prepack, and root package check.
- Modify: `packages/shepherd-pi/package.json` — scoped name, file allowlist, public access, and repository metadata.
- Modify: `packages/shepherd-herdr-plugin/package.json` — private package marker while retaining local validation scripts.
- Modify: `packages/shepherd-pi/README.md` — npm/Pi installation commands and daemon prerequisite.
- Modify: `packages/shepherd-herdr-plugin/README.md` — GitHub-subdirectory installation and explicit non-npm distribution.
- Modify: `README.md` — npm-first CLI/Pi install, source-install fallback, Herdr plugin command, package table, and release guide link.
- Modify: `README.ja.md` — Japanese counterpart of installation and package distribution.
- Modify: `AGENTS.md` — package checks, release documentation path, and the two-package publication boundary.
- Modify during release: the four version files listed under Global Constraints.
- Move after completion: `docs/plans/2026-07-15-npm-publication.md` to `docs/plans/archived/2026-07-15-npm-publication.md`.

## Target Package Contracts

### Root package

`package.json` must contain the following publication fields while retaining the existing binary, dependencies, engines, repository, bugs, and homepage fields:

```json
{
  "name": "@ryonakae/shepherd",
  "files": [
    "dist",
    "drizzle"
  ],
  "publishConfig": {
    "access": "public"
  },
  "scripts": {
    "clean:dist": "node scripts/clean-dist.mjs",
    "build": "pnpm clean:dist && tsc -p tsconfig.build.json && tsc-alias -p tsconfig.build.json",
    "package:check": "node scripts/check-root-package.mjs",
    "pnpm:devPreinstall": "husky",
    "prepack": "pnpm build"
  }
}
```

Add `pnpm package:check` to `pnpm check` after `pnpm build` is not required: `package:check` invokes `npm pack --dry-run`, and npm runs `prepack`, which performs the clean production build. Keep the existing Pi and Herdr checks after it.

The root dry-run may contain only:

```text
LICENSE
README.md
README.ja.md
package.json
dist/**
drizzle/**
```

It must contain at least:

```text
dist/src/cli/shepherd.js
dist/src/cli/shepherd-daemon.js
drizzle/meta/_journal.json
```

It must reject every path under `src/`, `test/`, `docs/`, `packages/`, `assets/`, `.husky/`, and any packed path containing `worker` case-insensitively.

### Pi package

`packages/shepherd-pi/package.json` must contain:

```json
{
  "name": "@ryonakae/shepherd-pi",
  "files": [
    "src"
  ],
  "publishConfig": {
    "access": "public"
  },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/ryonakae/shepherd.git",
    "directory": "packages/shepherd-pi"
  }
}
```

Keep the Pi and Pi TUI peer dependencies at `>=0.80.6`. The packed package must include `src/index.ts`, `src/daemon-client.ts`, `src/wake.ts`, `src/agent-update-ui.ts`, `README.md`, and `package.json`; it must not include `tsconfig.json`.

### Herdr integration package

`packages/shepherd-herdr-plugin/package.json` keeps its existing name and scripts but adds:

```json
{
  "private": true
}
```

Its package version remains synchronized with `herdr-plugin.toml` because the GitHub tag is the Herdr distribution version. No npm publish command may target this directory.

## Tasks

### Task 1: Lock the publication boundary and clean package output

**Objective:** Make package metadata, build cleanup, and tarball contents testable before documentation or release work.

**Files:**
- Create: `test/unit/package-publication.test.ts`
- Create: `scripts/clean-dist.mjs`
- Create: `scripts/check-root-package.mjs`
- Modify: `package.json`
- Modify: `packages/shepherd-pi/package.json`
- Modify: `packages/shepherd-herdr-plugin/package.json`

- [x] **Step 1: Write the failing publication contract test**

Create `test/unit/package-publication.test.ts`:

```ts
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
    const herdr = await readManifest(
      "../../packages/shepherd-herdr-plugin/package.json",
    );
    const pluginToml = await readFile(
      new URL(
        "../../packages/shepherd-herdr-plugin/herdr-plugin.toml",
        import.meta.url,
      ),
      "utf8",
    );
    const pluginVersion = /^version = "([^"]+)"$/m.exec(pluginToml)?.[1];

    expect(root.name).toBe("@ryonakae/shepherd");
    expect(root.files).toEqual(["dist", "drizzle"]);
    expect(root.publishConfig?.access).toBe("public");
    expect(root.scripts).toMatchObject({
      "clean:dist": "node scripts/clean-dist.mjs",
      "package:check": "node scripts/check-root-package.mjs",
      "pnpm:devPreinstall": "husky",
      prepack: "pnpm build",
    });
    expect(root.scripts).not.toHaveProperty("prepare");
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
```

- [x] **Step 2: Run the focused test and confirm RED**

```bash
PATH="$HOME/.local/share/mise/installs/node/24.18.0/bin:$HOME/.local/share/mise/installs/pnpm/11.9.0/bin:$PATH" \
  pnpm exec vitest run test/unit/package-publication.test.ts
```

Expected: assertions fail on unscoped names, missing public/private fields, and missing file allowlists.

- [x] **Step 3: Implement scoped package metadata**

Apply the Target Package Contracts without changing versions from `0.3.0` yet. Do not edit `pnpm-workspace.yaml`.

- [x] **Step 4: Add portable clean build and root pack validation**

Create `scripts/clean-dist.mjs`:

```js
import { rm } from "node:fs/promises";

await rm(new URL("../dist", import.meta.url), {
  force: true,
  recursive: true,
});
```

Create `scripts/check-root-package.mjs`:

```js
#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(
  await readFile(new URL("package.json", root), "utf8"),
);
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const [packed] = JSON.parse(
  execFileSync(npm, ["pack", "--dry-run", "--json"], {
    cwd: fileURLToPath(root),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }),
);
const files = packed?.files?.map(({ path }) => path) ?? [];
const required = [
  "dist/src/cli/shepherd.js",
  "dist/src/cli/shepherd-daemon.js",
  "drizzle/meta/_journal.json",
];
const topLevel = new Set([
  "LICENSE",
  "README.md",
  "README.ja.md",
  "package.json",
]);
const unexpected = files.filter(
  (path) =>
    !topLevel.has(path) &&
    !path.startsWith("dist/") &&
    !path.startsWith("drizzle/"),
);
const stale = files.filter((path) => path.toLowerCase().includes("worker"));
const missing = required.filter((path) => !files.includes(path));
const errors = [];

if (packed?.name !== manifest.name) {
  errors.push(`name: expected ${manifest.name}, received ${packed?.name}`);
}
if (packed?.version !== manifest.version) {
  errors.push(`version: expected ${manifest.version}, received ${packed?.version}`);
}
if (missing.length > 0) errors.push(`missing: ${missing.join(", ")}`);
if (unexpected.length > 0) errors.push(`unexpected: ${unexpected.join(", ")}`);
if (stale.length > 0) errors.push(`stale worker paths: ${stale.join(", ")}`);

if (errors.length > 0) {
  throw new Error(`Invalid root npm package:\n- ${errors.join("\n- ")}`);
}

console.log(`${packed.name}@${packed.version}: ${files.length} files`);
```

Update root scripts so `build` starts with `pnpm clean:dist`, `prepack` runs `pnpm build`, `package:check` runs the checker, and the aggregate `check` includes `pnpm package:check` before nested package checks. Replace the standard `prepare` lifecycle with `pnpm:devPreinstall` so local pnpm development still installs Husky hooks without exposing an install lifecycle script to npm consumers. `package:check` calling `npm pack` does not recurse: npm runs `prepack`, and `prepack` calls `build`, which does not call `package:check`.

- [x] **Step 5: Run focused contract and package checks**

```bash
PATH="$HOME/.local/share/mise/installs/node/24.18.0/bin:$HOME/.local/share/mise/installs/pnpm/11.9.0/bin:$PATH" \
  pnpm exec vitest run test/unit/package-publication.test.ts
PATH="$HOME/.local/share/mise/installs/node/24.18.0/bin:$HOME/.local/share/mise/installs/pnpm/11.9.0/bin:$PATH" \
  pnpm package:check
PATH="$HOME/.local/share/mise/installs/node/24.18.0/bin:$HOME/.local/share/mise/installs/pnpm/11.9.0/bin:$PATH" \
  pnpm pi-package:check
PATH="$HOME/.local/share/mise/installs/node/24.18.0/bin:$HOME/.local/share/mise/installs/pnpm/11.9.0/bin:$PATH" \
  pnpm herdr-plugin:check
```

Expected: the test passes; root dry-run contains only the allowlist; Pi dry-run excludes `tsconfig.json`; Herdr validation passes while the manifest is private.

- [x] **Step 6: Commit the package boundary**

```bash
git add \
  package.json \
  packages/shepherd-pi/package.json \
  packages/shepherd-herdr-plugin/package.json \
  scripts/clean-dist.mjs \
  scripts/check-root-package.mjs \
  test/unit/package-publication.test.ts
git commit -m "build: prepare scoped npm packages"
git push origin main
```

### Task 2: Document installation and release operations

**Objective:** Make npm the default install path, keep source and Herdr integration instructions accurate, and give maintainers one release checklist.

**Files:**
- Create: `docs/releasing.md`
- Modify: `README.md`
- Modify: `README.ja.md`
- Modify: `packages/shepherd-pi/README.md`
- Modify: `packages/shepherd-herdr-plugin/README.md`
- Modify: `AGENTS.md`

- [x] **Step 1: Update the English and Japanese installation paths**

Make npm installation the first path:

```bash
npm install --global @ryonakae/shepherd
shepherd help
```

Add Pi installation:

```bash
pi install npm:@ryonakae/shepherd-pi
```

Use a shell `VERSION` variable in the release guide and the current stable tag in README examples for Herdr plugin installation:

```bash
herdr plugin install ryonakae/shepherd/packages/shepherd-herdr-plugin --ref v0.3.1 --yes
```

Keep source installation in a separate section and state that pnpm is required only for source builds and development. Update the package table to distinguish the two public npm packages from the GitHub-distributed Herdr integration.

- [x] **Step 2: Update companion package READMEs**

The Pi README must show `pi install npm:@ryonakae/shepherd-pi` and `npm install --global @ryonakae/shepherd` before daemon startup.

The Herdr README must show the GitHub-subdirectory command, state that npm does not distribute the plugin, and retain the daemon prerequisite.

- [x] **Step 3: Write `docs/releasing.md`**

Document these sections with copyable commands and expected checks:

1. Published artifacts and ownership boundary.
2. Preconditions: `main`, clean tree, `npm whoami` equals `ryonakae`, email verified, write 2FA enabled, `gh auth status` succeeds.
3. Version synchronization across four files.
4. `pnpm check`, `pnpm build`, root/Pi/Herdr package checks.
5. Actual tarball creation into a temporary directory, isolated install of the root CLI, and isolated install/file inspection of the Pi package.
6. Release commit and push.
7. Local annotated tag creation without pushing it yet.
8. Root npm publish, registry verification, Pi npm publish, registry verification.
9. Remote tag push and GitHub Release creation only after both registry entries exist.
10. Final verification of npm dist-tags, GitHub latest release, tag target, and clean tree.
11. Failure handling for timeout-after-publish and partial two-package publication. Require `npm view` before retrying. If root `0.3.1` exists but Pi needs a content change, delete only the unpushed local `v0.3.1` tag, bump all four version files to `0.3.2`, rebuild and republish both packages at `0.3.2`, then create only `v0.3.2`. After the complete replacement release exists, deprecate the orphaned root version with `npm deprecate @ryonakae/shepherd@0.3.1 "Incomplete paired release; use 0.3.2"`. Never move a remote tag or reuse a published version.
12. Authentication for `auth-and-writes` 2FA. Run each publish in an interactive terminal and let npm request the second factor. Never pass an OTP in command arguments or put it in a file, command history, plan evidence, or chat.
13. Explicit statement that the Herdr plugin is never sent to `npm publish`.

Use `<version>` and shell variables in the release guide rather than copying a release-specific version through every command.

- [x] **Step 4: Update AGENTS.md**

Add `pnpm package:check` to common commands, identify `docs/releasing.md` as the release source of truth, state that only root and Pi are public npm packages, and retain the instruction not to convert `pnpm-workspace.yaml` into a workspace definition.

- [x] **Step 5: Review prose and commands**

Check every internal link, compare English/Japanese install commands, and run searches:

```bash
rg -n 'npm install|pi install|herdr plugin install' README.md README.ja.md packages/*/README.md docs/releasing.md
rg -n 'shepherd-pi|shepherd-herdr-plugin|@ryonakae/shepherd' README.md README.ja.md AGENTS.md docs/releasing.md packages/*/README.md
```

Expected: npm names use the scope; Herdr commands use GitHub paths; no document instructs npm to install or publish the Herdr plugin.

- [x] **Step 6: Commit documentation**

```bash
git add \
  AGENTS.md \
  README.md \
  README.ja.md \
  docs/releasing.md \
  packages/shepherd-pi/README.md \
  packages/shepherd-herdr-plugin/README.md \
  docs/plans/2026-07-15-npm-publication.md
git commit -m "docs: document npm installation and releases"
git push origin main
```

### Task 3: Validate packed artifacts and isolated installation

**Objective:** Prove the exact tarballs work before creating an immutable npm version.

- [ ] **Step 1: Run repository gates**

```bash
PATH="$HOME/.local/share/mise/installs/node/24.18.0/bin:$HOME/.local/share/mise/installs/pnpm/11.9.0/bin:$PATH" pnpm check
PATH="$HOME/.local/share/mise/installs/node/24.18.0/bin:$HOME/.local/share/mise/installs/pnpm/11.9.0/bin:$PATH" pnpm build
git diff --check
```

Expected: typecheck, all Vitest files, Biome, Drizzle, root package check, Pi package check, Herdr package check, and production build pass.

- [ ] **Step 2: Create actual tarballs outside the repository**

```bash
RELEASE_TMP="$(mktemp -d)"
npm pack --pack-destination "$RELEASE_TMP"
(
  cd packages/shepherd-pi
  npm pack --pack-destination "$RELEASE_TMP"
)
EXPECTED_TARBALLS="$(printf '%s\n' \
  ryonakae-shepherd-0.3.0.tgz \
  ryonakae-shepherd-pi-0.3.0.tgz)"
ACTUAL_TARBALLS="$(find "$RELEASE_TMP" -maxdepth 1 -type f -name '*.tgz' \
  -exec basename {} \; | sort)"
test "$ACTUAL_TARBALLS" = "$EXPECTED_TARBALLS"
ls -lh "$RELEASE_TMP"
```

Expected: the exact two scoped tarball filenames match. The Herdr directory produces no release tarball.

- [ ] **Step 3: Install and run the packed root CLI**

```bash
mkdir -p "$RELEASE_TMP/root-prefix"
npm install --global --prefix "$RELEASE_TMP/root-prefix" \
  "$RELEASE_TMP/ryonakae-shepherd-0.3.0.tgz"
"$RELEASE_TMP/root-prefix/bin/shepherd" help
```

Expected: installation succeeds without repository files; `shepherd help` exits zero and prints the CLI command list.

- [ ] **Step 4: Install and inspect the Pi tarball**

```bash
mkdir -p "$RELEASE_TMP/pi-prefix"
npm install --prefix "$RELEASE_TMP/pi-prefix" --ignore-scripts \
  "$RELEASE_TMP/ryonakae-shepherd-pi-0.3.0.tgz"
test -f "$RELEASE_TMP/pi-prefix/node_modules/@ryonakae/shepherd-pi/src/index.ts"
test ! -f "$RELEASE_TMP/pi-prefix/node_modules/@ryonakae/shepherd-pi/tsconfig.json"
```

Expected: package installation succeeds and only the declared runtime files appear.

- [ ] **Step 5: Confirm no repository changes**

```bash
git status --short
git diff --check
```

Expected: clean worktree after the first two commits; tarballs remain only under `$RELEASE_TMP`.

### Task 4: Release version 0.3.1 to npm and GitHub

**Objective:** Publish both scoped packages from one verified commit and expose the matching GitHub Release.

- [ ] **Step 1: Run authentication and availability preflight**

```bash
git fetch origin main
test "$(git branch --show-current)" = "main"
test -z "$(git status --porcelain)"
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
test "$(npm whoami)" = "ryonakae"
npm profile get --json | node -e '
let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  const profile = JSON.parse(input);
  if (profile.email_verified !== true || profile.tfa?.mode !== "auth-and-writes") {
    process.exit(1);
  }
});'
gh auth status
npm view @ryonakae/shepherd@0.3.1 version
npm view @ryonakae/shepherd-pi@0.3.1 version
```

Expected: branch is `main`; tree is clean; `HEAD` equals `origin/main`; npm account is `ryonakae` with verified email and write 2FA; GitHub auth succeeds; both `npm view` commands return `E404` before first publication. Treat any returned version as a hard stop.

- [ ] **Step 2: Bump all four versions to 0.3.1**

Edit the three package manifests and `herdr-plugin.toml`. Run the focused publication test and all package checks.

```bash
PATH="$HOME/.local/share/mise/installs/node/24.18.0/bin:$HOME/.local/share/mise/installs/pnpm/11.9.0/bin:$PATH" \
  pnpm exec vitest run test/unit/package-publication.test.ts
PATH="$HOME/.local/share/mise/installs/node/24.18.0/bin:$HOME/.local/share/mise/installs/pnpm/11.9.0/bin:$PATH" \
  pnpm check
PATH="$HOME/.local/share/mise/installs/node/24.18.0/bin:$HOME/.local/share/mise/installs/pnpm/11.9.0/bin:$PATH" \
  pnpm build
```

Expected: all versions match; all gates pass; root and Pi dry-runs report `0.3.1`.

- [ ] **Step 3: Repeat actual tarball installation at 0.3.1**

Repeat Task 3 with a fresh temporary directory and the `0.3.1` tarball names. Do not reuse the `0.3.0` preparation artifacts.

- [ ] **Step 4: Commit and push the release commit**

```bash
git add \
  package.json \
  packages/shepherd-pi/package.json \
  packages/shepherd-herdr-plugin/package.json \
  packages/shepherd-herdr-plugin/herdr-plugin.toml
git commit -m "chore(release): 0.3.1"
test "$(git branch --show-current)" = "main"
test -z "$(git status --porcelain)"
git push origin main
```

Verify the pushed release commit exactly:

```bash
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
```

- [ ] **Step 5: Create a local annotated tag**

```bash
git tag -a v0.3.1 -m "v0.3.1"
```

Do not push the tag yet. Verify `git rev-list -n 1 v0.3.1` equals `HEAD`.

- [ ] **Step 6: Publish and verify the root package**

Run publication from an interactive terminal and let npm request the second factor. Do not pass an OTP through command arguments.

```bash
npm publish --access public
npm view @ryonakae/shepherd@0.3.1 \
  name version dist-tags.latest repository bin --json
```

Expected: publication succeeds; name/version are exact; `latest` is `0.3.1`; binary is `shepherd`. Do not paste the OTP into chat or save it in plan evidence.

If publish returns a network or timeout error, run `npm view @ryonakae/shepherd@0.3.1 version` before retrying. Do not retry if the version exists.

- [ ] **Step 7: Publish and verify the Pi package**

Run a separate interactive publish so npm requests a fresh second factor:

```bash
(
  cd packages/shepherd-pi
  npm publish --access public
)
npm view @ryonakae/shepherd-pi@0.3.1 \
  name version dist-tags.latest repository peerDependencies --json
```

Expected: publication succeeds; `latest` is `0.3.1`; repository directory and Pi peers are present.

Apply the same `npm view` before-retry rule after ambiguous failures. If root exists but Pi requires a content change, delete the unpushed local tag with `git tag -d v0.3.1`; export `VERSION=0.3.2 TAG=v0.3.2`; update all four version files and the Herdr tag references in `README.md`, `README.ja.md`, and `packages/shepherd-herdr-plugin/README.md`; commit the replacement, confirm a clean tree, push `main`, verify `HEAD` equals `origin/main`, and only then create the replacement local tag and continue publication. Do not create a GitHub `v0.3.1` release.

- [ ] **Step 8: Verify registry installation**

Use a new temporary directory and install from the registry, not local tarballs:

```bash
REGISTRY_TMP="$(mktemp -d)"
npm install --global --prefix "$REGISTRY_TMP/root-prefix" \
  @ryonakae/shepherd@0.3.1
"$REGISTRY_TMP/root-prefix/bin/shepherd" help
npm install --prefix "$REGISTRY_TMP/pi-prefix" --ignore-scripts \
  @ryonakae/shepherd-pi@0.3.1
test -f "$REGISTRY_TMP/pi-prefix/node_modules/@ryonakae/shepherd-pi/src/index.ts"
```

Expected: both registry installs succeed and the CLI runs.

- [ ] **Step 9: Push the tag and create the GitHub Release**

Create and inspect the exact notes file:

````bash
cat > /tmp/shepherd-v0.3.1-release-notes.md <<'EOF'
## Installation

```bash
npm install --global @ryonakae/shepherd
pi install npm:@ryonakae/shepherd-pi
```

## Changes

- Published the Shepherd CLI/daemon and Pi extension under the `@ryonakae` npm scope.
- Restricted the root npm package to compiled runtime files and Drizzle migrations.
- Added clean builds and package-content validation so removed modules cannot remain in `dist`.
- Documented npm installation, GitHub-based Herdr plugin installation, and the release procedure.

## Distribution

The Herdr plugin remains a GitHub-subdirectory integration and is not published to npm.

## Validation

- `pnpm check` passed.
- `pnpm build` passed.
- Root and Pi tarball dry-runs and isolated installs passed.
- Exact-version installs from the npm registry passed.
EOF
rg -n '@ryonakae/shepherd|Herdr plugin|pnpm check' \
  /tmp/shepherd-v0.3.1-release-notes.md
git push origin v0.3.1
gh release create v0.3.1 \
  --verify-tag \
  --title "v0.3.1" \
  --notes-file /tmp/shepherd-v0.3.1-release-notes.md \
  --latest
````

Expected: the notes include both npm install commands, scoped publication, root tarball cleanup, Herdr GitHub distribution, and validation commands.

- [ ] **Step 10: Audit external state**

Verify:

```bash
npm view @ryonakae/shepherd@0.3.1 version
npm view @ryonakae/shepherd-pi@0.3.1 version
gh release view v0.3.1 --json tagName,name,isDraft,isPrerelease,url,publishedAt
gh api repos/ryonakae/shepherd/releases/latest --jq .tag_name
git ls-remote --tags origin refs/tags/v0.3.1 refs/tags/v0.3.1^{}
git status --short
```

Expected: both npm versions are `0.3.1`; GitHub Release is public/latest; the annotated tag dereferences to the release commit; worktree is clean.

### Task 5: Archive the completed plan

**Objective:** Record final evidence without changing the published release commit.

- [ ] **Step 1: Complete the plan record**

Set Status to `Completed and archived`, mark every task checkbox, and record:

- implementation and docs commit SHAs;
- release commit SHA;
- test count and package dry-run sizes/file counts;
- npm package URLs and versions;
- GitHub Release URL;
- isolated local and registry install results;
- confirmation that the Herdr plugin was not published to npm.

Set `Next steps` to `None` unless a concrete follow-up remains.

- [ ] **Step 2: Move and commit the plan**

```bash
git mv \
  docs/plans/2026-07-15-npm-publication.md \
  docs/plans/archived/2026-07-15-npm-publication.md
git add docs/plans/archived/2026-07-15-npm-publication.md
git commit -m "docs: archive npm publication plan"
git push origin main
```

Expected: the docs-only archive commit is after `v0.3.1`; the tag remains on the release commit.

## Validation

- `pnpm exec vitest run test/unit/package-publication.test.ts` — publication boundary and version synchronization pass.
- `pnpm check` — repository typecheck, all tests, Biome, Drizzle, root package, Pi package, and Herdr integration checks pass.
- `pnpm build` — removes stale `dist` and emits production output with resolved aliases.
- `pnpm package:check` — root dry-run contains only runtime files and migrations.
- `pnpm pi-package:check` — Pi package typecheck and dry-run pass.
- `pnpm herdr-plugin:check` — private Herdr integration package remains valid for GitHub installation.
- Isolated local tarball install — scoped root CLI runs and Pi runtime source is present.
- Registry install — both public packages install by exact `0.3.1` version and the root CLI runs.
- npm registry audit — both scoped packages expose `latest: 0.3.1`.
- GitHub audit — `v0.3.1` is public/latest and points to the release commit.
- `git diff --check` and clean-tree checks pass before publication and after plan archival.

## Risks and Tradeoffs

- npm publication is irreversible for a version. The procedure performs dry-run and isolated installation twice before publish.
- Two-package publication cannot be atomic. Publish and verify root first, then Pi; use registry reads before any retry. If root publishes but Pi needs content changes, delete only the unpushed local tag, export the replacement `VERSION` and `TAG`, bump every release version and Herdr README tag, republish both packages at that patch, create only the replacement GitHub Release, and deprecate the orphaned root version after the complete replacement exists.
- `prepack` rebuilds the root package and therefore requires the repository dev toolchain on the publishing machine. Consumers installing from npm do not run `prepack`.
- The Herdr plugin retains a package manifest for local typecheck and pack validation, even though npm does not distribute it.
- The repository stays outside pnpm workspace mode by project policy. Nested package checks continue through `pnpm --dir`.
- Moving the Herdr integration to `integrations/herdr` would make the directory taxonomy clearer but would break the existing Herdr subdirectory install path. This release keeps the path stable.

## Review Record

- Initial review found missing copyable test/script implementations, release-note creation, npm write-2FA handling, partial-publication recovery, branch/remote assertions, exact tarball checks, and Pi isolated-install coverage.
- The plan now specifies each item with executable commands and explicit recovery behavior.
- Final independent review: **Approved**, with no remaining issues or recommendations.

## Progress

- [x] Task 1: Lock the publication boundary and clean package output — `bab2d62`
- [x] Task 2: Document installation and release operations
- [ ] Task 3: Validate packed artifacts and isolated installation
- [ ] Task 4: Release version 0.3.1 to npm and GitHub
- [ ] Task 5: Archive the completed plan

## Next steps

- Execute Task 3 packed-artifact and isolated-install validation.
