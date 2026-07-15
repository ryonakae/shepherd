# Releasing Shepherd

Shepherd publishes two npm packages and one GitHub-distributed Herdr integration.

| Artifact | Distribution |
| --- | --- |
| `@ryonakae/shepherd` | Public npm package and `shepherd` CLI |
| `@ryonakae/shepherd-pi` | Public npm package installed by Pi |
| `packages/shepherd-herdr-plugin` | GitHub repository subdirectory installed by Herdr |

Do not run `npm publish` from `packages/shepherd-herdr-plugin`. Its private package manifest supports local validation only.

## Preconditions

Run releases from the repository root on `main`. Replace the version below with the version being released.

```bash
export VERSION=0.3.1
export TAG="v$VERSION"
export PATH="$HOME/.local/share/mise/installs/node/24.18.0/bin:$HOME/.local/share/mise/installs/pnpm/11.9.0/bin:$PATH"

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
```

The npm account must have verified email and write 2FA. Never put an npm token or OTP in the repository, shell history, release notes, or chat.

Confirm the version does not exist:

```bash
npm view "@ryonakae/shepherd@$VERSION" version
npm view "@ryonakae/shepherd-pi@$VERSION" version
```

Both commands must return `E404`. Stop if either command prints a version.

## Update versions

Keep these files synchronized:

- `package.json`
- `packages/shepherd-pi/package.json`
- `packages/shepherd-herdr-plugin/package.json`
- `packages/shepherd-herdr-plugin/herdr-plugin.toml`

The following command updates all four:

```bash
node --input-type=module <<'NODE'
import { readFile, writeFile } from "node:fs/promises";

const version = process.env.VERSION;
if (!version) throw new Error("VERSION is required");

for (const path of [
  "package.json",
  "packages/shepherd-pi/package.json",
  "packages/shepherd-herdr-plugin/package.json",
]) {
  const manifest = JSON.parse(await readFile(path, "utf8"));
  manifest.version = version;
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

const tomlPath = "packages/shepherd-herdr-plugin/herdr-plugin.toml";
const toml = await readFile(tomlPath, "utf8");
const updated = toml.replace(/^version = "[^"]+"$/m, `version = "${version}"`);
if (updated === toml) throw new Error("Herdr plugin version was not updated");
await writeFile(tomlPath, updated);
NODE
```

Review the four-file diff before continuing.

## Validate source and package contents

```bash
pnpm check
pnpm build
git diff --check
```

`pnpm check` includes root, Pi, and Herdr package checks. The root package checker rebuilds from a clean `dist` directory and rejects source, tests, plans, nested packages, assets, and stale `worker` paths.

Create the two public tarballs outside the repository:

```bash
export RELEASE_TMP="$(mktemp -d)"
npm pack --pack-destination "$RELEASE_TMP"
(
  cd packages/shepherd-pi
  npm pack --pack-destination "$RELEASE_TMP"
)

EXPECTED_TARBALLS="$(printf '%s\n' \
  "ryonakae-shepherd-$VERSION.tgz" \
  "ryonakae-shepherd-pi-$VERSION.tgz")"
ACTUAL_TARBALLS="$(find "$RELEASE_TMP" -maxdepth 1 -type f -name '*.tgz' \
  -exec basename {} \; | sort)"
test "$ACTUAL_TARBALLS" = "$EXPECTED_TARBALLS"
```

Install both tarballs in isolated prefixes:

```bash
npm install --global --prefix "$RELEASE_TMP/root-prefix" \
  "$RELEASE_TMP/ryonakae-shepherd-$VERSION.tgz"
"$RELEASE_TMP/root-prefix/bin/shepherd" help

npm install --prefix "$RELEASE_TMP/pi-prefix" --ignore-scripts \
  "$RELEASE_TMP/ryonakae-shepherd-pi-$VERSION.tgz"
test -f "$RELEASE_TMP/pi-prefix/node_modules/@ryonakae/shepherd-pi/src/index.ts"
test ! -f "$RELEASE_TMP/pi-prefix/node_modules/@ryonakae/shepherd-pi/tsconfig.json"
```

Do not continue unless both installations pass.

## Commit and create a local tag

```bash
git add \
  package.json \
  packages/shepherd-pi/package.json \
  packages/shepherd-herdr-plugin/package.json \
  packages/shepherd-herdr-plugin/herdr-plugin.toml
git commit -m "chore(release): $VERSION"
test -z "$(git status --porcelain)"
git push origin main
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
git tag -a "$TAG" -m "$TAG"
test "$(git rev-list -n 1 "$TAG")" = "$(git rev-parse HEAD)"
```

Keep the tag local until both npm packages have been published and verified.

## Publish to npm

Run each publish from an interactive terminal and let npm request the second factor. Do not pass an OTP through `--otp`, because command arguments can be visible to other local processes.

Publish the root package:

```bash
npm publish --access public
npm view "@ryonakae/shepherd@$VERSION" \
  name version dist-tags.latest repository bin --json
```

Then publish the Pi package in a separate interactive command:

```bash
(
  cd packages/shepherd-pi
  npm publish --access public
)
npm view "@ryonakae/shepherd-pi@$VERSION" \
  name version dist-tags.latest repository peerDependencies --json
```

After a timeout or network error, query the exact version before retrying. Do not retry when `npm view` shows that version.

## Verify registry installation

Use a new directory so this check cannot read the local tarballs:

```bash
export REGISTRY_TMP="$(mktemp -d)"
npm install --global --prefix "$REGISTRY_TMP/root-prefix" \
  "@ryonakae/shepherd@$VERSION"
"$REGISTRY_TMP/root-prefix/bin/shepherd" help

npm install --prefix "$REGISTRY_TMP/pi-prefix" --ignore-scripts \
  "@ryonakae/shepherd-pi@$VERSION"
test -f "$REGISTRY_TMP/pi-prefix/node_modules/@ryonakae/shepherd-pi/src/index.ts"
```

## Publish the tag and GitHub Release

Write release notes to `/tmp/shepherd-$VERSION-release-notes.md`. Include both npm install commands, package-content changes, validation, and the fact that Herdr still installs its plugin from GitHub.

```bash
git push origin "$TAG"
gh release create "$TAG" \
  --verify-tag \
  --title "$TAG" \
  --notes-file "/tmp/shepherd-$VERSION-release-notes.md" \
  --latest
```

Verify every external artifact:

```bash
npm view "@ryonakae/shepherd@$VERSION" version
npm view "@ryonakae/shepherd-pi@$VERSION" version
gh release view "$TAG" --json tagName,name,isDraft,isPrerelease,url,publishedAt
gh api repos/ryonakae/shepherd/releases/latest --jq .tag_name
git ls-remote --tags origin "refs/tags/$TAG" "refs/tags/$TAG^{}"
test -z "$(git status --porcelain)"
```

## Recover from a partial publication

Two npm publishes cannot be atomic. Use these rules when the root version exists but the Pi package needs a content change:

1. Confirm the Pi version is absent with `npm view`.
2. Delete only the local, unpushed tag: `git tag -d "$TAG"`.
3. Export the next unused patch version: `export VERSION=0.3.2 TAG=v0.3.2`.
4. Update all four version files and replace the Herdr tag in `README.md`, `README.ja.md`, and `packages/shepherd-herdr-plugin/README.md`.
5. Rebuild and reinstall both tarballs.
6. Commit the replacement version and documentation, confirm the tree is clean, push `main`, and verify `HEAD` equals `origin/main`.
7. Create a new local tag from the pushed replacement commit.
8. Publish and verify both packages at the replacement version.
9. Push only the replacement tag and create only its GitHub Release.
10. After the complete replacement exists, deprecate the orphaned root version:

```bash
npm deprecate @ryonakae/shepherd@0.3.1 \
  "Incomplete paired release; use 0.3.2"
```

Do not move a remote tag, overwrite a GitHub Release, reuse an npm version, or unpublish a package to repair a release.
