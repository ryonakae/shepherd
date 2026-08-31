import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vitest";
import { discoverAgentHistory, historySourceFromSessionRef } from "@/agent-history/discovery.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

async function tempHome(name: string) {
  const dir = await mkdtemp(join(tmpdir(), name));
  tempDirs.push(dir);
  return dir;
}

describe("agent history discovery", () => {
  test("maps session refs for new runtime sources", () => {
    expect(
      historySourceFromSessionRef({
        agent: "codex",
        kind: "path",
        source: "herdr:codex",
        value: "/tmp/c.jsonl",
      }),
    ).toBe("codex-jsonl");
    expect(
      historySourceFromSessionRef({
        agent: "opencode",
        kind: "id",
        source: "herdr:opencode",
        value: "ses_1",
      }),
    ).toBe("opencode-sqlite");
    expect(
      historySourceFromSessionRef({
        agent: "gemini",
        kind: "path",
        source: "herdr:gemini",
        value: "/tmp/g.json",
      }),
    ).toBe("gemini-json");
  });

  test("discovers Codex JSONL by session_meta cwd", async () => {
    const homeDir = await tempHome("shepherd-codex-home-");
    const dir = join(homeDir, ".codex", "sessions", "2026", "07", "09");
    await mkdir(dir, { recursive: true });
    const older = join(
      dir,
      "rollout-2026-07-09T10-00-00-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl",
    );
    const newer = join(
      dir,
      "rollout-2026-07-09T11-00-00-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl",
    );
    await writeFile(
      older,
      `${JSON.stringify({ type: "session_meta", payload: { cwd: "/other" } })}\n`,
    );
    await writeFile(
      newer,
      `${JSON.stringify({ type: "session_meta", payload: { cwd: "/repo" } })}\n`,
    );

    await expect(
      discoverAgentHistory({
        agent: "codex",
        agentSession: null,
        cwd: "/repo",
        foregroundCwd: null,
        homeDir,
      }),
    ).resolves.toMatchObject({
      kind: "discovered_file",
      path: newer,
      source: "codex-jsonl",
      value: newer,
    });
  });

  test("discovers OpenCode DB session by cwd", async () => {
    const homeDir = await tempHome("shepherd-opencode-home-");
    const dbPath = join(homeDir, ".local", "share", "opencode", "opencode.db");
    await mkdir(join(homeDir, ".local", "share", "opencode"), { recursive: true });
    const sqlite = new DatabaseSync(dbPath);
    sqlite.exec(
      "create table session (id text primary key, directory text not null, time_updated integer not null)",
    );
    sqlite
      .prepare("insert into session (id, directory, time_updated) values (?, ?, ?)")
      .run("s_old", "/repo", 1);
    sqlite
      .prepare("insert into session (id, directory, time_updated) values (?, ?, ?)")
      .run("s_new", "/repo", 2);
    sqlite.close();

    await expect(
      discoverAgentHistory({
        agent: "opencode",
        agentSession: null,
        cwd: "/repo",
        foregroundCwd: null,
        homeDir,
      }),
    ).resolves.toMatchObject({
      kind: "discovered_file",
      path: dbPath,
      source: "opencode-sqlite",
      value: "s_new",
    });
  });

  test("discovers Gemini session JSON through .project_root", async () => {
    const homeDir = await tempHome("shepherd-gemini-home-");
    const projectDir = join(homeDir, ".gemini", "tmp", "repo-project");
    const chatsDir = join(projectDir, "chats");
    await mkdir(chatsDir, { recursive: true });
    await writeFile(join(projectDir, ".project_root"), "/repo\n");
    const sessionPath = join(chatsDir, "session-2026-07-09T12-00-00abcdef.json");
    await writeFile(
      sessionPath,
      JSON.stringify({ messages: [{ type: "user", content: [{ text: "hello" }] }] }),
    );

    await expect(
      discoverAgentHistory({
        agent: "gemini",
        agentSession: null,
        cwd: "/repo",
        foregroundCwd: null,
        homeDir,
      }),
    ).resolves.toMatchObject({
      kind: "discovered_file",
      path: sessionPath,
      source: "gemini-json",
      value: sessionPath,
    });
  });

  test("drops recently completed same-cwd sessions that predate firstSeenAtMs", async () => {
    const homeDir = await tempHome("shepherd-codex-stale-home-");
    const dir = join(homeDir, ".codex", "sessions", "2026", "07", "09");
    await mkdir(dir, { recursive: true });
    const path = join(
      dir,
      "rollout-2026-07-09T10-00-00-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl",
    );
    await writeFile(
      path,
      `${JSON.stringify({ type: "session_meta", payload: { cwd: "/repo" } })}\n`,
    );
    const firstSeenAtMs = Date.UTC(2026, 6, 9, 14, 0, 0);
    const mtimeMs = firstSeenAtMs - 120_000; // completed 2 minutes ago
    await utimes(path, new Date(mtimeMs), new Date(mtimeMs));

    await expect(
      discoverAgentHistory({
        agent: "codex",
        agentSession: null,
        cwd: "/repo",
        firstSeenAtMs,
        foregroundCwd: null,
        homeDir,
      }),
    ).resolves.toBeNull();
  });

  test("does not fall back to different-cwd candidates when cwd-matching candidate is missing or stale", async () => {
    const homeDir = await tempHome("shepherd-codex-diffcwd-home-");
    const dir = join(homeDir, ".codex", "sessions", "2026", "07", "09");
    await mkdir(dir, { recursive: true });
    const otherPath = join(
      dir,
      "rollout-2026-07-09T10-00-00-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl",
    );
    await writeFile(
      otherPath,
      `${JSON.stringify({ type: "session_meta", payload: { cwd: "/other-repo" } })}\n`,
    );
    const firstSeenAtMs = Date.UTC(2026, 6, 9, 14, 0, 0);
    await utimes(otherPath, new Date(firstSeenAtMs + 60_000), new Date(firstSeenAtMs + 60_000));

    await expect(
      discoverAgentHistory({
        agent: "codex",
        agentSession: null,
        cwd: "/repo",
        firstSeenAtMs,
        foregroundCwd: null,
        homeDir,
      }),
    ).resolves.toBeNull();
  });

  test("allows adoption of an already-running agent whose session predates firstSeenAtMs", async () => {
    const homeDir = await tempHome("shepherd-codex-adopt-home-");
    const dir = join(homeDir, ".codex", "sessions", "2026", "07", "09");
    await mkdir(dir, { recursive: true });
    const path = join(
      dir,
      "rollout-2026-07-09T10-00-00-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl",
    );
    await writeFile(
      path,
      `${JSON.stringify({ type: "session_meta", payload: { cwd: "/repo" } })}\n`,
    );
    const firstSeenAtMs = Date.UTC(2026, 6, 9, 14, 0, 0);
    const mtimeMs = firstSeenAtMs - 900_000; // 15 minutes ago
    await utimes(path, new Date(mtimeMs), new Date(mtimeMs));

    await expect(
      discoverAgentHistory({
        agent: "codex",
        agentSession: null,
        cwd: "/repo",
        firstSeenAtMs,
        foregroundCwd: null,
        homeDir,
        isAdoption: true,
      }),
    ).resolves.toMatchObject({
      kind: "discovered_file",
      path,
      source: "codex-jsonl",
      value: path,
    });
  });

  test("keeps a candidate whose mtime is at or after firstSeenAtMs", async () => {
    const homeDir = await tempHome("shepherd-codex-recent-home-");
    const dir = join(homeDir, ".codex", "sessions", "2026", "07", "09");
    await mkdir(dir, { recursive: true });
    const path = join(
      dir,
      "rollout-2026-07-09T10-00-00-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl",
    );
    await writeFile(
      path,
      `${JSON.stringify({ type: "session_meta", payload: { cwd: "/repo" } })}\n`,
    );
    const firstSeenAtMs = Date.UTC(2026, 6, 9, 14, 0, 0);
    const mtimeMs = firstSeenAtMs + 60_000;
    await utimes(path, new Date(mtimeMs), new Date(mtimeMs));

    await expect(
      discoverAgentHistory({
        agent: "codex",
        agentSession: null,
        cwd: "/repo",
        firstSeenAtMs,
        foregroundCwd: null,
        homeDir,
      }),
    ).resolves.toMatchObject({
      kind: "discovered_file",
      path,
      source: "codex-jsonl",
      value: path,
    });
  });

  test("enforces recency and supports adoption for OpenCode discovery", async () => {
    const homeDir = await tempHome("shepherd-opencode-recency-home-");
    const dbPath = join(homeDir, ".local", "share", "opencode", "opencode.db");
    await mkdir(join(homeDir, ".local", "share", "opencode"), { recursive: true });
    const sqlite = new DatabaseSync(dbPath);
    sqlite.exec(
      "create table session (id text primary key, directory text not null, time_updated integer not null)",
    );
    const firstSeenAtMs = 50_000;
    sqlite
      .prepare("insert into session (id, directory, time_updated) values (?, ?, ?)")
      .run("s_stale", "/repo", 40_000);
    sqlite
      .prepare("insert into session (id, directory, time_updated) values (?, ?, ?)")
      .run("s_diff_cwd", "/other-repo", 60_000);
    sqlite.close();

    // New run drops stale same-cwd session and ignores different-cwd session
    await expect(
      discoverAgentHistory({
        agent: "opencode",
        agentSession: null,
        cwd: "/repo",
        firstSeenAtMs,
        foregroundCwd: null,
        homeDir,
      }),
    ).resolves.toBeNull();

    // Adoption accepts the existing same-cwd session even if time_updated < firstSeenAtMs
    await expect(
      discoverAgentHistory({
        agent: "opencode",
        agentSession: null,
        cwd: "/repo",
        firstSeenAtMs,
        foregroundCwd: null,
        homeDir,
        isAdoption: true,
      }),
    ).resolves.toMatchObject({
      kind: "discovered_file",
      path: dbPath,
      source: "opencode-sqlite",
      value: "s_stale",
    });
  });

  test("keeps old behavior when firstSeenAtMs is omitted", async () => {
    const homeDir = await tempHome("shepherd-codex-noftime-home-");
    const dir = join(homeDir, ".codex", "sessions", "2026", "07", "09");
    await mkdir(dir, { recursive: true });
    const path = join(
      dir,
      "rollout-2026-07-09T10-00-00-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl",
    );
    await writeFile(
      path,
      `${JSON.stringify({ type: "session_meta", payload: { cwd: "/repo" } })}\n`,
    );
    await utimes(path, new Date(1000), new Date(1000));

    await expect(
      discoverAgentHistory({
        agent: "codex",
        agentSession: null,
        cwd: "/repo",
        foregroundCwd: null,
        homeDir,
      }),
    ).resolves.toMatchObject({
      kind: "discovered_file",
      path,
      source: "codex-jsonl",
      value: path,
    });
  });

  test("leaves the authoritative agentSession path resolve unaffected by firstSeenAtMs", async () => {
    const homeDir = await tempHome("shepherd-path-home-");
    const sessionPath = join(homeDir, ".pi", "agent", "sessions", "ses-1.jsonl");
    await mkdir(join(homeDir, ".pi", "agent", "sessions"), { recursive: true });
    await writeFile(sessionPath, "{}");
    await utimes(sessionPath, new Date(1000), new Date(1000));

    await expect(
      discoverAgentHistory({
        agent: "pi",
        agentSession: { agent: "pi", kind: "path", source: "herdr:pi", value: sessionPath },
        cwd: null,
        firstSeenAtMs: Date.UTC(2026, 6, 9, 14, 0, 0),
        foregroundCwd: null,
        homeDir,
      }),
    ).resolves.toMatchObject({
      kind: "agent_session",
      path: sessionPath,
      source: "pi-jsonl",
      value: sessionPath,
    });
  });
});
