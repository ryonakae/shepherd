import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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

  const cwd = input.cwd ?? input.foregroundCwd;
  const homeDir = input.homeDir ?? process.env.HOME ?? "";

  if (input.agentSession?.kind === "id") {
    const source = historySourceFromSessionRef(input.agentSession);
    if (source === "opencode-sqlite") {
      const ref = discoverOpenCodeSession({ cwd, homeDir, sessionId: input.agentSession.value });
      if (ref) return { ...ref, kind: "agent_session" };
    }
  }

  const agent = input.agent?.toLowerCase() ?? input.agentSession?.agent.toLowerCase() ?? "";
  const candidates: Candidate[] = [];
  if (agent === "pi") {
    candidates.push(...(await scanRoot(join(homeDir, ".pi", "agent", "sessions"), "pi-jsonl")));
  }
  if (agent === "claude") {
    candidates.push(...(await scanRoot(join(homeDir, ".claude", "projects"), "claude-jsonl")));
  }
  if (agent === "codex") {
    candidates.push(...(await scanRoot(join(homeDir, ".codex", "sessions"), "codex-jsonl")));
  }
  if (agent === "gemini") {
    candidates.push(...(await scanGeminiRoot(join(homeDir, ".gemini", "tmp"))));
  }
  if (agent === "opencode") {
    const ref = discoverOpenCodeSession({ cwd, homeDir, sessionId: null });
    if (ref) return ref;
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
  const agent = ref.agent.toLowerCase();
  const source = ref.source.toLowerCase();
  if (agent === "pi" || source.includes("pi")) return "pi-jsonl";
  if (agent === "claude" || source.includes("claude")) return "claude-jsonl";
  if (agent === "codex" || source.includes("codex")) return "codex-jsonl";
  if (agent === "opencode" || source.includes("opencode")) return "opencode-sqlite";
  if (agent === "gemini" || source.includes("gemini")) return "gemini-json";
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
      const record = recordValue(parsed);
      const cwd = stringValue(record.cwd) ?? stringValue(record.foreground_cwd);
      if (cwd) return cwd;
      const payload = recordValue(record.payload);
      const payloadCwd = stringValue(payload.cwd) ?? stringValue(payload.foreground_cwd);
      if (payloadCwd) return payloadCwd;
      const message = recordValue(record.message);
      const nestedCwd = stringValue(message.cwd) ?? stringValue(message.foreground_cwd);
      if (nestedCwd) return nestedCwd;
    } catch {
      continue;
    }
    if (inspected >= 100) break;
  }
  return null;
}

async function scanGeminiRoot(root: string): Promise<Candidate[]> {
  if (!existsSync(root)) return [];
  const projectDirs = await listGeminiProjectDirs(root);
  const candidates: Candidate[] = [];
  for (const projectDir of projectDirs) {
    const cwd =
      (await readFile(join(projectDir, ".project_root"), "utf8").catch(() => "")).trim() || null;
    const sessions = await listGeminiSessionFiles(join(projectDir, "chats"));
    for (const path of sessions) {
      const stats = await stat(path).catch(() => null);
      if (!stats?.isFile()) continue;
      candidates.push({ cwd, mtimeMs: stats.mtimeMs, path, source: "gemini-json" });
    }
  }
  return candidates;
}

async function listGeminiProjectDirs(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const dirs: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (!entry.isDirectory()) continue;
    if (existsSync(join(path, ".project_root"))) dirs.push(path);
  }
  return dirs;
}

async function listGeminiSessionFiles(chatsDir: string): Promise<string[]> {
  const entries = await readdir(chatsDir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter(
      (entry) =>
        entry.isFile() && entry.name.startsWith("session-") && entry.name.endsWith(".json"),
    )
    .map((entry) => join(chatsDir, entry.name));
}

function discoverOpenCodeSession(input: {
  cwd: string | null;
  homeDir: string;
  sessionId: string | null;
}): AgentHistoryRef | null {
  const dbPath = resolveOpenCodeDbPath(input.homeDir);
  if (!existsSync(dbPath)) return null;
  let sqlite: DatabaseSync | null = null;
  try {
    sqlite = new DatabaseSync(dbPath, { readOnly: true });
    if (input.sessionId) {
      const row = sqlite
        .prepare("select id from session where id = ? limit 1")
        .get(input.sessionId) as { id: string } | undefined;
      return row
        ? { kind: "discovered_file", path: dbPath, source: "opencode-sqlite", value: row.id }
        : null;
    }
    if (!input.cwd) return null;
    const row = sqlite
      .prepare("select id from session where directory = ? order by time_updated desc limit 1")
      .get(input.cwd) as { id: string } | undefined;
    return row
      ? { kind: "discovered_file", path: dbPath, source: "opencode-sqlite", value: row.id }
      : null;
  } catch {
    return null;
  } finally {
    sqlite?.close();
  }
}

function resolveOpenCodeDbPath(homeDir: string): string {
  const override = process.env.OPENCODE_DB;
  if (override && override !== ":memory:") {
    return override.startsWith("/")
      ? override
      : join(homeDir, ".local", "share", "opencode", override);
  }
  return join(homeDir, ".local", "share", "opencode", "opencode.db");
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
