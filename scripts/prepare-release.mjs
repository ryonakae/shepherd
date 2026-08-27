#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const manifestPaths = [
  "package.json",
  "packages/shepherd-pi/package.json",
  "packages/shepherd-herdr-plugin/package.json",
];
const pluginManifestPath = "packages/shepherd-herdr-plugin/herdr-plugin.toml";
const pluginReadmePaths = [
  "README.md",
  "README.ja.md",
  "packages/shepherd-herdr-plugin/README.md",
];

const args = process.argv.slice(2);
const [version] = args;
const stableVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
if (args.length !== 1 || !version || !stableVersion.test(version)) {
  throw new Error("Usage: pnpm release:prepare <X.Y.Z>");
}

const root = process.cwd();
const sourceEntries = await Promise.all(
  [...manifestPaths, pluginManifestPath, ...pluginReadmePaths].map(async (path) => [
    path,
    await readFile(resolve(root, path), "utf8"),
  ]),
);
const sources = new Map(sourceEntries);
const manifests = new Map(
  manifestPaths.map((path) => {
    try {
      return [path, JSON.parse(sources.get(path))];
    } catch (error) {
      throw new Error(`${path}: invalid JSON`, { cause: error });
    }
  }),
);
const currentVersion = manifests.get("package.json").version;

for (const [path, manifest] of manifests) {
  if (manifest.version !== currentVersion) {
    throw new Error(`${path}: expected version ${currentVersion}, received ${manifest.version}`);
  }
}

const pluginVersionMatches = [
  ...sources.get(pluginManifestPath).matchAll(/^version = "([^"]+)"$/gm),
];
if (
  pluginVersionMatches.length !== 1 ||
  pluginVersionMatches[0][1] !== currentVersion
) {
  throw new Error(`${pluginManifestPath}: expected one version ${currentVersion}`);
}
for (const path of pluginReadmePaths) {
  const matches = [...sources.get(path).matchAll(/--ref v([^ ]+) --yes/g)];
  if (matches.length !== 1 || matches[0][1] !== currentVersion) {
    throw new Error(`${path}: expected one plugin ref v${currentVersion}`);
  }
}

const updates = [];
for (const [path, manifest] of manifests) {
  manifest.version = version;
  updates.push([path, `${JSON.stringify(manifest, null, 2)}\n`]);
}
updates.push([
  pluginManifestPath,
  sources
    .get(pluginManifestPath)
    .replace(`version = "${currentVersion}"`, `version = "${version}"`),
]);
for (const path of pluginReadmePaths) {
  updates.push([
    path,
    sources.get(path).replace(`--ref v${currentVersion} --yes`, `--ref v${version} --yes`),
  ]);
}

await Promise.all(
  updates.map(([path, content]) => writeFile(resolve(root, path), content)),
);
