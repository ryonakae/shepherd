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
    expect(
      historySourceFromSessionRef({
        agent: "agy",
        kind: "path",
        source: "herdr:agy",
        value: "/tmp/transcript.jsonl",
      }),
    ).toBe("agy-jsonl");
    expect(
      historySourceFromSessionRef({
        agent: "antigravity_cli",
        kind: "id",
        source: "herdr:antigravity",
        value: "sess-1",
      }),
    ).toBe("agy-jsonl");
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

  test("discovers Antigravity JSONL session from brain directory", async () => {
    const homeDir = await tempHome("shepherd-agy-home-");
    const brainDir = join(homeDir, ".gemini", "antigravity-cli", "brain");
    const sessDir = join(brainDir, "sess-123", ".system_generated", "logs");
    await mkdir(sessDir, { recursive: true });
    const transcriptPath = join(sessDir, "transcript.jsonl");
    await writeFile(
      transcriptPath,
      `${JSON.stringify({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "hello" })}\n`,
    );

    await expect(
      discoverAgentHistory({
        agent: "agy",
        agentSession: null,
        cwd: null,
        foregroundCwd: null,
        homeDir,
      }),
    ).resolves.toMatchObject({
      kind: "discovered_file",
      path: transcriptPath,
      source: "agy-jsonl",
      value: transcriptPath,
    });
  });

  test("discovers latest Antigravity session ordered by mtime when multiple sessions exist", async () => {
    const homeDir = await tempHome("shepherd-agy-multi-home-");
    const brainDir = join(homeDir, ".gemini", "antigravity-cli", "brain");
    const olderSessDir = join(brainDir, "sess-older", ".system_generated", "logs");
    const newerSessDir = join(brainDir, "sess-newer", ".system_generated", "logs");
    await mkdir(olderSessDir, { recursive: true });
    await mkdir(newerSessDir, { recursive: true });
    const olderTranscript = join(olderSessDir, "transcript.jsonl");
    const newerTranscript = join(newerSessDir, "transcript.jsonl");
    await writeFile(
      olderTranscript,
      `${JSON.stringify({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "older" })}\n`,
    );
    await writeFile(
      newerTranscript,
      `${JSON.stringify({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "newer" })}\n`,
    );
    await utimes(olderTranscript, new Date(1000), new Date(1000));
    await utimes(newerTranscript, new Date(2000), new Date(2000));

    await expect(
      discoverAgentHistory({
        agent: "agy",
        agentSession: null,
        cwd: null,
        foregroundCwd: null,
        homeDir,
      }),
    ).resolves.toMatchObject({
      kind: "discovered_file",
      path: newerTranscript,
      source: "agy-jsonl",
      value: newerTranscript,
    });
  });

  test("discovers Antigravity session by id", async () => {
    const homeDir = await tempHome("shepherd-agy-id-home-");
    const brainDir = join(homeDir, ".gemini", "antigravity-cli", "brain");
    const sessDir = join(brainDir, "sess-456", ".system_generated", "logs");
    await mkdir(sessDir, { recursive: true });
    const transcriptPath = join(sessDir, "transcript.jsonl");
    await writeFile(
      transcriptPath,
      `${JSON.stringify({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "hello" })}\n`,
    );

    await expect(
      discoverAgentHistory({
        agent: "agy",
        agentSession: {
          agent: "agy",
          kind: "id",
          source: "herdr:agy",
          value: "sess-456",
        },
        cwd: null,
        foregroundCwd: null,
        homeDir,
      }),
    ).resolves.toMatchObject({
      kind: "agent_session",
      path: transcriptPath,
      source: "agy-jsonl",
      value: "sess-456",
    });
  });
});
