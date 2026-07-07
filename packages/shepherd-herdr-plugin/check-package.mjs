#!/usr/bin/env node
// @ts-check
import { execFileSync } from "node:child_process";

const [pack] = /** @type {Array<{ files: Array<{ path: string }> }>} */ (
  JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json"], { encoding: "utf8" }))
);
const files = pack?.files.map((file) => file.path) ?? [];

for (const required of ["index.mjs", "herdr-plugin.toml"]) {
  if (!files.includes(required)) {
    throw new Error(`Herdr plugin package is missing ${required}`);
  }
}

if (files.some((file) => file.startsWith("dist/"))) {
  throw new Error("Herdr plugin package must not include dist output");
}
