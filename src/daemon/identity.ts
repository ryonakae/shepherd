import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function readOrCreateDaemonId(stateDir: string): string {
  mkdirSync(stateDir, { recursive: true });
  const path = join(stateDir, "daemon-id");
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8").trim();
    if (existing.length > 0) {
      return existing;
    }
  }

  const daemonId = randomUUID();
  writeFileSync(path, `${daemonId}\n`, { mode: 0o600 });
  return daemonId;
}
