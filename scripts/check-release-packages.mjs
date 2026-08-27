#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyReleasePackages } from "./verify-release-packages.mjs";

const args = process.argv.slice(2);
if (args[0] === "--") args.shift();
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--output")) {
  throw new Error("Usage: pnpm package:smoke [--output <directory>]");
}

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const workRoot = await mkdtemp(join(tmpdir(), "shepherd-package-smoke-"));
const requestedOutput = args[1] ? resolve(process.cwd(), args[1]) : undefined;
const output = requestedOutput ?? join(workRoot, "artifacts");
const manifestName = "release-packages.json";

function run(command, commandArgs, options = {}) {
  return execFileSync(command, commandArgs, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    ...options,
  });
}

function pack(cwd) {
  const result = JSON.parse(
    run(
      npm,
      ["pack", "--ignore-scripts", "--json", "--pack-destination", output],
      { cwd },
    ),
  );
  if (result.length !== 1) throw new Error(`Expected one tarball from ${cwd}`);
  return result[0];
}

try {
  await mkdir(output, { recursive: true });
  const existing = await readdir(output);
  if (existing.length !== 0) {
    throw new Error(`Output directory must be empty: ${output}`);
  }

  const rootPackage = pack(repositoryRoot);
  const piPackage = pack(join(repositoryRoot, "packages/shepherd-pi"));
  const packages = [rootPackage, piPackage].map(
    ({ filename, integrity, name, version }) => ({ filename, integrity, name, version }),
  );
  const expectedNames = ["@ryonakae/shepherd", "@ryonakae/shepherd-pi"];
  if (packages.map(({ name }) => name).join("\n") !== expectedNames.join("\n")) {
    throw new Error(`Unexpected package order: ${packages.map(({ name }) => name).join(", ")}`);
  }
  if (new Set(packages.map(({ version }) => version)).size !== 1) {
    throw new Error("Public package versions are not synchronized");
  }
  for (const entry of packages) {
    if (!entry.filename || !entry.integrity || !existsSync(join(output, entry.filename))) {
      throw new Error(`Incomplete npm pack result for ${entry.name}`);
    }
  }

  await writeFile(
    join(output, manifestName),
    `${JSON.stringify({ packages, version: packages[0].version }, null, 2)}\n`,
  );
  const outputEntries = (await readdir(output)).sort();
  const expectedEntries = [...packages.map(({ filename }) => filename), manifestName].sort();
  if (outputEntries.join("\n") !== expectedEntries.join("\n")) {
    throw new Error(`Unexpected release artifacts: ${outputEntries.join(", ")}`);
  }
  await verifyReleasePackages(output);

  const installRoot = join(workRoot, "install");
  const rootPrefix = join(installRoot, "root-prefix");
  run(
    npm,
    [
      "install",
      "--global",
      "--prefix",
      rootPrefix,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      join(output, rootPackage.filename),
    ],
    { cwd: workRoot, stdio: "inherit" },
  );
  run(join(rootPrefix, "bin/shepherd"), ["help"], { cwd: workRoot, stdio: "inherit" });

  const piPrefix = join(installRoot, "pi-prefix");
  run(
    npm,
    [
      "install",
      "--prefix",
      piPrefix,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      join(output, piPackage.filename),
    ],
    { cwd: workRoot, stdio: "inherit" },
  );
  const piRoot = join(piPrefix, "node_modules/@ryonakae/shepherd-pi");
  if (!existsSync(join(piRoot, "src/index.ts"))) {
    throw new Error("Installed Pi package is missing src/index.ts");
  }
  if (existsSync(join(piRoot, "tsconfig.json"))) {
    throw new Error("Installed Pi package unexpectedly includes tsconfig.json");
  }

  console.log(
    `${packages.map(({ name, version }) => `${name}@${version}`).join(" and ")} passed package smoke`,
  );
  if (requestedOutput) console.log(`Release artifacts: ${output}`);
} finally {
  await rm(workRoot, { recursive: true, force: true });
}
