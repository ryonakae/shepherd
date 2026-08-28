#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const allowedCategories = new Set([
  "Added",
  "Changed",
  "Deprecated",
  "Removed",
  "Fixed",
  "Security",
]);
const stableVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

function compareVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < leftParts.length; index += 1) {
    const difference = leftParts[index] - rightParts[index];
    if (difference !== 0) return difference;
  }
  return 0;
}

function validateReleaseBody(version, body) {
  const categories = [...body.matchAll(/^### (.+)$/gm)];
  if (categories.length === 0) {
    throw new Error(`CHANGELOG.md: version ${version} requires at least one category`);
  }

  const preamble = body.slice(0, categories[0].index).trim();
  if (preamble && !/^_\d{4}-\d{2}-\d{2}_$/.test(preamble)) {
    throw new Error(`CHANGELOG.md: version ${version} has invalid text before its categories`);
  }

  const seen = new Set();
  for (const [index, categoryMatch] of categories.entries()) {
    const category = categoryMatch[1].trim();
    if (!allowedCategories.has(category)) {
      throw new Error(`CHANGELOG.md: version ${version} has unknown category ${category}`);
    }
    if (seen.has(category)) {
      throw new Error(`CHANGELOG.md: version ${version} has duplicate category ${category}`);
    }
    seen.add(category);

    const contentStart = categoryMatch.index + categoryMatch[0].length;
    const contentEnd = categories[index + 1]?.index ?? body.length;
    const categoryBody = body.slice(contentStart, contentEnd);
    if (!/^- \S.*$/m.test(categoryBody)) {
      throw new Error(
        `CHANGELOG.md: version ${version} category ${category} requires at least one bullet`,
      );
    }
  }
}

export function parseChangelog(source) {
  const headings = [...source.matchAll(/^## (.+)$/gm)];
  if (headings.length === 0) {
    throw new Error("CHANGELOG.md: requires at least one version section");
  }

  const releases = [];
  const seen = new Set();
  for (const [index, heading] of headings.entries()) {
    const title = heading[1].trim();
    const match = /^v(.+)$/.exec(title);
    if (!match || !stableVersion.test(match[1])) {
      throw new Error(`CHANGELOG.md: invalid release heading ${title}`);
    }
    const version = match[1];
    if (seen.has(version)) {
      throw new Error(`CHANGELOG.md: duplicate changelog version ${version}`);
    }
    seen.add(version);

    const bodyStart = heading.index + heading[0].length;
    const bodyEnd = headings[index + 1]?.index ?? source.length;
    const body = source.slice(bodyStart, bodyEnd).trim();
    validateReleaseBody(version, body);
    releases.push({ body, version });
  }

  for (let index = 1; index < releases.length; index += 1) {
    if (compareVersions(releases[index - 1].version, releases[index].version) <= 0) {
      throw new Error("CHANGELOG.md: release versions must be strictly descending");
    }
  }

  return releases;
}

export async function readChangelog(root = process.cwd()) {
  const source = await readFile(resolve(root, "CHANGELOG.md"), "utf8");
  return parseChangelog(source);
}

export async function validateLatestChangelogVersion(version, root = process.cwd()) {
  const releases = await readChangelog(root);
  const target = releases.find((release) => release.version === version);
  if (!target) {
    throw new Error(`CHANGELOG.md: target version ${version} was not found`);
  }
  if (releases[0].version !== version) {
    throw new Error(
      `CHANGELOG.md: target version ${version} does not match latest changelog version ${releases[0].version}`,
    );
  }
  return releases;
}

export async function renderReleaseNotes(version, root = process.cwd()) {
  const releases = await readChangelog(root);
  const index = releases.findIndex((release) => release.version === version);
  if (index === -1) {
    throw new Error(`CHANGELOG.md: target version ${version} was not found`);
  }
  const previous = releases[index + 1];
  if (!previous) {
    throw new Error(
      `CHANGELOG.md: version ${version} cannot be rendered without a next-older changelog entry`,
    );
  }

  return `# Shepherd v${version}

## Release Notes

${releases[index].body}

## Install

\`\`\`bash
npm install --global @ryonakae/shepherd@${version}
pi install npm:@ryonakae/shepherd-pi@${version}
\`\`\`

The optional Herdr plugin remains distributed from GitHub:

\`\`\`bash
herdr plugin install ryonakae/shepherd/packages/shepherd-herdr-plugin --ref v${version} --yes
\`\`\`

## Validation

- Repository checks, the production build, and isolated package smoke tests passed.
- Release tarball integrity was verified before and after npm publication.
- Both exact npm package versions passed fresh registry installation.

## Full changelog

https://github.com/ryonakae/shepherd/compare/v${previous.version}...v${version}
`;
}

async function main(args) {
  const [command, version, ...extra] = args;
  if (command === "check" && extra.length === 0) {
    let expectedVersion = version;
    if (!expectedVersion) {
      const manifest = JSON.parse(await readFile(resolve(process.cwd(), "package.json"), "utf8"));
      expectedVersion = manifest.version;
      if (!stableVersion.test(expectedVersion)) {
        throw new Error(`package.json: invalid stable version ${expectedVersion}`);
      }
      const releases = await readChangelog();
      if (releases[0].version !== expectedVersion) {
        throw new Error(
          `CHANGELOG.md: latest changelog version ${releases[0].version} does not match package version ${expectedVersion}`,
        );
      }
      process.stdout.write(`${expectedVersion}\n`);
      return;
    }
    if (!stableVersion.test(expectedVersion)) {
      throw new Error("Usage: node scripts/release-notes.mjs check [X.Y.Z]");
    }
    await validateLatestChangelogVersion(expectedVersion);
    process.stdout.write(`${expectedVersion}\n`);
    return;
  }

  if (command === "render" && version && stableVersion.test(version) && extra.length === 0) {
    process.stdout.write(await renderReleaseNotes(version));
    return;
  }

  throw new Error(
    "Usage: node scripts/release-notes.mjs <check [X.Y.Z] | render X.Y.Z>",
  );
}

const entrypoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entrypoint === import.meta.url) {
  await main(process.argv.slice(2));
}
