#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const [tag, commit, ...extra] = process.argv.slice(2);
const match = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(tag ?? "");
if (!match || !commit || extra.length !== 0) {
  throw new Error("Usage: node scripts/validate-release-tag.mjs <vX.Y.Z> <commit>");
}

const version = match[1];
const manifest = JSON.parse(await readFile("package.json", "utf8"));
if (manifest.version !== version) {
  throw new Error(`Tag ${tag} does not match package version ${manifest.version}`);
}

const git = process.env.SHEPHERD_GIT_COMMAND ?? "git";
execFileSync(git, ["fetch", "origin", "main:refs/remotes/origin/main", "--no-tags"], {
  stdio: "inherit",
});
execFileSync(git, ["merge-base", "--is-ancestor", commit, "origin/main"], {
  stdio: "inherit",
});
process.stdout.write(`${version}\n`);
