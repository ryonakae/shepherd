#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
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
const topLevel = new Set(["LICENSE", "README.md", "README.ja.md", "package.json"]);
const unexpected = files.filter(
  (path) =>
    !topLevel.has(path) && !path.startsWith("dist/") && !path.startsWith("drizzle/"),
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
