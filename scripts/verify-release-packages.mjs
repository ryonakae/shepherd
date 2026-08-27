#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const stableVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const manifestName = "release-packages.json";

export async function verifyReleasePackages(directory) {
  const artifactDirectory = resolve(process.cwd(), directory);
  const manifest = JSON.parse(await readFile(resolve(artifactDirectory, manifestName), "utf8"));
  if (!stableVersion.test(manifest.version) || !Array.isArray(manifest.packages)) {
    throw new Error("Invalid release artifact manifest");
  }

  const expectedPackages = [
    {
      filename: `ryonakae-shepherd-${manifest.version}.tgz`,
      name: "@ryonakae/shepherd",
    },
    {
      filename: `ryonakae-shepherd-pi-${manifest.version}.tgz`,
      name: "@ryonakae/shepherd-pi",
    },
  ];
  if (manifest.packages.length !== expectedPackages.length) {
    throw new Error("Release artifact manifest must contain exactly two packages");
  }

  const packages = [];
  for (const [index, expected] of expectedPackages.entries()) {
    const entry = manifest.packages[index];
    if (
      entry?.name !== expected.name ||
      entry?.filename !== expected.filename ||
      entry?.version !== manifest.version ||
      typeof entry?.integrity !== "string"
    ) {
      throw new Error(`Invalid release artifact entry for ${expected.name}`);
    }
    const path = resolve(artifactDirectory, expected.filename);
    const tarball = await readFile(path);
    const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
    if (entry.integrity !== integrity) {
      throw new Error(`Integrity mismatch for ${expected.filename}`);
    }
    packages.push({ ...entry, path });
  }

  const entries = (await readdir(artifactDirectory)).sort();
  const expectedEntries = [manifestName, ...expectedPackages.map(({ filename }) => filename)].sort();
  if (entries.join("\n") !== expectedEntries.join("\n")) {
    throw new Error(`Unexpected release artifacts: ${entries.join(", ")}`);
  }

  return { packages, version: manifest.version };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, ...extra] = process.argv.slice(2);
  if (!directory || extra.length !== 0) {
    throw new Error("Usage: node scripts/verify-release-packages.mjs <artifact-directory>");
  }
  process.stdout.write(`${JSON.stringify(await verifyReleasePackages(directory))}\n`);
}
