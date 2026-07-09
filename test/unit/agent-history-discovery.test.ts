import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
});
