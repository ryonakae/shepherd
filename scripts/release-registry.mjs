#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyReleasePackages } from "./verify-release-packages.mjs";

const npm =
  process.env.SHEPHERD_NPM_COMMAND ?? (process.platform === "win32" ? "npm.cmd" : "npm");
const retryAttempts = readPositiveInteger("SHEPHERD_REGISTRY_RETRY_ATTEMPTS", 12);
const retryDelayMs = readPositiveInteger("SHEPHERD_REGISTRY_RETRY_DELAY_MS", 5_000);

function readPositiveInteger(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function classifyRegistryState(actualIntegrity, expectedIntegrity) {
  if (actualIntegrity === undefined) return "absent";
  return actualIntegrity === expectedIntegrity ? "expected" : "conflict";
}

export function assertReleaseState(states) {
  const key = states.join("/");
  if (!["absent/absent", "expected/absent", "expected/expected"].includes(key)) {
    throw new Error(`Unsafe registry state: ${key}`);
  }
}

function npmResult(args, options = {}) {
  return spawnSync(npm, args, {
    encoding: "utf8",
    ...options,
  });
}

function packageSpecifier(entry) {
  return `${entry.name}@${entry.version}`;
}

function registryState(entry) {
  const result = npmResult(["view", packageSpecifier(entry), "dist.integrity", "--json"]);
  if (result.status === 0) {
    let integrity;
    try {
      integrity = JSON.parse(result.stdout);
    } catch (error) {
      throw new Error(`Invalid npm view response for ${packageSpecifier(entry)}`, { cause: error });
    }
    if (typeof integrity !== "string") {
      throw new Error(`Missing registry integrity for ${packageSpecifier(entry)}`);
    }
    return classifyRegistryState(integrity, entry.integrity);
  }
  if (/\bE404\b/.test(result.stderr)) return "absent";
  throw new Error(`npm view failed for ${packageSpecifier(entry)}: ${result.stderr.trim()}`);
}

async function waitForExpected(entry) {
  for (let attempt = 1; attempt <= retryAttempts; attempt += 1) {
    const state = registryState(entry);
    if (state === "expected") return;
    if (state === "conflict") {
      throw new Error(`Registry integrity conflicts for ${packageSpecifier(entry)}`);
    }
    if (attempt < retryAttempts) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, retryDelayMs));
    }
  }
  throw new Error(`Registry did not expose ${packageSpecifier(entry)} after publication`);
}

async function inspectRelease(directory) {
  const release = await verifyReleasePackages(directory);
  const states = release.packages.map((entry) => registryState(entry));
  assertReleaseState(states);
  return { release, states };
}

async function publishRelease(directory) {
  const { release } = await inspectRelease(directory);
  for (const entry of release.packages) {
    const state = registryState(entry);
    if (state === "expected") {
      console.log(`${packageSpecifier(entry)} already matches the verified tarball`);
      continue;
    }
    if (state === "conflict") {
      throw new Error(`Registry integrity conflicts for ${packageSpecifier(entry)}`);
    }

    const result = npmResult(
      ["publish", entry.path, "--access", "public", "--provenance"],
      { stdio: "inherit" },
    );
    if (result.status !== 0) {
      await waitForExpected(entry);
      console.log(`${packageSpecifier(entry)} appeared after an ambiguous publish result`);
      continue;
    }
    await waitForExpected(entry);
    console.log(`${packageSpecifier(entry)} published and verified`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, directory, ...extra] = process.argv.slice(2);
  if (!directory || extra.length !== 0 || !["check", "publish"].includes(command)) {
    throw new Error(
      "Usage: node scripts/release-registry.mjs <check|publish> <artifact-directory>",
    );
  }
  if (command === "check") {
    const { release, states } = await inspectRelease(directory);
    process.stdout.write(
      `${JSON.stringify({ states, version: release.version })}\n`,
    );
  } else {
    await publishRelease(directory);
  }
}
