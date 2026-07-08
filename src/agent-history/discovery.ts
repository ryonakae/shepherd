import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AgentHistoryRef, AgentSessionRef } from "@/observability/contracts.js";

export type AgentHistoryLookupInput = {
  agent: string | null;
  agentSession: AgentSessionRef | null;
  cwd: string | null;
  foregroundCwd: string | null;
  homeDir?: string;
};

type Candidate = {
  cwd: string | null;
  mtimeMs: number;
  path: string;
  source: AgentHistoryRef["source"];
};

export async function discoverAgentHistory(
  input: AgentHistoryLookupInput,
): Promise<AgentHistoryRef | null> {
  if (input.agentSession?.kind === "path" && existsSync(input.agentSession.value)) {
    const source = historySourceFromSessionRef(input.agentSession);
    return {
      kind: "agent_session",
      path: input.agentSession.value,
      source,
      value: input.agentSession.value,
    };
  }

  const agent = input.agent?.toLowerCase() ?? input.agentSession?.agent.toLowerCase() ?? "";
  const cwd = input.cwd ?? input.foregroundCwd;
  const homeDir = input.homeDir ?? process.env.HOME ?? "";
  const candidates: Candidate[] = [];
  if (agent === "pi") {
    candidates.push(...(await scanRoot(join(homeDir, ".pi", "agent", "sessions"), "pi-jsonl")));
  }
  if (agent === "claude") {
    candidates.push(...(await scanRoot(join(homeDir, ".claude", "projects"), "claude-jsonl")));
  }
  const ranked = candidates.sort((a, b) => {
    const aMatch = cwd && a.cwd === cwd ? 1 : 0;
    const bMatch = cwd && b.cwd === cwd ? 1 : 0;
    if (aMatch !== bMatch) return bMatch - aMatch;
    if (a.mtimeMs !== b.mtimeMs) return b.mtimeMs - a.mtimeMs;
    return a.path.localeCompare(b.path);
  });
  const best = ranked[0];
  return best
    ? { kind: "discovered_file", path: best.path, source: best.source, value: best.path }
    : null;
}

export function historySourceFromSessionRef(ref: AgentSessionRef): AgentHistoryRef["source"] {
  if (ref.agent === "pi" || ref.source.includes("pi")) return "pi-jsonl";
  if (ref.agent === "claude" || ref.source.includes("claude")) return "claude-jsonl";
  return "unknown";
}

async function scanRoot(root: string, source: AgentHistoryRef["source"]): Promise<Candidate[]> {
  if (!existsSync(root)) return [];
  const files = await listJsonlFiles(root);
  const candidates: Candidate[] = [];
  for (const path of files) {
    const stats = await stat(path).catch(() => null);
    if (!stats?.isFile()) continue;
    candidates.push({ cwd: await readCandidateCwd(path), mtimeMs: stats.mtimeMs, path, source });
  }
  return candidates;
}

async function listJsonlFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await listJsonlFiles(path)));
    if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
  }
  return files;
}

async function readCandidateCwd(path: string): Promise<string | null> {
  const content = await readFile(path, "utf8").catch(() => "");
  let inspected = 0;
  for (const line of content.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    inspected += 1;
    try {
      const parsed = JSON.parse(line) as unknown;
      const record =
        typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
      const cwd = stringValue(record.cwd) ?? stringValue(record.foreground_cwd);
      if (cwd) return cwd;
      const message =
        typeof record.message === "object" && record.message !== null
          ? (record.message as Record<string, unknown>)
          : {};
      const nestedCwd = stringValue(message.cwd) ?? stringValue(message.foreground_cwd);
      if (nestedCwd) return nestedCwd;
    } catch {
      continue;
    }
    if (inspected >= 100) break;
  }
  return null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
