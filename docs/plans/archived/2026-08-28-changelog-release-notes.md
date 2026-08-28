# Changelog-backed Release Notes Implementation Plan

> **For implementers:** Execute tasks in order unless dependencies allow otherwise. Mark a task complete only after its validation succeeds. Reflect minor implementation differences in the relevant task. Ask the user before changing requirements, Out of Scope, or public contracts.

**Status:** Complete

**Next steps:** Archive this plan in the required docs-only commit, then push the complete commit series to `origin/main` once.

## Problem Statement

Shepherd's release workflow currently asks GitHub to generate notes from the tag range. Because development lands as direct commits rather than pull requests, `v0.6.0` received only a Full Changelog link and no user-facing summary. The release was repaired manually, but neither the repository nor CI requires future releases to contain feature, behavior, or breaking-change notes.

## Goal

Make `CHANGELOG.md` the version-controlled source for GitHub Release notes. A stable release must fail before npm publication unless the target version has a valid Keep a Changelog section. The workflow must combine that section with deterministic install, validation, and comparison sections, while preserving the existing trusted-publication and recovery guarantees.

## Out of Scope

- Accumulating entries under an `Unreleased` section during feature development.
- Generating user-facing change prose from commits, pull requests, or an LLM.
- Changing npm Trusted Publishing, package ordering, tarball integrity, registry recovery, tag immutability, or Homebrew/plugin distribution.
- Rewriting the body of an already published GitHub Release as part of this implementation.
- Requiring every development commit to modify `CHANGELOG.md`; notes are written during release preparation.

## Requirements and Decisions

### Requirements

- **R1:** Add a root `CHANGELOG.md` containing the `v0.1.0` through `v0.6.0` history. Derive `v0.1.0`, which has no GitHub Release, from its tagged repository snapshot and commit history; derive `v0.2.0` onward from existing GitHub Release bodies rather than inferring changes from current code.
- **R2:** A release section must use a `## vX.Y.Z` heading and contain at least one allowed Keep a Changelog category and at least one bullet.
- **R3:** Allowed `###` categories are `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, and `Security`. Unknown categories, duplicate versions, empty categories, and sections without bullets are invalid.
- **R4:** Breaking changes are represented by a bullet beginning with `**Breaking:**`; a dedicated breaking-change section is not required when no breaking change exists.
- **R5:** `pnpm release:prepare X.Y.Z` must validate the target changelog section before writing any release-owned file. Missing or invalid notes leave all version references untouched.
- **R6:** The normal repository check must require the latest changelog version to equal the root package version.
- **R7:** A stable tag run must revalidate the exact tag version's changelog section before package build, artifact upload, environment approval, or npm publication.
- **R8:** The GitHub Release body must contain the target changelog content plus workflow-generated exact-version Install, Validation, and Full changelog sections.
- **R9:** Existing-release recovery must not silently accept a draft, prerelease, wrong tag, or release body that lacks the generated required content.
- **R10:** Release documentation must make changelog authoring and preview part of the mandatory preparation sequence.

### Implementation Decisions

- **D1:** Follow Zerdr's release-time version-section model rather than an `Unreleased` section or per-version note files.
- **D2:** Implement a repository-owned parser/renderer instead of relying on GitHub `generate-notes`; direct commits do not produce useful generated bullets.
- **D3:** Make validation stricter than cargo-dist: a missing version section is fatal rather than logged and skipped.
- **D4:** Preserve the changelog section's authored Markdown in the release body; generate mechanical sections from package metadata and the ordered version history.
- **D5:** Run the same parser at local preparation, normal checks, tag validation, release rendering, and tests so those gates cannot drift.
- **D6:** Derive the Full changelog comparison base from the next older version entry in `CHANGELOG.md`; do not ask release operators to supply a previous tag manually.
- **D7:** Render notes from the immutable tagged checkout in the final GitHub Release job. The validation job must also render them before publication to prove the final body can be produced.
- **D8:** Use the `v0.1.0` tag snapshot and commit history as a one-time historical source exception because no GitHub Release exists for that tag; all later entries remain sourced from their published Release bodies.

### Contracts

The changelog accepts release entries in descending version order:

```markdown
## v0.7.0

_2026-09-01_

### Added

- A user-visible change.

### Changed

- **Breaking:** A removed or incompatible behavior.
```

- Before the first category, a section may contain either no content or one italic ISO date line. Other prose, comments, or Markdown blocks are invalid.
- Every category present must contain at least one top-level `- ` bullet; wrapped bullet continuation lines remain part of the authored Markdown.
- The first release heading is the latest release. Default repository validation compares it with `package.json.version`.
- The release-note tool exposes CLI operations equivalent to:
  - `check` — read `package.json.version`, validate the whole changelog, and require the latest section to match.
  - `check X.Y.Z` — validate the whole changelog and require `vX.Y.Z` to be the latest section, without requiring the current package version to have been updated yet.
  - `render X.Y.Z` — validate and print the complete deterministic GitHub Release body for a version that has a next-older changelog entry to use as its comparison base. The migrated oldest entry validates as history but is not a render target.
- `render` emits `# Shepherd vX.Y.Z`, the authored release section under `## Release Notes`, exact-version npm and plugin install commands, fixed Validation claims that are true only after the workflow's prerequisite jobs, and a `vPREVIOUS...vCURRENT` comparison URL.
- CLI misuse and invalid changelog content exit non-zero with a message naming the version, section, or category that failed.

## Current Context

### Confirmed

- Root package version, Pi package version, private Herdr plugin package/TOML version, and three plugin install examples are synchronized by `scripts/prepare-release.mjs`.
- `scripts/prepare-release.mjs` validates every source before its `Promise.all(writeFile(...))`, providing an existing all-or-nothing preflight pattern.
- `scripts/validate-release-tag.mjs` currently validates stable tag syntax, package version equality, and membership in `origin/main`.
- `.github/workflows/release.yml` publishes only after `validate`, then runs registry smoke before creating the GitHub Release.
- The current GitHub Release job calls `releases/generate-notes`, which returned only a Full Changelog link for `v0.6.0`.
- Zerdr uses cargo-dist to extract a matching `CHANGELOG.md` section, but cargo-dist 0.32.0 continues without notes when no section matches. Shepherd will fail instead.
- Existing release automation tests use temporary repository fixtures and parse the workflow YAML, so changelog and workflow guarantees can be tested without publishing.
- Local `pnpm check` must run with `HERDR_*` removed in a Herdr shell because one Pi test intentionally models execution outside Herdr.

### Assumptions

- Internal parser function names and module boundaries may change to fit the existing script style, provided the documented CLI operations and failure behavior remain stable.
- Historical release entries may normalize headings into the allowed categories while preserving the facts and user-facing wording from published release bodies.

## File Structure

- Create: `CHANGELOG.md` — source-controlled published release history and future release-note input.
- Create: `scripts/release-notes.mjs` — changelog parser, validator, release-body renderer, and CLI entry point.
- Modify: `scripts/prepare-release.mjs` — validate target notes before constructing or writing version updates.
- Modify: `scripts/validate-release-tag.mjs` — enforce changelog/tag alignment before release work proceeds.
- Modify: `package.json` — add changelog/release-note commands and include changelog validation in `pnpm check`.
- Modify: `.github/workflows/release.yml` — validate/render notes before publication and create or verify the release from deterministic notes.
- Modify: `test/unit/release-automation.test.ts` — fixture, parser, atomic preparation, tag gate, rendering, and workflow-order tests.
- Modify: `test/unit/package-publication.test.ts` — repository-level version/changelog synchronization assertion if it fits the existing publication contract seam.
- Modify: `docs/releasing.md` — mandatory changelog authoring, preview, failure, and recovery instructions.
- Modify: `AGENTS.md` — identify `CHANGELOG.md` as the release-note source and list the maintainer-facing preview/check command if needed for correct operation.
- Modify: `docs/plans/2026-08-28-changelog-release-notes.md` — progress and implementation differences; archive after all validation succeeds.

## Testing Decisions

- **Test seam:** Execute the `.mjs` CLIs against temporary repository fixtures and parse `.github/workflows/release.yml`; do not test private parser helpers by shape alone.
- **Behavior:** Cover valid multi-version extraction/rendering, package/latest synchronization, missing target versions, duplicate/out-of-order versions, unknown/empty categories, missing bullets, atomic `release:prepare` failure, tag-gate ordering, generated install/validation/comparison content, and existing-release body verification.
- **Prior art:** Reuse `createReleaseFixture`, `runPrepare`, `readReleaseFiles`, fake git commands, and workflow YAML assertions in `test/unit/release-automation.test.ts`.
- **Avoid:** Network calls, npm publication, GitHub Release mutation, snapshots of the entire body when focused semantic assertions prove the contract, and tests coupled to private parsing data structures.

## Progress

- [x] Task 1: Versioned changelog contract and historical source
- [x] Task 2: Atomic preparation and tag gates
- [x] Task 3: Deterministic GitHub Release composition
- [x] Task 4: Maintainer workflow documentation and final validation

Implementers must reflect minor file changes or implementation differences in the relevant task. They must ask the user before changing requirements, Out of Scope, or public contracts.

## Tasks

### Task 1: Versioned changelog contract and historical source

**Covers:** R1, R2, R3, R4, R6, D1, D2, D3, D4, D5

**Objective:** Establish a validated `CHANGELOG.md` that records existing releases and can serve as the sole authored input for future notes.

**Files:**
- Create: `CHANGELOG.md`
- Create: `scripts/release-notes.mjs`
- Modify: `package.json`
- Test: `test/unit/release-automation.test.ts`
- Test: `test/unit/package-publication.test.ts`

**Dependencies:** The `v0.1.0` tag snapshot and commit history, existing GitHub Release bodies for `v0.2.0` through `v0.6.0`, and current package version `0.6.0`.

**Implementation notes:**
- Inspect `v0.1.0` with `git show v0.1.0:README.md`, `git show --stat v0.1.0`, and the commit range ending at the tag; use only externally meaningful facts supported by that snapshot/history.
- Retrieve later sources with `gh release view <tag> --repo ryonakae/shepherd --json tagName,publishedAt,body` for `v0.2.0` through `v0.6.0`, including `v0.3.1`. Confirm all six published Releases are returned before authoring the migration.
- Populate historical entries only from those approved sources and dates. Reclassify content into the agreed Keep a Changelog categories; omit mechanical install/validation/package-content sections and do not add unsupported claims.
- Parse release boundaries from level-two stable-version headings. Reject duplicates and non-descending release order so comparison links remain deterministic.
- Preserve the raw Markdown belonging to the target version for release rendering after structural validation.
- Default `check` must read the root manifest and enforce that the first changelog version equals it.
- `check X.Y.Z` supports the pre-update release flow: the proposed section must already be first and valid while package manifests still contain the previous version.
- Add a package script for the normal changelog gate and a package script for previewing rendered release notes. Include the default gate in `pnpm check` without weakening existing checks.

**Test cases:**
- Valid ordered history with one or more allowed categories and bullets → validation succeeds and extraction preserves authored Markdown.
- Latest changelog version differs from `package.json.version` → default check fails with both versions in the error.
- Explicit target exists but is not the first entry → target check fails.
- Missing target, duplicate version, ascending/out-of-order version, unknown `###` category, empty category, and no top-level bullet → each fails non-zero with a specific error.
- A bullet beginning `**Breaking:**` under an allowed category → accepted and preserved.
- Historical repository changelog → latest version is `v0.6.0`, every `v0.1.0` through `v0.6.0` section validates, the `v0.1.0` bullets trace to its tag snapshot/history, and every later bullet traces to one of the six retrieved release bodies.

**Complete when:**
- `CHANGELOG.md` contains the agreed history and no unsupported claims.
- The CLI contracts for `check`, `check X.Y.Z`, and extraction needed by rendering are covered by fixture tests.
- `pnpm check` invokes the default changelog gate.

**Validation:**
- Run: `git show v0.1.0:README.md >/dev/null && git log --reverse --oneline v0.1.0`
- Expected: the tagged README and commit range are available as the approved `v0.1.0` source.
- Run: `for tag in v0.2.0 v0.3.0 v0.3.1 v0.4.0 v0.5.0 v0.6.0; do gh release view "$tag" --repo ryonakae/shepherd --json tagName,publishedAt,body; done`
- Expected: six source records are returned with matching tags, publication dates, and non-empty bodies; migrated user-facing bullets can be checked against these records.
- Run: `pnpm exec vitest run test/unit/release-automation.test.ts test/unit/package-publication.test.ts`
- Expected: all changelog contract, repository synchronization, and existing release automation tests pass.
- Run: `pnpm changelog:check`
- Expected: exits zero with `package.json.version` and the latest changelog entry both at `0.6.0`.

**Implementation result:**
- Added `CHANGELOG.md` with seven validated entries. `v0.1.0` uses the approved tag snapshot/history exception; `v0.2.0` through `v0.6.0` use published Release bodies.
- Added `scripts/release-notes.mjs` with shared parsing, structural validation, latest-version checks, and deterministic rendering used by the public CLI seam.
- Added `changelog:check` and `release:notes`; `pnpm check` now includes the changelog gate.
- Validation: focused release/publication tests passed (47 tests), `pnpm changelog:check` printed `0.6.0`, and targeted Biome checks passed.

### Task 2: Atomic preparation and tag gates

**Covers:** R5, R7, D3, D5

**Objective:** Prevent version writes and publication when target release notes are missing or invalid.

**Files:**
- Modify: `scripts/prepare-release.mjs`
- Modify: `scripts/validate-release-tag.mjs`
- Modify: `test/unit/release-automation.test.ts`

**Dependencies:** Task 1's changelog validation interface.

**Implementation notes:**
- Run target changelog validation before `prepare-release.mjs` queues any update. Keep its existing validate-all-then-write-all atomic behavior.
- Include `CHANGELOG.md` in fixture setup and unchanged-file assertions even though preparation does not rewrite it.
- Extend stable tag validation to check the exact tag version against the latest valid changelog entry before fetching or checking ancestry where possible.
- Preserve existing argument validation, synchronized manifest checks, and git ancestry behavior.

**Test cases:**
- Valid `vNEXT` section plus synchronized old release files → `release:prepare NEXT` updates the seven existing release-owned references and leaves `CHANGELOG.md` unchanged.
- Missing, malformed, or non-latest `vNEXT` section → preparation fails and byte-for-byte snapshots of every release-owned file and `CHANGELOG.md` remain unchanged.
- Stable tag matching package and changelog → tag validator continues to origin/main ancestry checks and succeeds.
- Tag/package match with missing or different latest changelog version → validator fails before invoking fake git.
- Existing invalid tag and manifest-divergence cases → retain their current failures.

**Complete when:**
- No release-owned file can change before a valid target changelog section exists.
- No tag run can reach artifact work with changelog/tag/package disagreement.
- Focused release automation tests pass.

**Validation:**
- Run: `pnpm exec vitest run test/unit/release-automation.test.ts`
- Expected: atomic preparation and pre-git tag rejection cases pass together with all existing publication safety tests.

**Implementation result:**
- `release:prepare` now validates the proposed latest changelog section before reading or writing release-owned version files.
- Stable tag validation now checks package/tag/changelog agreement before invoking git fetch or ancestry checks.
- Release fixtures include `CHANGELOG.md`; atomic failure snapshots prove missing target notes leave all release inputs unchanged.
- Validation: `test/unit/release-automation.test.ts` passed all 48 tests, including pre-write and pre-git failure cases.

### Task 3: Deterministic GitHub Release composition

**Covers:** R7, R8, R9, D2, D4, D6, D7

**Objective:** Replace GitHub-generated notes with a deterministic body backed by the validated changelog and reject incomplete existing releases.

**Files:**
- Modify: `scripts/release-notes.mjs`
- Modify: `.github/workflows/release.yml`
- Modify: `test/unit/release-automation.test.ts`

**Dependencies:** Tasks 1 and 2.

**Implementation notes:**
- `render X.Y.Z` must derive the previous tag from the next older changelog section and produce exact-version commands for the root npm package, Pi package, and Herdr plugin.
- Validation prose must make only claims guaranteed by job dependencies: source/package checks, prepublication tarball verification, postpublication integrity verification, and fresh registry installation.
- Add a render step to `validate` before artifact upload/publication. Rendering failure must block the `npm` Environment.
- Replace `releases/generate-notes` in `github-release` with the repository renderer. Check out the tagged commit using a SHA-pinned action before rendering.
- On recovery, an existing release must match the requested tag, remain non-draft/non-prerelease, and contain the authored release-notes block plus every generated Install, Validation, and Full changelog block after newline normalization. Additional operator-authored text is allowed. Missing or altered required blocks fail instead of silently succeeding or overwriting the release.
- Preserve `--verify-tag`, exact target commit, latest-release behavior, artifact integrity, publish ordering, and recovery for partial npm publication.

**Test cases:**
- Render `0.6.0` fixture history → body contains authored categories/bullets, exact `@0.6.0` installs, plugin `v0.6.0`, validation claims, and `v0.5.0...v0.6.0` link.
- Render an unknown version or the migrated oldest version, which has no comparison base → fail with an actionable error explaining that render targets require a next-older changelog entry.
- Workflow parse → changelog/tag validation and render occur in `validate` before artifact upload; publication still depends on `validate`; GitHub Release still depends on registry smoke.
- Workflow source → no `releases/generate-notes`; final job uses the renderer output and a SHA-pinned checkout.
- Existing complete release containing every required authored/generated block, with or without extra operator-authored text → recovery exits zero without recreating it.
- Existing release with missing or altered required blocks, draft/prerelease state, or wrong tag → recovery fails.

**Complete when:**
- A valid changelog deterministically produces the complete GitHub Release body.
- Missing notes cannot pass either initial publication or existing-release recovery.
- Workflow safety and ordering assertions all pass.

**Validation:**
- Run: `pnpm release:notes 0.6.0`
- Expected: output contains the `v0.6.0` authored changes, exact install commands, workflow-backed validation text, and the `v0.5.0...v0.6.0` comparison URL.
- Run: `pnpm exec vitest run test/unit/release-automation.test.ts`
- Expected: renderer, workflow ordering, recovery, and all existing release safety tests pass.

**Implementation result:**
- The renderer emits authored changes plus exact-version npm/plugin installs, workflow-backed Validation claims, and a comparison URL derived from the next older entry.
- Added `verify X.Y.Z BODY_FILE` for newline-normalized required-block recovery checks; it accepts unrelated operator text and rejects missing or altered authored/generated blocks.
- The validation job renders notes before build and publication. The final job checks out the tagged source, renders notes without GitHub `generate-notes`, verifies existing releases, and creates new releases against `GITHUB_SHA`.
- Validation: release automation passed all 54 tests; direct render/verify preview for `0.6.0` succeeded with an appended operator note.

### Task 4: Maintainer workflow documentation and final validation

**Covers:** R10 and final integration of R1–R9

**Objective:** Make the enforced sequence discoverable and prove the complete repository/package workflow remains releasable.

**Files:**
- Modify: `docs/releasing.md`
- Modify: `AGENTS.md`
- Modify: `docs/plans/2026-08-28-changelog-release-notes.md`
- Move after all checks pass: `docs/plans/2026-08-28-changelog-release-notes.md` → `docs/plans/archived/2026-08-28-changelog-release-notes.md`

**Dependencies:** Tasks 1–3.

**Implementation notes:**
- Document the mandatory order: add and review the `vNEXT` changelog section, run explicit target validation/preview, run `release:prepare`, review synchronized versions, then run existing release gates.
- Document category and `**Breaking:**` conventions plus failure behavior. Do not duplicate implementation details better expressed by command output.
- Update recovery guidance: an existing GitHub Release body mismatch is a stop condition; package recovery rules remain unchanged.
- Keep Status, Progress, Next steps, and task notes aligned with actual implementation before archiving it.
- After implementation and final validation are committed, archive this plan in a separate docs-only commit as required by repository policy.

**Test cases:**
- Command examples use stable versions without a `v` prefix for scripts and `vX.Y.Z` for changelog/tag headings.
- Documentation states that missing/invalid notes fail before version writes and before publication.
- Active docs contain no instruction that GitHub `generate-notes` supplies Shepherd's change summary.

**Complete when:**
- A maintainer can follow `docs/releasing.md` without relying on chat history.
- Full validation passes with a clean generated-artifact boundary.
- The plan is archived only after every Final Validation item succeeds, and that archive is committed separately as docs-only.

**Validation:**
- Run: `rg -n "CHANGELOG|release:notes|release:prepare|generate-notes" docs/releasing.md AGENTS.md .github/workflows/release.yml package.json`
- Expected: required changelog/preview flow is documented and no workflow dependency on GitHub-generated notes remains.

**Implementation result:**
- `docs/releasing.md` now requires changelog authoring, explicit target validation and preview before version updates, review of `CHANGELOG.md` in the release commit, and required-block recovery checks.
- `AGENTS.md` identifies `CHANGELOG.md` as the release-note source and documents the changelog check, preview, and guarded preparation commands.
- Focused documentation validation found no stale `generate-notes` instruction. Explicit `0.6.0` target check and preview commands succeeded.
- Full validation and independent review passed on final HEAD `7bd5229`; the plan records the correction history and remaining non-blocking findings before archive.

## Requirement Coverage

| Requirement / Decision | Task | Verification |
|---|---|---|
| R1 | Task 1 | Repository changelog history/version assertions |
| R2, R3 | Task 1 | Valid and invalid fixture matrix for headings, categories, and bullets |
| R4 | Task 1 | Breaking-marker preservation case |
| R5 | Task 2 | Atomic failure snapshots around `release:prepare` |
| R6 | Task 1 | Default check against root package version |
| R7 | Tasks 2–3 | Tag pre-git rejection and workflow ordering assertions |
| R8 | Task 3 | Renderer semantic assertions and preview command |
| R9 | Task 3 | Existing-release matching/mismatch recovery cases |
| R10 | Task 4 | Documentation command/reference sweep |
| D1 | Tasks 1, 4 | Version-specific changelog format and documented release-time authoring |
| D2, D4 | Tasks 1, 3 | Repository renderer tests; absence of `generate-notes` |
| D3 | Tasks 1–3 | Missing section fails check, preparation, and tag validation |
| D5 | Tasks 1–3 | Shared CLI exercised across all release gates |
| D6 | Task 3 | Previous-version comparison derivation test |
| D7 | Task 3 | Validate-job render and tagged-checkout final render assertions |
| D8 | Task 1 | `v0.1.0` tag-source review plus six later Release-body comparisons |

## Final Validation

- [x] `pnpm exec vitest run test/unit/release-automation.test.ts test/unit/package-publication.test.ts` — 78 focused tests passed on final HEAD.
- [x] `pnpm changelog:check` — latest changelog and root package version both resolved to `0.6.0`.
- [x] `pnpm release:notes 0.6.0` — output contained authored changes, exact install commands, Validation, and `v0.5.0...v0.6.0`.
- [x] `env -u HERDR_ENV -u HERDR_PANE_ID -u HERDR_SOCKET_PATH -u HERDR_TAB_ID -u HERDR_WORKSPACE_ID pnpm check` — 31 files and 326 tests passed with TypeScript, Biome, Drizzle, and package gates.
- [x] `pnpm build` — clean TypeScript build and alias resolution passed.
- [x] `pnpm package:smoke` — both `0.6.0` tarballs passed integrity checks and isolated installation; installed CLI reported `0.6.0`.
- [x] `git diff --check` — no whitespace errors.
- [x] `git show v0.1.0:README.md`, the `v0.1.0` history, and six later `gh release view` records were checked; `CHANGELOG.md` did not change after that source comparison.
- [x] Requirement Coverage has no unsupported or unverified row.
- [x] Plan and implementation diff agree; Progress reflects completed validations.
- [x] All implementation commits are complete; archive this file unchanged in name as the final docs-only commit.

## Independent Review Gate

- Final review range: `947f77bc1765b1d4a58003f137d623bafad76409..7bd5229dfe9642e79b944240ee35e76789e209fb`.
- Validation supplied to reviewer: focused tests 55 passed; full suite 303 passed; `pnpm check`, build, package smoke, render/verify, history-source checks, and `git diff --check` passed on the reviewed HEAD.
- Adopted high finding: top-level bullet validation currently counts `- ` lines hidden inside fenced code or HTML comments; R2/R3 require visible top-level bullets.
- Adopted high finding: existing-release verification currently accepts all required blocks hidden inside an HTML comment; R9 requires visible top-level authored/generated sections.
- Adopted high finding: workflow executes `pnpm rebuild` before tag/package/changelog/main-ancestry validation; R7 requires the gate before package build or lifecycle execution.
- Resolved decision: the user confirmed that only the optional italic ISO date may appear before the first category; other prose remains invalid.
- Medium/low left for completion report: renderer metadata is hard-coded rather than derived from package metadata; ISO date shape is checked without calendar validation; documentation overstates all-I/O-failure atomicity instead of limiting the guarantee to validation failures.
- Correction cycle 1 implementation: added comment/fence-aware top-level Markdown scanning, visible ordered required-section verification, and pre-install tag validation; documented the date-only preamble contract.
- Correction cycle 1 affected validation: release automation passed all 58 tests, including the four reviewer reproductions.
- Correction cycle 1 completed with commit `547b09c`; full re-review confirmed the original fence/comment and workflow-order reproductions were fixed.
- Re-review adopted high finding: raw HTML blocks such as `<pre>` and `<details>` can still hide pseudo bullets from Markdown rendering while passing changelog validation.
- Re-review adopted high finding: complete required blocks inside raw or collapsible HTML can still pass recovery verification.
- Re-review adopted high finding: a same-line suffix on the final authored, Validation, or comparison-link line passes the prefix-based required-block check.
- Correction cycle 2 implementation: mask raw and collapsible HTML blocks with same-tag nesting depth, and require exact block content or a newline before operator-authored additions.
- Correction cycle 2 affected validation: release/publication tests passed all 68 cases, including raw HTML, nested HTML, and same-line suffix reproductions; changelog check passed.
- Correction cycle 2 completed with commit `3156048`; focused tests passed 68 cases and the commit hook passed all 316 tests.
- Scoped re-review confirmed same-line authored, Validation, and comparison-link suffixes are rejected.
- Continuation correction `ce30907` resolved the active raw-HTML comment and quoted-attribute depth findings for both changelog validation and Release recovery.
- Correction cycles completed in the first implementation invocation: 2 of 2. No third automatic correction was attempted.
- The user authorized a new implementation invocation to resolve the two remaining findings.
- Continuation correction: raw HTML depth now consumes a lexical view that masks comments and quoted attributes before counting tags; parser and recovery regression tests cover both compositions.
- Continuation affected validation: release/publication tests passed all 72 cases and changelog check passed.
- Continuation correction cycle 1 completed with commit `ce30907`; scoped re-review confirmed the original comment and quoted-attribute depth findings are resolved.
- Continuation scoped re-review adopted high regression: generalized quote state treats quotes inside CDATA/processing instructions as attribute quotes, preventing a closed raw construct from terminating and hiding later visible Markdown.
- Continuation correction cycle 2 implementation: enter attribute quote state only for ordinary HTML tags and let active CDATA, processing instructions, and declarations close only through their dedicated terminators.
- Continuation correction cycle 2 affected validation: release/publication tests passed all 78 cases, including closed raw constructs containing quote characters; changelog check passed.
- Continuation correction cycle 2 completed with commit `7bd5229`; scoped re-review reported no blocking/high, decision required, or correction-caused medium/low findings.
- Final independent-review verdict: PASS and mergeable. All adopted high findings are resolved; no unresolved blocking or decision-required finding remains.
- Final validation on reviewed HEAD: focused 78, full 326, changelog check, render/verify, build, package smoke, and diff checks passed.
- Correction cycles used in the continuation invocation: 2 of 2.

## Risks and Open Questions

- **Resolved:** `gh release view v0.1.0 --repo ryonakae/shepherd` returns `release not found`. The user approved the annotated `v0.1.0` tag snapshot and commit history as the one-time source exception; six GitHub Releases cover `v0.2.0` through `v0.6.0`, including `v0.3.1`.
- Existing release bodies use different headings (`Highlights`, package contents, validation). Historical migration must preserve facts while mapping only user-facing changes into the agreed category set.
- Existing-release required-block comparison can be sensitive to trailing newline normalization; tests must define one normalization rule, permit unrelated appended text, and still reject missing or altered required blocks.
- Rendering notes twice in separate jobs is safe only because the remote tag is immutable by project policy and both jobs check out the tagged SHA.
- Open questions: none.
