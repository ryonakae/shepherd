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

function fenceMarker(line) {
  const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
  return match ? { character: match[1][0], length: match[1].length } : undefined;
}

function closesFence(line, fence) {
  const content = /^ {0,3}(\S.*)$/.exec(line)?.[1]?.trimEnd();
  return (
    content?.length >= fence.length &&
    [...content].every((character) => character === fence.character)
  );
}

const voidHtmlTags = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

function htmlTagDepth(line, tag) {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const openings = [...line.matchAll(new RegExp(`<${escaped}(?=[\\s/>])`, "gi"))].length;
  const closings = [...line.matchAll(new RegExp(`</${escaped}(?=[\\s>])`, "gi"))].length;
  const selfClosing = [
    ...line.matchAll(new RegExp(`<${escaped}(?=[\\s/>])[^>]*?/\\s*>`, "gi")),
  ].length;
  return openings - closings - selfClosing;
}

function rawHtmlOpening(line) {
  const content = /^ {0,3}(\S.*)$/.exec(line)?.[1];
  if (!content) return undefined;
  if (content.startsWith("<![CDATA[")) {
    return { closed: content.slice(9).includes("]]>"), terminator: "]]>" };
  }
  if (content.startsWith("<?")) {
    return { closed: content.slice(2).includes("?>"), terminator: "?>" };
  }
  if (/^<![A-Z]/.test(content)) {
    return { closed: content.includes(">"), terminator: ">" };
  }

  const match = /^<([A-Za-z][A-Za-z0-9-]*)(?=[\s/>]|$)/.exec(content);
  if (!match) return undefined;
  const tag = match[1].toLowerCase();
  const depth = voidHtmlTags.has(tag) ? 0 : htmlTagDepth(content, tag);
  return { closed: depth <= 0, depth, tag };
}

function advancesPastRawHtml(line, block) {
  if (block.tag) {
    block.depth += htmlTagDepth(line, block.tag);
    return block.depth <= 0;
  }
  return line.toLowerCase().includes(block.terminator.toLowerCase());
}

function maskNonStructuralHtml(line, state) {
  const masked = [...line];
  let cursor = 0;
  while (cursor < line.length) {
    if (state.inComment) {
      if (line.startsWith("-->", cursor)) {
        masked.fill(" ", cursor, cursor + 3);
        state.inComment = false;
        cursor += 3;
      } else {
        masked[cursor] = " ";
        cursor += 1;
      }
      continue;
    }

    if (state.quote) {
      const character = line[cursor];
      masked[cursor] = " ";
      if (character === state.quote) state.quote = undefined;
      cursor += 1;
      continue;
    }

    if (line.startsWith("<!--", cursor)) {
      masked.fill(" ", cursor, cursor + 4);
      state.inComment = true;
      cursor += 4;
      continue;
    }

    const character = line[cursor];
    if (state.inTag && (character === '"' || character === "'")) {
      masked[cursor] = " ";
      state.quote = character;
    } else if (state.inTag && character === ">") {
      state.inTag = false;
    } else if (!state.inTag && character === "<") {
      state.inTag = true;
    }
    cursor += 1;
  }
  return masked.join("");
}

function maskHiddenMarkdown(source) {
  let fence;
  let htmlBlock;
  const htmlState = { inComment: false, inTag: false, quote: undefined };
  return source
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => {
      if (fence) {
        if (closesFence(line, fence)) fence = undefined;
        return line;
      }

      const result = maskNonStructuralHtml(line, htmlState);
      if (htmlBlock) {
        if (advancesPastRawHtml(result, htmlBlock)) htmlBlock = undefined;
        return " ".repeat(line.length);
      }

      htmlBlock = rawHtmlOpening(result);
      if (htmlBlock) {
        if (htmlBlock.closed) htmlBlock = undefined;
        return " ".repeat(line.length);
      }
      fence = fenceMarker(result);
      return result;
    })
    .join("\n");
}

function visibleTopLevelLines(source) {
  const masked = maskHiddenMarkdown(source);
  const lines = [];
  let fence;
  let offset = 0;
  for (const line of masked.split("\n")) {
    if (fence) {
      if (closesFence(line, fence)) fence = undefined;
    } else {
      const opening = fenceMarker(line);
      if (opening) {
        fence = opening;
      } else {
        lines.push({ end: offset + line.length, start: offset, text: line.trimEnd() });
      }
    }
    offset += line.length + 1;
  }
  return lines;
}

function validateReleaseBody(version, body) {
  const visibleLines = visibleTopLevelLines(body);
  const categories = visibleLines.filter((line) => /^### .+$/.test(line.text));
  if (categories.length === 0) {
    throw new Error(`CHANGELOG.md: version ${version} requires at least one category`);
  }

  const preamble = body.slice(0, categories[0].start).trim();
  if (preamble && !/^_\d{4}-\d{2}-\d{2}_$/.test(preamble)) {
    throw new Error(`CHANGELOG.md: version ${version} has invalid text before its categories`);
  }

  const seen = new Set();
  for (const [index, categoryLine] of categories.entries()) {
    const category = categoryLine.text.slice(4).trim();
    if (!allowedCategories.has(category)) {
      throw new Error(`CHANGELOG.md: version ${version} has unknown category ${category}`);
    }
    if (seen.has(category)) {
      throw new Error(`CHANGELOG.md: version ${version} has duplicate category ${category}`);
    }
    seen.add(category);

    const contentEnd = categories[index + 1]?.start ?? body.length;
    const hasBullet = visibleLines.some(
      (line) => line.start >= categoryLine.end && line.start < contentEnd && /^- \S/.test(line.text),
    );
    if (!hasBullet) {
      throw new Error(
        `CHANGELOG.md: version ${version} category ${category} requires at least one bullet`,
      );
    }
  }
}

export function parseChangelog(input) {
  const source = input.replace(/\r\n?/g, "\n");
  const headings = visibleTopLevelLines(source).filter((line) => /^## .+$/.test(line.text));
  if (headings.length === 0) {
    throw new Error("CHANGELOG.md: requires at least one version section");
  }

  const releases = [];
  const seen = new Set();
  for (const [index, heading] of headings.entries()) {
    const title = heading.text.slice(3).trim();
    const match = /^v(.+)$/.exec(title);
    if (!match || !stableVersion.test(match[1])) {
      throw new Error(`CHANGELOG.md: invalid release heading ${title}`);
    }
    const version = match[1];
    if (seen.has(version)) {
      throw new Error(`CHANGELOG.md: duplicate changelog version ${version}`);
    }
    seen.add(version);

    const bodyStart = heading.end;
    const bodyEnd = headings[index + 1]?.start ?? source.length;
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

function normalizeMarkdown(source) {
  return source
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

function releaseStructure(markdown) {
  const normalized = normalizeMarkdown(markdown);
  const visibleLines = visibleTopLevelLines(normalized);
  const title = visibleLines.find((line) => /^# Shepherd v\S+$/.test(line.text));
  const headings = visibleLines.filter((line) => /^## .+$/.test(line.text));
  return { headings, normalized, title, visibleLines };
}

function requiredReleaseBlocks(rendered) {
  const { headings, normalized, title } = releaseStructure(rendered);
  return {
    blocks: headings.map((heading, index) => ({
      content: normalizeMarkdown(
        normalized.slice(heading.start, headings[index + 1]?.start ?? normalized.length),
      ),
      heading: heading.text,
    })),
    title: title?.text,
  };
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

export async function verifyReleaseNotesBody(version, body, root = process.cwd()) {
  const expected = requiredReleaseBlocks(await renderReleaseNotes(version, root));
  const actual = releaseStructure(maskHiddenMarkdown(body));
  if (!expected.title || !actual.visibleLines?.some((line) => line.text === expected.title)) {
    throw new Error(`GitHub Release v${version}: missing or altered required release block ${expected.title}`);
  }

  let headingIndex = 0;
  for (const block of expected.blocks) {
    const matchIndex = actual.headings.findIndex(
      (heading, index) => index >= headingIndex && heading.text === block.heading,
    );
    if (matchIndex === -1) {
      throw new Error(`GitHub Release v${version}: missing or altered required release block ${block.heading}`);
    }
    const heading = actual.headings[matchIndex];
    const content = normalizeMarkdown(
      actual.normalized.slice(heading.start, actual.headings[matchIndex + 1]?.start ?? actual.normalized.length),
    );
    if (content !== block.content && !content.startsWith(`${block.content}\n`)) {
      throw new Error(`GitHub Release v${version}: missing or altered required release block ${block.heading}`);
    }
    headingIndex = matchIndex + 1;
  }
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

  if (command === "verify" && version && stableVersion.test(version) && extra.length === 1) {
    const body = await readFile(resolve(process.cwd(), extra[0]), "utf8");
    await verifyReleaseNotesBody(version, body);
    process.stdout.write(`${version}\n`);
    return;
  }

  throw new Error(
    "Usage: node scripts/release-notes.mjs <check [X.Y.Z] | render X.Y.Z | verify X.Y.Z BODY_FILE>",
  );
}

const entrypoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entrypoint === import.meta.url) {
  await main(process.argv.slice(2));
}
