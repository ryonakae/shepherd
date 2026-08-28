# npm CI and Release Automation Implementation Plan

**Status:** Active — authorized CI bootstrap fix validated locally; awaiting follow-up review and hosted rerun

**Progress:** 3 of 4 tasks complete

**Next steps:** Commit and review the clean-install bootstrap fix, push it, verify hosted `CI`, then continue Task 4. Keep the plan active through the first hosted CI run and external trust readback; archive it later in a separate docs-only commit.

> **For implementers:** Execute tasks in order unless dependencies allow otherwise. Mark a task complete only after its validation succeeds. Reflect minor implementation differences in the relevant task. Ask the user before changing requirements, Out of Scope, or public contracts.

## Problem Statement

Shepherd has thorough manual release instructions and package-content checks, but no hosted CI, automated npm publication, or repository-side publication approval. Releases depend on a maintainer executing a long sequence correctly. Version references have already drifted: the package manifests and Herdr plugin manifest are at `0.5.0`, while three install examples still reference `v0.4.0`.

## Goal

Provide a small, auditable GitHub Actions flow that validates every pull request and `main` push on Ubuntu, publishes the two public npm packages from stable version tags through npm Trusted Publishing after an explicit GitHub Environment approval, verifies the registry artifacts, and creates a GitHub Release. Provide one local command for synchronized release preparation and keep local and hosted package validation aligned.

## Out of Scope

- Publishing prerelease versions or managing npm dist-tags other than `latest`.
- Publishing `packages/shepherd-herdr-plugin` to npm.
- macOS CI or a multi-OS matrix.
- Configuring branch protection or repository rulesets.
- Automatically creating a version commit or release tag.
- Publishing a new npm version or pushing a release tag while implementing this plan.
- Making the two npm publications atomic; npm does not provide a transaction across packages.
- Changing Shepherd runtime behavior.

## Requirements and Decisions

### Requirements

- **R1:** Run hosted CI on every pull request and every push to `main` using Ubuntu, Node.js `24.18.0`, pnpm `11.9.0`, and the committed lockfile.
- **R2:** CI must run the existing full source checks, build the root package, create both public tarballs, install them into isolated prefixes, invoke the installed `shepherd help`, and verify the Pi package's expected include/exclude contract.
- **R3:** Provide `pnpm release:prepare <X.Y.Z>` for stable SemVer only. It must update the three package manifests, the Herdr plugin TOML manifest, and the three Herdr plugin install examples without partially writing files after a validation error.
- **R4:** A pushed `vX.Y.Z` tag must start the release workflow. The workflow must reject non-stable tags and any tag that does not equal the synchronized repository version before reaching publication approval.
- **R5:** The release workflow must rerun the complete validation and publish the exact tarballs that passed package smoke testing rather than relying on a separate CI run. It must record each tarball's npm integrity in the transferred artifact, recompute and match both integrities after artifact download before any publication, and compare them with the registry after publication or an ambiguous publish result.
- **R6:** Publish `@ryonakae/shepherd` first and `@ryonakae/shepherd-pi` second with public access and provenance through npm Trusted Publishing. Do not store or consume a long-lived npm token, and do not repack after release validation.
- **R7:** The npm publication job must use the GitHub Environment named `npm`, with `ryonakae` as a required reviewer and self-review allowed for this single-maintainer repository. Only that job receives `id-token: write`; GitHub Release creation receives `contents: write`; validation and registry smoke jobs remain read-only.
- **R8:** Before approval and again immediately before publishing, classify each exact version as absent, present with the expected integrity, or conflicting. After publication, verify the exact version and integrity. Install both packages from the registry in a separate job with no Environment or OIDC permission and rerun their smoke checks before creating a GitHub Release.
- **R9:** Create a non-draft, non-prerelease GitHub Release only after publication and unprivileged registry verification succeed. Its notes must combine GitHub-generated changes with both npm install commands and the fact that the Herdr plugin remains tag-distributed from GitHub.
- **R10:** Update maintainer documentation for the automated flow, one-time GitHub/npm setup, approval boundary, immutable-tag behavior, idempotent reruns, and recovery from validation or conflicting/partial-publication failures.
- **R11:** Before approval, verify that the tagged commit is contained in `origin/main`; a matching version on an unrelated commit must not be publishable.

### Implementation Decisions

- **D1:** Use separate `ci.yml` and `release.yml` workflows, following Zerdr's separation while avoiding its independent-release gap by rerunning all validation inside `release.yml`.
- **D2:** Keep the release trigger tag-based, but put publication behind the protected `npm` Environment.
- **D3:** Keep CI Ubuntu-only. Local macOS development already exercises the primary development platform; an OS matrix can be added when an observed platform-specific risk justifies it.
- **D4:** Build and smoke-test tarballs once in the release validation job, transfer them as a GitHub Actions artifact, and publish those tarballs in the approved job.
- **D5:** Keep version commits and stable tags maintainer-created and reviewable. Automation verifies them but does not create them.
- **D6:** Treat remote release tags as immutable and make reruns state-aware. If neither version exists, retry the same run safely. If a package already exists with the expected tarball integrity, skip republishing that package and continue in root-before-Pi order. If registry state conflicts with the verified tarballs, stop and use the next unused patch version. If both packages match but only GitHub Release creation failed, rerun only the downstream verification/release path without changing the tag.
- **D7:** Use the exact workflow filename `release.yml` and Environment name `npm` because npm Trusted Publishing binds both values.
- **D8:** Pin actions used by the write-capable release workflow to full commit SHAs with a human-readable version comment; version tags alone are not trusted in the publication path.

### Contracts

- Maintainer command: `pnpm release:prepare <X.Y.Z>`. The argument excludes the leading `v` and must match stable SemVer `X.Y.Z` with no prerelease/build suffix.
- Release tag: `vX.Y.Z`, exactly equal to `v` plus the synchronized repository version.
- Public npm artifacts: `@ryonakae/shepherd` and `@ryonakae/shepherd-pi` only.
- Private artifact invariant: `packages/shepherd-herdr-plugin/package.json` remains `private: true`.
- Trusted publisher binding for both public packages: repository `ryonakae/shepherd`, workflow `release.yml`, Environment `npm`, publish permission enabled.
- Release state ordering: validate source, main ancestry, tarballs, and preexisting registry state → wait for Environment approval → recheck registry state → publish-or-verify root → publish-or-verify Pi → unprivileged registry install smoke → create GitHub Release.
- Registry state contract for each package/version: `absent`; `expected` when `dist.integrity` equals the validated tarball manifest; `conflict` for any other published content. Only `absent` may be published, `expected` may be skipped, and `conflict` always stops the workflow.

## Current Context

### Confirmed

- There are currently no GitHub Actions workflows, branch protection rules, repository rulesets, or GitHub Environments.
- `pnpm check` covers typecheck, tests, Biome, Drizzle, root package content, Pi package content, and Herdr plugin package checks.
- `scripts/check-root-package.mjs` validates the root tarball allowlist and required CLI/migration files.
- `docs/releasing.md` currently documents a safe but manual two-package release and a root-first partial-publication recovery path.
- Local manifests, npm `latest`, Git tag `v0.5.0`, GitHub Release `v0.5.0`, and `HEAD` currently agree.
- `mise.toml` pins Node.js `24.18.0` and pnpm `11.9.0`. Node.js `24.18.0` includes npm `11.16.0` in the pinned mise installation.
- npm's official Trusted Publishing documentation requires npm CLI `11.5.1` or newer, Node.js `22.14.0` or newer, and `id-token: write`; the pinned Node/npm pair satisfies this.
- npm CLI dry-runs accept the intended trusted publisher bindings for both packages. Live `npm trust list` currently returns `E401`, so Task 4 requires the maintainer to establish an interactive npm CLI session first; no credential is added to the repository or chat.
- GitHub user `ryonakae` has numeric ID `6018455`, required by the Environment reviewer API.
- The repository currently has no Actions secrets.

### Assumptions

- Workflow action major versions may follow the current official examples at implementation time; the behavioral contracts and least-privilege permissions above remain fixed.
- Registry visibility may be briefly delayed, so exact-version and integrity verification may use bounded retries without changing publication order. An ambiguous `npm publish` result is never blindly retried: registry state is classified first.

## File Structure

- Create: `.github/workflows/ci.yml` — pull-request and `main` hosted validation.
- Create: `.github/workflows/release.yml` — stable-tag validation, approval-gated Trusted Publishing, registry smoke, and GitHub Release creation.
- Create: `scripts/prepare-release.mjs` — stable-version validation and synchronized release-file updates.
- Create: `scripts/check-release-packages.mjs` — tarball creation and isolated package smoke checks, with an output mode usable by the release workflow.
- Create: `scripts/verify-release-packages.mjs` — bounded artifact-set and post-download integrity verification shared by package smoke and release publication.
- Create: `scripts/release-registry.mjs` — resumable registry-state classification and root-before-Pi publication of verified tarball paths.
- Create: `scripts/validate-release-tag.mjs` — stable tag/package version validation and `origin/main` ancestry enforcement.
- Create: `test/unit/release-automation.test.ts` — release preparation, version-reference, workflow trigger, permission, and publication-order contracts.
- Modify: `package.json` — expose release preparation and package smoke scripts without changing published files.
- Modify: `test/unit/package-publication.test.ts` — retain publication metadata invariants and add any closely related manifest assertions not owned by the new test.
- Modify: `README.md` — synchronize the current Herdr plugin tag if required by the preparation contract.
- Modify: `README.ja.md` — synchronize the localized Herdr plugin tag.
- Modify: `packages/shepherd-herdr-plugin/README.md` — synchronize the package-local plugin tag.
- Modify: `docs/releasing.md` — replace manual publication steps with preparation, tag, approval, automated verification, one-time setup, and recovery procedures.
- Modify: `AGENTS.md` — document the new maintainer commands and workflow ownership where needed for future agents.

## Testing Decisions

- **Test seam:** Exercise release preparation against temporary fixture trees, parse workflow YAML as data, and execute package smoke against real `npm pack` tarballs and isolated npm prefixes.
- **Behavior:** Valid stable versions update every release reference; malformed or prerelease versions fail before writes; workflow contracts expose only the intended triggers and permissions; packed CLI and Pi extension install with the documented contents.
- **Prior art:** Extend `test/unit/package-publication.test.ts`, follow its manifest-reading style, and retain the real `npm pack` boundary used by `test/unit/herdr-plugin-package.test.ts` and `scripts/check-root-package.mjs`.
- **Avoid:** Do not unit-test incidental YAML formatting, action step display names, temporary directory names, or private helper structure. Do not publish test versions to npm.

## Progress

- [x] Task 1: Deterministic release preparation and version contracts
- [x] Task 2: Reusable package smoke validation and hosted CI
- [x] Task 3: Approval-gated Trusted Publishing and release documentation
- [ ] Task 4: External GitHub/npm trust configuration and non-publishing verification

Implementers must reflect minor file or implementation differences in the relevant task. They must ask the user before changing requirements, Out of Scope, or public contracts.

## Tasks

### Task 1: Deterministic Release Preparation and Version Contracts

**Covers:** R3, R4, R10, D5, D6

**Objective:** A maintainer can update every release-owned version reference with one stable-version command, and automated tests reject drift or unsupported versions.

**Files:**
- Create: `scripts/prepare-release.mjs`
- Create: `test/unit/release-automation.test.ts`
- Modify: `package.json`
- Modify: `test/unit/package-publication.test.ts`
- Modify: `README.md`
- Modify: `README.ja.md`
- Modify: `packages/shepherd-herdr-plugin/README.md`

**Dependencies:** Existing four-file version invariant in `test/unit/package-publication.test.ts`.

**Implementation notes:**
- Begin with failing tests for valid update, malformed/prerelease rejection, and no-write-on-validation-error behavior.
- Read and validate every source file and expected replacement before writing any file. A missing or ambiguous reference must fail rather than silently skip.
- Preserve JSON formatting and trailing newlines used by the repository.
- Keep tag-versus-version validation reusable by the release workflow or represent it as an explicit workflow check covered by the workflow contract test.
- Bring the three currently stale `v0.4.0` examples to the current `v0.5.0` baseline without changing package versions.

**Test cases:**
- Temporary fixture with synchronized `0.5.0`, prepared as `0.6.0` → all three JSON versions, TOML version, and three `--ref v0.6.0` examples update.
- Inputs such as `v0.6.0`, `0.6`, `0.6.0-beta.1`, `0.6.0+build.1`, `01.2.3`, or an extra argument → command fails and fixture contents remain unchanged.
- Missing, duplicate, or already-divergent expected references → command fails before writes and identifies the offending path.
- Repository manifests and README examples → all resolve to the same current stable version.

**Complete when:**
- `pnpm release:prepare <X.Y.Z>` has the agreed contract.
- Current stale plugin references are synchronized to `v0.5.0`.
- Focused tests prove successful updates and failure atomicity at the validation boundary.

**Validation:**
- Run: `pnpm vitest run test/unit/release-automation.test.ts test/unit/package-publication.test.ts`
- Expected: Both files pass, including stable-version, drift, and no-write failure cases.

**Implementation record (2026-08-28):**
- Added `scripts/prepare-release.mjs`, exposed `pnpm release:prepare`, and synchronized the three Herdr install examples to `v0.5.0`.
- Added CLI-boundary fixture tests for stable updates, malformed inputs, divergent manifests, missing TOML versions, duplicate README references, and no writes after validation failures.
- Validation passed: 2 files, 12 tests.

### Task 2: Reusable Package Smoke Validation and Hosted CI

**Covers:** R1, R2, R5, D1, D3, D4

**Objective:** Every pull request and `main` push proves that a clean Ubuntu checkout passes all checks and produces installable public package tarballs.

**Files:**
- Create: `scripts/check-release-packages.mjs`
- Create: `.github/workflows/ci.yml`
- Modify: `package.json`
- Modify: `test/unit/release-automation.test.ts`
- Modify: `AGENTS.md`

**Dependencies:** Task 1's release contract test and existing package checks.

**Implementation notes:**
- Use the pinned Node and pnpm versions and `pnpm install --frozen-lockfile`.
- Keep workflow permissions at `contents: read`.
- The package smoke command must pack both public packages, reject unexpected tarball count/names, record the npm-reported integrity for each tarball in a bounded machine-readable manifest, install into fresh prefixes, execute the installed CLI help, and check the Pi package include/exclude contract.
- Support a caller-provided artifact output directory for release use; retain exactly the two tarballs plus integrity manifest there. Use a temporary directory and clean it when no output is requested.
- CI must not need npm credentials and must never invoke `npm publish`.

**Test cases:**
- Parsed `ci.yml` → triggers on pull requests and `main` pushes only, runs on Ubuntu, has read-only contents permission, uses frozen install, and invokes full checks plus package smoke.
- Package smoke on the current checkout → exactly two expected tarballs are created, both install, CLI help exits successfully, Pi `src/index.ts` exists, and Pi `tsconfig.json` is absent.
- Caller-provided output directory → validated tarballs remain available to a later workflow job.

**Complete when:**
- Local package smoke reproduces the release artifact checks in `docs/releasing.md`.
- CI workflow contains no write or OIDC permission and no publication path.
- Focused workflow-contract tests and real package smoke pass.

**Validation:**
- Run: `pnpm vitest run test/unit/release-automation.test.ts test/unit/package-publication.test.ts test/unit/herdr-plugin-package.test.ts`
- Expected: Workflow and package metadata contracts pass.
- Run: `pnpm build && pnpm package:smoke`
- Expected: Two tarballs are packed and installed in isolation; installed CLI and Pi content checks pass.

**Implementation record (2026-08-28):**
- Added SHA-pinned Ubuntu CI for pull requests and `main`, using Node.js `24.18.0`, package-manager-pinned pnpm, frozen install, full checks, build, and package smoke.
- Added `scripts/check-release-packages.mjs` and `pnpm package:smoke`; it packs build output without rerunning lifecycle scripts, writes two tarballs plus `release-packages.json`, and verifies isolated root/Pi installations.
- Validation passed: 3 focused files / 18 tests, clean build, and real smoke installation for both `0.5.0` tarballs.
- Hosted run `33137281469` exposed that `pnpm:devPreinstall` invokes Husky before dependencies exist in a clean checkout. With explicit user authorization after the correction budget, CI and release validation now install with `--ignore-scripts` and run `pnpm rebuild`; a clean archive then passed install, allowed dependency builds, and the complete `pnpm check`.

### Task 3: Approval-Gated Trusted Publishing and Release Documentation

**Covers:** R4, R5, R6, R7, R8, R9, R10, R11, D1, D2, D4, D6, D7, D8

**Objective:** A stable tag runs full validation, waits for one protected-environment approval, publishes and verifies both exact tarballs without a token, and creates the GitHub Release only after registry smoke succeeds.

**Files:**
- Create: `.github/workflows/release.yml`
- Create: `scripts/verify-release-packages.mjs`
- Create: `scripts/release-registry.mjs`
- Create: `scripts/validate-release-tag.mjs`
- Modify: `scripts/check-release-packages.mjs`
- Modify: `test/unit/release-automation.test.ts`
- Modify: `docs/releasing.md`
- Modify: `AGENTS.md`

**Dependencies:** Tasks 1 and 2; the package smoke output contract.

**Implementation notes:**
- Restrict the trigger and runtime validation to stable `vX.Y.Z` tags. GitHub glob filtering is not sufficient by itself; validate the complete tag, synchronized manifest value, and containment of the tagged commit in fetched `origin/main` before publication.
- The validation job reruns source checks, build, and package smoke, writes a bounded artifact manifest containing the two expected tarball names and npm integrity values, confirms both registry versions are absent or already equal to those integrities, then uploads only that manifest and those tarballs.
- The publication job uses `environment: npm`, `contents: read`, and `id-token: write`; it downloads but never repacks the verified tarballs. Before querying registry state, it rejects missing or extra files and recomputes each tarball's npm-compatible integrity from the downloaded bytes, failing unless both names and integrities match the bounded manifest. Immediately before each publication it reclassifies registry state. It passes each concrete tarball path to `npm publish --access public --provenance` only when absent, skips an already matching package, and fails on a conflict.
- After an ambiguous publication result, classify exact version and integrity before deciding whether the step succeeded. Never blindly retry `npm publish`.
- Put registry installation in a later Ubuntu job with `contents: read`, no Environment, and no `id-token` permission. It installs both exact versions in fresh prefixes, runs installed CLI help, and verifies Pi `src/index.ts` is present while `tsconfig.json` is absent.
- Keep GitHub Release creation after registry smoke in a job with `contents: write` but no OIDC permission.
- Generate release changes through GitHub and prepend or append the required install and Herdr distribution notes.
- Rewrite recovery instructions for remote immutable tags: pre-publication validation/transient failure, a matching root with absent Pi, conflicting published content, both matching packages with downstream failure, and GitHub Release-only failure each need an explicit safe action.
- Pin every action in the release workflow to a full commit SHA and annotate the intended action version.

**Test cases:**
- Parsed `release.yml` → stable tag trigger, explicit full-tag/version/main-ancestry validation, bounded tarball manifest handoff, `npm` Environment, least-privilege job permissions, concrete tarball publication flags, root-before-Pi state handling, exact integrity verification, unprivileged registry smoke, and release-after-smoke ordering are present.
- A tag/version mismatch, prerelease tag, or tagged commit outside `origin/main` → validation job fails before the protected publication job.
- Registry states `(root absent, Pi absent)`, `(root expected, Pi absent)`, and `(root expected, Pi expected)` → publish both, publish only Pi, and skip both respectively while retaining downstream verification. Any conflicting integrity or `(root absent, Pi present)` → fail without publication.
- Either npm publication/integrity verification or the unprivileged registry smoke fails → GitHub Release job cannot run.
- Missing, extra, renamed, or byte-modified downloaded tarball → publication job fails before registry classification or `npm publish`.
- Static workflow contract → downloaded artifact names and recomputed integrities are checked before registry access; `npm publish` then receives the two verified artifact tarball paths directly with public access and provenance, and no publish step runs `npm pack`.
- Documentation → identifies both public packages, the private Herdr plugin, Trusted Publishing prerequisites, approval, immutable tags, idempotent matching-state reruns, and conflict recovery without advising tag movement, unpublish, or OTP/token handling.

**Complete when:**
- Static workflow contract tests prove the agreed trigger, permission, environment, ordering, and failure gates.
- `docs/releasing.md` is executable as a maintainer procedure and no longer instructs manual `npm publish`.
- No repository secret or token is introduced.

**Validation:**
- Run: `pnpm vitest run test/unit/release-automation.test.ts test/unit/package-publication.test.ts`
- Expected: Release workflow and documentation-adjacent invariants pass.
- Run: `git grep -nE 'NODE_AUTH_TOKEN|NPM_TOKEN|--otp' -- .github scripts package.json docs/releasing.md`
- Expected: No long-lived npm credential or OTP path is present; any output must be an explicit negative warning in documentation and reviewed manually.
- Run: `pnpm vitest run test/unit/release-automation.test.ts -t 'release workflow'`
- Expected: Trigger, main ancestry, artifact integrity, state classification, concrete publish flags, permission boundaries, unprivileged smoke, and release ordering contracts pass.

**Implementation record (2026-08-28):**
- Added the stable-tag release workflow with strict tag/main validation, verified artifact upload/download, `npm` Environment approval, OIDC publication, unprivileged registry smoke, and generated GitHub Release notes.
- Added bounded artifact integrity verification and resumable registry-state publication helpers; fake-registry tests verify root-before-Pi tarball publication with public provenance flags.
- Replaced manual publication documentation with Trusted Publishing setup, approval, immutable-tag, idempotent rerun, and conflict recovery procedures; updated AGENTS workflow ownership.
- Initial validation passed: actionlint for both workflows, typecheck, 2 focused files / 20 tests, credential-reference check, and the Task 2 package smoke rerun after integrating artifact verification.
- Independent review correction cycle 1 added executable stable tag/version/main ancestry tests, registry-state process tests, ambiguous publication, delayed visibility retry, post-publish integrity conflict, and artifact-before-registry ordering. Corrected validation passed: actionlint, typecheck, and 2 focused files / 36 tests.
- Scoped re-review correction cycle 2 closed three remaining false-positive paths: `absent/conflict` now proves zero publication, ambiguous/delayed modes assert ordered registry verification before Pi publication, and malformed tags assert the validation-specific error with zero Git calls. Corrected validation passed: actionlint, typecheck, and 2 focused files / 37 tests.

### Task 4: External GitHub/npm Trust Configuration and Non-Publishing Verification

**Covers:** R6, R7, R10, D2, D7

**Objective:** Repository and npm settings enforce the approval and OIDC bindings expected by the committed workflow without publishing a package.

**Files:**
- External: GitHub Environment `ryonakae/shepherd:npm`
- External: npm trusted publisher for `@ryonakae/shepherd`
- External: npm trusted publisher for `@ryonakae/shepherd-pi`

**Dependencies:** Task 3 merged or pushed to the default branch so npm can bind the existing `.github/workflows/release.yml`; explicit user confirmation immediately before external mutation remains required by the agreed operating procedure.

**Implementation notes:**
- Configure GitHub Environment `npm` with user ID `6018455` (`ryonakae`) as required reviewer and `prevent_self_review: false`. This explicitly allows the sole maintainer who pushes the tag to approve the deployment; the reviewer requirement itself must remain enabled.
- After explicit confirmation immediately before mutation, configure only the required Environment fields with `printf '%s\n' '{"wait_timer":0,"prevent_self_review":false,"reviewers":[{"type":"User","id":6018455}]}' | gh api --method PUT repos/ryonakae/shepherd/environments/npm --input -`. Do not alter deployment branch policies or unrelated settings.
- After `release.yml` exists on the default branch and `mise exec node@24.18.0 -- npm whoami` prints `ryonakae`, run `mise exec node@24.18.0 -- npm trust github @ryonakae/shepherd --file release.yml --repo ryonakae/shepherd --env npm --allow-publish --yes` and the same command for `@ryonakae/shepherd-pi`.
- Do not create an npm automation token or repository secret. Before mutation, record `gh api repos/ryonakae/shepherd/actions/secrets --jq '.secrets[].name'`; after mutation, confirm the list is unchanged.
- Because this task changes external services and depends on the workflow existing on the default branch, leave it incomplete until those settings are applied and machine-readable `jq -e` checks pass.

**Test cases:**
- GitHub Environment API readback → `npm` exists, required reviewers include user ID `6018455`, and `prevent_self_review` is false.
- `npm trust list @ryonakae/shepherd` → exact GitHub repository/workflow/environment binding with publish permission.
- `npm trust list @ryonakae/shepherd-pi` → the same exact binding for the Pi package.
- `gh api repos/ryonakae/shepherd/actions/secrets --jq '.secrets[].name'` → no npm credential secret was added by this work.

**Complete when:**
- Both external trust configurations match the committed workflow exactly.
- Required reviewer protection is visible through GitHub API readback.
- No release tag or npm version was created during setup.

**Validation:**
- Run: `gh api repos/ryonakae/shepherd/environments/npm | jq -e 'any(.protection_rules[]; .type == "required_reviewers" and .prevent_self_review == false and any(.reviewers[]; .reviewer.id == 6018455))'`
- Expected: Returns `true`, proving the required reviewer and self-review policy together.
- Run: `mise exec node@24.18.0 -- npm whoami`
- Expected: Prints `ryonakae`; if it returns `E401`, the maintainer authenticates interactively before continuing.
- Run: `mise exec node@24.18.0 -- npm trust list @ryonakae/shepherd --json`
- Expected: The machine-readable response contains exactly one active GitHub binding naming repository `ryonakae/shepherd`, file `release.yml`, Environment `npm`, and publish permission; record the observed response shape in Task 4 before marking it complete.
- Run: `mise exec node@24.18.0 -- npm trust list @ryonakae/shepherd-pi --json`
- Expected: The Pi package's machine-readable response contains the same exact binding.
- Run: `gh api repos/ryonakae/shepherd/actions/secrets --jq '.secrets[].name'`
- Expected: No npm token secret name was introduced by this work; compare with the pre-change empty/current list recorded before mutation.

## Requirement Coverage

| Requirement / Decision | Task | Verification |
|---|---|---|
| R1, D3 | Task 2 | Parsed CI trigger/runner test and hosted run after push |
| R2 | Task 2 | Real tarball isolated-install smoke |
| R3, D5 | Task 1 | Temporary-fixture preparation tests |
| R4 | Tasks 1, 3 | Stable-version tests and complete tag/version workflow assertion |
| R5, D1, D4 | Tasks 2, 3 | Shared package smoke, bounded artifact set, post-download integrity recomputation, and handoff assertions |
| R6 | Tasks 3, 4 | Publication-order test and npm trust readback |
| R7, D2, D7 | Tasks 3, 4 | Job permission/environment test and GitHub Environment readback |
| R8 | Task 3 | Exact-version and registry-install workflow assertions |
| R9 | Task 3 | Release job dependency and notes-content assertions |
| R10, D6 | Tasks 1, 3, 4 | Maintainer command tests, state-aware recovery tests, and manual documentation review |
| R11 | Task 3 | `origin/main` ancestry check and failure-case workflow assertion |
| D8 | Task 3 | Full action-SHA assertions for the release workflow |

## Final Validation

- [ ] `pnpm vitest run test/unit/release-automation.test.ts test/unit/package-publication.test.ts test/unit/herdr-plugin-package.test.ts` — Expected: all focused release/package tests pass.
- [x] `pnpm check` — Passed locally: typecheck, 31 test files / 262 tests, Biome, Drizzle, root package, Pi package, and Herdr plugin checks.
- [ ] `pnpm build && pnpm package:smoke` — Expected: clean build plus isolated installation of both generated public tarballs succeeds.
- [ ] `git diff --check` — Expected: no whitespace errors.
- [ ] Manual workflow review — Expected: only the publication job has `id-token: write` and `environment: npm`; only the GitHub Release job has `contents: write`; no npm token is referenced.
- [ ] Hosted CI after push — Initial run `33137281469` failed at `pnpm install --frozen-lockfile` because clean checkout executes `pnpm:devPreinstall` before Husky exists. Authorized follow-up fix passed a clean-archive `install --ignore-scripts → rebuild → pnpm check`; hosted rerun remains pending.
- [ ] GitHub Environment and npm trust readbacks from Task 4 — Expected: required reviewer and both exact trusted publisher bindings are active. This remains pending until the workflow exists on the default branch.
- [ ] N/A: no live release workflow is triggered during implementation because publishing a new version/tag is explicitly out of scope.
- [ ] Requirement Coverage has no unassigned requirement or decision.
- [ ] Plan and actual changes agree, including any minor implementation differences recorded in the relevant task.
- [ ] After every item above succeeds, move this plan unchanged in name to `docs/plans/archived/2026-08-28-npm-ci-release-automation.md` in a separate docs-only commit, as required by repository plan/archive policy.

## Review Gate Summary

- Review range: `e70961a1d821b92e5afc500ecb60a23f6b9c1b3d..f932e824455419d338212879050d91730097ec6a`.
- Initial independent review found one blocking/high test-coverage gap. Correction commit `57850ad847435c685e099c86e6d83539e8e3cc48` added executable release safety paths.
- Scoped re-review found three remaining false-positive test paths. Correction commit `f932e824455419d338212879050d91730097ec6a` closed all three.
- Because both prior reviewer contexts were cleaned by the harness, the user explicitly authorized one fresh final scoped reviewer. That review approved `f932e824455419d338212879050d91730097ec6a` with no blocking/high or decision-required findings.
- Automatic review correction cycles used: 2 of 2. Unresolved blocking/high or decision-required findings: none.
- After the approved review was pushed, hosted CI exposed a pre-validation Husky bootstrap failure. The user explicitly authorized one post-review CI fix; its scope is limited to `--ignore-scripts` installation followed by allowed dependency rebuild in CI and release validation.
- Original medium/low findings were intentionally not changed under the implementation review policy: existing GitHub Release notes are not revalidated on idempotent rerun, and deterministic pre-publication tag errors could be documented more explicitly in a future docs-only improvement.

## Risks and Open Questions

- A tag exists remotely before validation and publication complete. Recovery must use the next unused patch version rather than mutate that tag.
- The two npm publishes remain non-atomic. Root-first ordering preserves the current documented recovery direction, and GitHub Release creation remains blocked until both packages verify.
- GitHub-generated release notes depend on repository history and previous releases; fixed installation and Herdr distribution text must not depend on generated content.
- External Environment and npm trust setup cannot be completed safely until `release.yml` is present on the default branch. The plan therefore remains active if code validation passes but hosted/external activation is still pending.
- The npm CLI is not currently authenticated for trust readback (`E401`). Task 4 requires an interactive maintainer login after the workflow reaches the default branch; this is an operational prerequisite, not a repository credential.
- Both prior reviewer contexts were cleaned by the harness; the explicitly authorized fresh final scoped review approved the completed corrections.
- Hosted CI run `33137281469` exposed a clean-install bootstrap failure in the pre-existing `pnpm:devPreinstall: husky` path. The authorized workflow-only fix passed a clean archive with `pnpm rebuild`; the external Environment/npm trust setup remains untouched until the hosted rerun passes.
- No unresolved product or publication behavior remains.
