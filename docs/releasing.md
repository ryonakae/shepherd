# Releasing Shepherd

Shepherd publishes two npm packages from GitHub Actions and distributes the Herdr integration from the same Git tag.

| Artifact | Distribution |
| --- | --- |
| `@ryonakae/shepherd` | Public npm package and `shepherd` CLI |
| `@ryonakae/shepherd-pi` | Public npm package installed by Pi |
| `packages/shepherd-herdr-plugin` | GitHub repository subdirectory installed by Herdr |

Do not run `npm publish` manually and do not publish `packages/shepherd-herdr-plugin`. Its private package manifest supports local validation only.

## One-time trusted publishing setup

The release workflow must exist as `.github/workflows/release.yml` on the default branch before configuring npm. The trusted publisher identity includes the repository, workflow filename, and GitHub Environment name, so renaming either `release.yml` or `npm` requires updating both npm packages.

Create the `npm` Environment with `ryonakae` as required reviewer. Self-review remains allowed because the repository has one maintainer.

```bash
printf '%s\n' '{"wait_timer":0,"prevent_self_review":false,"reviewers":[{"type":"User","id":6018455}]}' \
  | gh api --method PUT repos/ryonakae/shepherd/environments/npm --input -

gh api repos/ryonakae/shepherd/environments/npm \
  | jq -e 'any(.protection_rules[]; .type == "required_reviewers" and .prevent_self_review == false and any(.reviewers[]; .reviewer.id == 6018455))'
```

Use Node.js `24.18.0` so npm is new enough for Trusted Publishing. Authenticate npm interactively as the package owner; `npm whoami` must print `ryonakae`. The npm CLI token and browser session are independent. If web authentication opens another account, copy the displayed authentication URL into a private browser window already signed in as `ryonakae`. Never put that URL in release notes or chat.

Bind both packages to the workflow without `--yes` so npm can pause for confirmation and browser 2FA. This changes npm package settings; it does not create an npm token or repository secret.

```bash
mise exec node@24.18.0 -- npm whoami

mise exec node@24.18.0 -- npm trust github @ryonakae/shepherd \
  --file release.yml \
  --repo ryonakae/shepherd \
  --env npm \
  --allow-publish

mise exec node@24.18.0 -- npm trust github @ryonakae/shepherd-pi \
  --file release.yml \
  --repo ryonakae/shepherd \
  --env npm \
  --allow-publish

mise exec node@24.18.0 -- npm trust list @ryonakae/shepherd --json
mise exec node@24.18.0 -- npm trust list @ryonakae/shepherd-pi --json
gh api repos/ryonakae/shepherd/actions/secrets --jq '.secrets[].name'
```

The successful creation output and both trust listings must name repository `ryonakae/shepherd`, workflow `release.yml`, Environment `npm`, and publish permission. `npm trust list` may require a fresh browser 2FA flow. No npm credential should be added to the Actions secret list.

## Prepare a stable release

Releases use stable `X.Y.Z` versions only. Run from the repository root on `main` with a clean tree synchronized to `origin/main`.

```bash
export VERSION=0.7.0
export TAG="v$VERSION"
export PATH="$HOME/.local/share/mise/installs/node/24.18.0/bin:$HOME/.local/share/mise/installs/pnpm/11.9.0/bin:$PATH"

git fetch origin main
test "$(git branch --show-current)" = "main"
test -z "$(git status --porcelain)"
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
```

Confirm neither npm version exists. Both commands must return `E404`. Stop if either prints a version or fails for another reason.

```bash
npm view "@ryonakae/shepherd@$VERSION" version
npm view "@ryonakae/shepherd-pi@$VERSION" version
```

Add the target section to the top of `CHANGELOG.md` before changing package versions. Use a `## vX.Y.Z` heading and at least one bullet under an allowed category: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, or `Security`. Start an incompatible-change bullet with `**Breaking:**`.

```markdown
## v0.7.0

_2026-09-01_

### Added

- Describe a user-visible change.

### Changed

- **Breaking:** Describe an incompatible change.
```

Validate and preview the authored section while package manifests still contain the previous version.

```bash
pnpm changelog:check "$VERSION"
pnpm release:notes "$VERSION"
```

Both commands fail for a missing or non-latest version, an unknown or empty category, a duplicate or out-of-order version, or a category without a bullet. Review the complete preview, including exact Install commands, Validation claims, and the Full changelog comparison link.

Update every release-owned version reference and review the result.

```bash
pnpm release:prepare "$VERSION"
git diff -- \
  CHANGELOG.md \
  package.json \
  packages/shepherd-pi/package.json \
  packages/shepherd-herdr-plugin/package.json \
  packages/shepherd-herdr-plugin/herdr-plugin.toml \
  README.md \
  README.ja.md \
  packages/shepherd-herdr-plugin/README.md
```

The command accepts no `v` prefix, prerelease suffix, or build metadata. It validates `CHANGELOG.md` before writing any file and refuses to update a missing or invalid section, an already-divergent manifest, or an install example. A failed preparation leaves every release-owned file unchanged.

Validate the exact package boundary locally.

```bash
pnpm check
pnpm build
pnpm package:smoke
git diff --check
```

`pnpm package:smoke` creates the root and Pi tarballs in a temporary directory, records their npm integrity, installs both into isolated prefixes, invokes the installed CLI, and checks the Pi package include/exclude contract.

Commit and push the reviewed version change. Wait for the `CI` workflow on `main` to succeed before creating the tag.

```bash
git add \
  CHANGELOG.md \
  package.json \
  packages/shepherd-pi/package.json \
  packages/shepherd-herdr-plugin/package.json \
  packages/shepherd-herdr-plugin/herdr-plugin.toml \
  README.md \
  README.ja.md \
  packages/shepherd-herdr-plugin/README.md
git commit -m "chore(release): $VERSION"
git push origin main
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
```

## Trigger and approve publication

Create an annotated tag on the release commit and push it once. Remote release tags are immutable: do not delete, move, or reuse one after pushing it.

```bash
git tag -a "$TAG" -m "$TAG"
test "$(git rev-list -n 1 "$TAG")" = "$(git rev-parse HEAD)"
git push origin "$TAG"
```

The `Release` workflow then performs these stages:

1. Validates stable tag syntax, synchronized package and changelog versions, and that the tagged commit belongs to `origin/main`; it also renders the complete Release body before publication.
2. Runs `pnpm check`, builds, packs, and smoke-tests both tarballs.
3. Recomputes tarball integrity, checks existing registry state, and uploads only the two tarballs plus `release-packages.json`.
4. Waits at the protected `npm` Environment. Review the run and approve this deployment in GitHub Actions.
5. Downloads and re-verifies the same tarballs, then publishes the root package followed by the Pi package through npm Trusted Publishing with provenance.
6. Installs both exact versions from npm in an unprivileged job.
7. Creates the GitHub Release from the target `CHANGELOG.md` section plus exact Install commands, workflow-backed Validation claims, and a Full changelog comparison link.

Do not approve publication if validation reports a tag/package/changelog mismatch, a missing release-note bullet, a commit outside `main`, an unexpected artifact, or conflicting registry integrity.

## Verify the completed release

After the workflow succeeds, verify every external artifact.

```bash
npm view "@ryonakae/shepherd@$VERSION" \
  name version dist-tags.latest dist.integrity repository bin --json
npm view "@ryonakae/shepherd-pi@$VERSION" \
  name version dist-tags.latest dist.integrity repository peerDependencies --json
gh release view "$TAG" --json tagName,name,isDraft,isPrerelease,url,publishedAt,body
gh api repos/ryonakae/shepherd/releases/latest --jq .tag_name
git ls-remote --tags origin "refs/tags/$TAG" "refs/tags/$TAG^{}"
test -z "$(git status --porcelain)"
```

Both npm versions must equal `$VERSION`, both `latest` tags must point to it, and the GitHub Release must be non-draft and non-prerelease at `$TAG`.

## Recover from a failed run

The workflow classifies each exact npm version against the verified tarball integrity:

- `absent`: the version is not published.
- `expected`: the published integrity equals the verified tarball.
- `conflict`: the version exists with different content.

Safe recovery depends on that state.

### Nothing was published

For a transient validation, network, or approval failure with both versions absent, rerun the same workflow on the existing tag. Do not push the tag again.

### Root matches and Pi is absent

Rerun the workflow. It verifies and skips the matching root version, then publishes the Pi tarball. This is the only supported partial-publication continuation.

### Both packages match

If registry smoke or GitHub Release creation failed, rerun the failed workflow jobs. Publication verifies and skips both matching versions before continuing downstream.

If a GitHub Release already exists, recovery accepts only a non-draft, non-prerelease release for the same tag whose body contains every authored and generated block. Extra operator notes are allowed. A missing or altered Release Notes, Install, Validation, or Full changelog block stops recovery; the workflow does not overwrite the body. Compare it with `pnpm release:notes "$VERSION"`, restore the required blocks, and then rerun the job.

### Registry content conflicts

Stop if either version is `conflict`, or if Pi exists while root is absent. Do not overwrite, unpublish, move the remote tag, or blindly retry `npm publish`.

Prepare the next unused patch version on `main`, run the complete validation again, and create a new tag. After the replacement release is complete, deprecate an orphaned package version if one exists:

```bash
npm deprecate @ryonakae/shepherd@0.6.0 \
  "Incomplete paired release; use 0.6.1"
```

Use the actual orphaned package and replacement versions. Never put npm tokens, OTPs, or authentication output in the repository, shell history, release notes, or chat.
