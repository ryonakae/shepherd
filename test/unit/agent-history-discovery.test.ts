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

  test("returns null when conversation_summaries.db is missing (fails closed)", async () => {
    const homeDir = await tempHome("shepherd-agy-nodb-home-");
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
        cwd: "/repo",
        foregroundCwd: null,
        homeDir,
      }),
    ).resolves.toBeNull();
  });

  test("returns null when conversation_summaries.db is corrupted or unreadable (fails closed)", async () => {
    const homeDir = await tempHome("shepherd-agy-baddb-home-");
    const cliDir = join(homeDir, ".gemini", "antigravity-cli");
    const brainDir = join(cliDir, "brain");
    const sessDir = join(brainDir, "sess-123", ".system_generated", "logs");
    await mkdir(sessDir, { recursive: true });
    const transcriptPath = join(sessDir, "transcript.jsonl");
    await writeFile(
      transcriptPath,
      `${JSON.stringify({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "hello" })}\n`,
    );

    const dbPath = join(cliDir, "conversation_summaries.db");
    await writeFile(dbPath, "corrupted database file content");

    await expect(
      discoverAgentHistory({
        agent: "agy",
        agentSession: null,
        cwd: "/repo",
        foregroundCwd: null,
        homeDir,
      }),
    ).resolves.toBeNull();
  });

  test("returns null when cwd is null for agy discovery", async () => {
    const homeDir = await tempHome("shepherd-agy-nocwd-home-");
    const cliDir = join(homeDir, ".gemini", "antigravity-cli");
    const brainDir = join(cliDir, "brain");
    const sessDir = join(brainDir, "sess-123", ".system_generated", "logs");
    await mkdir(sessDir, { recursive: true });
    const transcriptPath = join(sessDir, "transcript.jsonl");
    await writeFile(
      transcriptPath,
      `${JSON.stringify({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "hello" })}\n`,
    );

    const dbPath = join(cliDir, "conversation_summaries.db");
    const sqlite = new DatabaseSync(dbPath);
    sqlite.exec(
      "create table conversation_summaries (conversation_id text primary key, workspace_uris text not null)",
    );
    sqlite
      .prepare("insert into conversation_summaries (conversation_id, workspace_uris) values (?, ?)")
      .run("sess-123", JSON.stringify(["file:///repo"]));
    sqlite.close();

    await expect(
      discoverAgentHistory({
        agent: "agy",
        agentSession: null,
        cwd: null,
        foregroundCwd: null,
        homeDir,
      }),
    ).resolves.toBeNull();
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

  test("filters Antigravity discovery by cwd matching conversation summaries workspace_uris", async () => {
    const homeDir = await tempHome("shepherd-agy-summaries-home-");
    const cliDir = join(homeDir, ".gemini", "antigravity-cli");
    const brainDir = join(cliDir, "brain");
    const olderSessDir = join(brainDir, "sess-older", ".system_generated", "logs");
    const newerSessDir = join(brainDir, "sess-newer", ".system_generated", "logs");
    await mkdir(olderSessDir, { recursive: true });
    await mkdir(newerSessDir, { recursive: true });
    const olderTranscript = join(olderSessDir, "transcript.jsonl");
    const newerTranscript = join(newerSessDir, "transcript.jsonl");
    await writeFile(
      olderTranscript,
      `${JSON.stringify({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "repo-a transcript" })}\n`,
    );
    await writeFile(
      newerTranscript,
      `${JSON.stringify({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "repo-b transcript" })}\n`,
    );
    await utimes(olderTranscript, new Date(1000), new Date(1000));
    await utimes(newerTranscript, new Date(2000), new Date(2000));

    const dbPath = join(cliDir, "conversation_summaries.db");
    const sqlite = new DatabaseSync(dbPath);
    sqlite.exec(
      "create table conversation_summaries (conversation_id text primary key, workspace_uris text not null)",
    );
    sqlite
      .prepare("insert into conversation_summaries (conversation_id, workspace_uris) values (?, ?)")
      .run("sess-older", JSON.stringify(["file:///repo-a"]));
    sqlite
      .prepare("insert into conversation_summaries (conversation_id, workspace_uris) values (?, ?)")
      .run("sess-newer", JSON.stringify(["file:///repo-b"]));
    sqlite.close();

    await expect(
      discoverAgentHistory({
        agent: "agy",
        agentSession: null,
        cwd: "/repo-a",
        foregroundCwd: null,
        homeDir,
      }),
    ).resolves.toMatchObject({
      kind: "discovered_file",
      path: olderTranscript,
      source: "agy-jsonl",
      value: olderTranscript,
    });
  });

  test("does not match root workspace URI '/' to child paths, nor child to root", async () => {
    const homeDir = await tempHome("shepherd-agy-root-boundary-");
    const cliDir = join(homeDir, ".gemini", "antigravity-cli");
    const brainDir = join(cliDir, "brain");
    const sessDir = join(brainDir, "sess-root", ".system_generated", "logs");
    await mkdir(sessDir, { recursive: true });
    const transcriptPath = join(sessDir, "transcript.jsonl");
    await writeFile(
      transcriptPath,
      `${JSON.stringify({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "root transcript" })}\n`,
    );

    const dbPath = join(cliDir, "conversation_summaries.db");
    const sqlite = new DatabaseSync(dbPath);
    sqlite.exec(
      "create table conversation_summaries (conversation_id text primary key, workspace_uris text not null)",
    );
    sqlite
      .prepare("insert into conversation_summaries (conversation_id, workspace_uris) values (?, ?)")
      .run("sess-root", JSON.stringify(["file:///"]));
    sqlite.close();

    // '/' workspace must not match '/repo'
    await expect(
      discoverAgentHistory({
        agent: "agy",
        agentSession: null,
        cwd: "/repo",
        foregroundCwd: null,
        homeDir,
      }),
    ).resolves.toBeNull();

    // Exact '/' must match '/'
    await expect(
      discoverAgentHistory({
        agent: "agy",
        agentSession: null,
        cwd: "/",
        foregroundCwd: null,
        homeDir,
      }),
    ).resolves.toMatchObject({
      kind: "discovered_file",
      path: transcriptPath,
      source: "agy-jsonl",
    });
  });

  test("does not match parent and child workspace URIs in either direction", async () => {
    const homeDir = await tempHome("shepherd-agy-parent-child-boundary-");
    const cliDir = join(homeDir, ".gemini", "antigravity-cli");
    const brainDir = join(cliDir, "brain");
    const parentSessDir = join(brainDir, "sess-parent", ".system_generated", "logs");
    const childSessDir = join(brainDir, "sess-child", ".system_generated", "logs");
    await mkdir(parentSessDir, { recursive: true });
    await mkdir(childSessDir, { recursive: true });
    const parentTranscript = join(parentSessDir, "transcript.jsonl");
    const childTranscript = join(childSessDir, "transcript.jsonl");
    await writeFile(
      parentTranscript,
      `${JSON.stringify({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "parent" })}\n`,
    );
    await writeFile(
      childTranscript,
      `${JSON.stringify({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "child" })}\n`,
    );

    const dbPath = join(cliDir, "conversation_summaries.db");
    const sqlite = new DatabaseSync(dbPath);
    sqlite.exec(
      "create table conversation_summaries (conversation_id text primary key, workspace_uris text not null)",
    );
    sqlite
      .prepare("insert into conversation_summaries (conversation_id, workspace_uris) values (?, ?)")
      .run("sess-parent", JSON.stringify(["file:///repo"]));
    sqlite
      .prepare("insert into conversation_summaries (conversation_id, workspace_uris) values (?, ?)")
      .run("sess-child", JSON.stringify(["file:///repo/packages/sub"]));
    sqlite.close();

    // cwd '/repo' must not match child '/repo/packages/sub'
    const parentResult = await discoverAgentHistory({
      agent: "agy",
      agentSession: null,
      cwd: "/repo",
      foregroundCwd: null,
      homeDir,
    });
    expect(parentResult?.path).toBe(parentTranscript);

    // cwd '/repo/packages/sub' must not match parent '/repo'
    const childResult = await discoverAgentHistory({
      agent: "agy",
      agentSession: null,
      cwd: "/repo/packages/sub",
      foregroundCwd: null,
      homeDir,
    });
    expect(childResult?.path).toBe(childTranscript);

    // cwd '/repo/packages/other' matches neither
    await expect(
      discoverAgentHistory({
        agent: "agy",
        agentSession: null,
        cwd: "/repo/packages/other",
        foregroundCwd: null,
        homeDir,
      }),
    ).resolves.toBeNull();
  });

  test("normalizes file URIs and trailing slashes correctly", async () => {
    const homeDir = await tempHome("shepherd-agy-norm-");
    const cliDir = join(homeDir, ".gemini", "antigravity-cli");
    const brainDir = join(cliDir, "brain");
    const sessDir = join(brainDir, "sess-norm", ".system_generated", "logs");
    await mkdir(sessDir, { recursive: true });
    const transcriptPath = join(sessDir, "transcript.jsonl");
    await writeFile(
      transcriptPath,
      `${JSON.stringify({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "norm" })}\n`,
    );

    const dbPath = join(cliDir, "conversation_summaries.db");
    const sqlite = new DatabaseSync(dbPath);
    sqlite.exec(
      "create table conversation_summaries (conversation_id text primary key, workspace_uris text not null)",
    );
    sqlite
      .prepare("insert into conversation_summaries (conversation_id, workspace_uris) values (?, ?)")
      .run("sess-norm", JSON.stringify(["file:///path/to/my-repo/"]));
    sqlite.close();

    await expect(
      discoverAgentHistory({
        agent: "agy",
        agentSession: null,
        cwd: "/path/to/my-repo",
        foregroundCwd: null,
        homeDir,
      }),
    ).resolves.toMatchObject({
      kind: "discovered_file",
      path: transcriptPath,
      source: "agy-jsonl",
    });
  });

  test("returns null when no Antigravity conversation matches the agent cwd", async () => {
    const homeDir = await tempHome("shepherd-agy-nomatch-home-");
    const cliDir = join(homeDir, ".gemini", "antigravity-cli");
    const brainDir = join(cliDir, "brain");
    const sessDir = join(brainDir, "sess-1", ".system_generated", "logs");
    await mkdir(sessDir, { recursive: true });
    const transcriptPath = join(sessDir, "transcript.jsonl");
    await writeFile(
      transcriptPath,
      `${JSON.stringify({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "content" })}\n`,
    );

    const dbPath = join(cliDir, "conversation_summaries.db");
    const sqlite = new DatabaseSync(dbPath);
    sqlite.exec(
      "create table conversation_summaries (conversation_id text primary key, workspace_uris text not null)",
    );
    sqlite
      .prepare("insert into conversation_summaries (conversation_id, workspace_uris) values (?, ?)")
      .run("sess-1", JSON.stringify(["file:///repo-other"]));
    sqlite.close();

    await expect(
      discoverAgentHistory({
        agent: "agy",
        agentSession: null,
        cwd: "/repo-unmatched",
        foregroundCwd: null,
        homeDir,
      }),
    ).resolves.toBeNull();
  });
});
