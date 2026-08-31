import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vitest";
import { AgyHistoryReader } from "@/agent-history/agy-reader.js";
import { CodexHistoryReader } from "@/agent-history/codex-reader.js";
import { GeminiHistoryReader } from "@/agent-history/gemini-reader.js";
import { OpenCodeHistoryReader } from "@/agent-history/opencode-reader.js";
import { createAgentHistoryService } from "@/agent-history/service.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

async function tempHome(name: string) {
  const dir = await mkdtemp(join(tmpdir(), name));
  tempDirs.push(dir);
  return dir;
}

describe("CodexHistoryReader", () => {
  test("reads user, assistant, and tool output messages", async () => {
    const homeDir = await tempHome("shepherd-codex-reader-");
    const dir = join(homeDir, ".codex", "sessions", "2026", "07", "09");
    await mkdir(dir, { recursive: true });
    const path = join(
      dir,
      "rollout-2026-07-09T12-00-00-cccccccc-cccc-4ccc-8ccc-cccccccccccc.jsonl",
    );
    await writeFile(
      path,
      `${[
        { type: "session_meta", payload: { cwd: "/repo", timestamp: "2026-07-09T12:00:00.000Z" } },
        {
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "please inspect",
            timestamp: "2026-07-09T12:00:01.000Z",
          },
        },
        {
          type: "response_item",
          payload: { type: "function_call", call_id: "call_1", name: "bash", arguments: "{}" },
        },
        {
          type: "response_item",
          payload: { type: "function_call_output", call_id: "call_1", output: "line 1\nline 2" },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "done" }],
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n")}\n`,
    );

    const messages = await new CodexHistoryReader().read(
      { kind: "discovered_file", path, source: "codex-jsonl", value: path },
      { limit: 20 },
    );

    expect(messages.map((message) => message.role)).toEqual(["user", "tool_result", "assistant"]);
    expect(messages[0]).toMatchObject({ role: "user", text: "please inspect" });
    expect(messages[1]).toMatchObject({ role: "tool_result", toolName: "bash" });
    expect(messages[1]?.compact?.text).toContain("line 1");
    expect(messages[2]).toMatchObject({ role: "assistant", text: "done" });
  });

  test("is registered in the default agent history service", async () => {
    const homeDir = await tempHome("shepherd-codex-service-");
    const dir = join(homeDir, ".codex", "sessions", "2026", "07", "09");
    await mkdir(dir, { recursive: true });
    const path = join(
      dir,
      "rollout-2026-07-09T13-00-00-dddddddd-dddd-4ddd-8ddd-dddddddddddd.jsonl",
    );
    await writeFile(
      path,
      `${JSON.stringify({ type: "session_meta", payload: { cwd: "/repo" } })}\n${JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "hello" } })}\n`,
    );

    const service = createAgentHistoryService({ homeDir });
    await expect(
      service.read(
        { agent: "codex", agentSession: null, cwd: "/repo", foregroundCwd: null },
        { limit: 10 },
      ),
    ).resolves.toMatchObject({
      historyRef: { source: "codex-jsonl", path },
      messages: [expect.objectContaining({ role: "user", text: "hello" })],
    });
  });
});

describe("OpenCodeHistoryReader", () => {
  test("reads text and tool parts from an OpenCode SQLite session", async () => {
    const homeDir = await tempHome("shepherd-opencode-reader-");
    const dbPath = join(homeDir, "opencode.db");
    const sqlite = new DatabaseSync(dbPath);
    sqlite.exec(`
      create table session (id text primary key, directory text not null, time_updated integer not null);
      create table message (id text primary key, session_id text not null, time_created integer not null, time_updated integer not null, data text not null);
      create table part (id text primary key, message_id text not null, session_id text not null, time_created integer not null, time_updated integer not null, data text not null);
    `);
    sqlite
      .prepare("insert into session (id, directory, time_updated) values (?, ?, ?)")
      .run("s1", "/repo", 1000);
    sqlite
      .prepare(
        "insert into message (id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?)",
      )
      .run("m1", "s1", 1000, 1000, JSON.stringify({ role: "user" }));
    sqlite
      .prepare(
        "insert into part (id, message_id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?)",
      )
      .run("p1", "m1", "s1", 1001, 1001, JSON.stringify({ type: "text", text: "inspect this" }));
    sqlite
      .prepare(
        "insert into message (id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?)",
      )
      .run("m2", "s1", 2000, 2000, JSON.stringify({ role: "assistant", finish: "tool-calls" }));
    sqlite
      .prepare(
        "insert into part (id, message_id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?)",
      )
      .run(
        "p2",
        "m2",
        "s1",
        2001,
        2001,
        JSON.stringify({
          type: "tool",
          tool: "bash",
          state: { status: "completed", output: "ok" },
        }),
      );
    sqlite
      .prepare(
        "insert into part (id, message_id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?)",
      )
      .run("p3", "m2", "s1", 2002, 2002, JSON.stringify({ type: "text", text: "done" }));
    sqlite.close();

    const messages = await new OpenCodeHistoryReader().read(
      { kind: "discovered_file", path: dbPath, source: "opencode-sqlite", value: "s1" },
      { limit: 10 },
    );

    expect(messages.map((message) => message.role)).toEqual(["user", "tool_result", "assistant"]);
    expect(messages[0]).toMatchObject({ role: "user", text: "inspect this" });
    expect(messages[1]).toMatchObject({ role: "tool_result", toolName: "bash" });
    expect(messages[1]?.compact?.text).toContain("ok");
    expect(messages[2]).toMatchObject({ role: "assistant", text: "done" });
  });

  test("returns empty history when the OpenCode DB schema is unreadable", async () => {
    const homeDir = await tempHome("shepherd-opencode-bad-db-");
    const dbPath = join(homeDir, "opencode.db");
    const sqlite = new DatabaseSync(dbPath);
    sqlite.exec("create table unrelated (id text primary key)");
    sqlite.close();

    await expect(
      new OpenCodeHistoryReader().read(
        { kind: "discovered_file", path: dbPath, source: "opencode-sqlite", value: "s1" },
        { limit: 10 },
      ),
    ).resolves.toEqual([]);
  });
});

describe("GeminiHistoryReader", () => {
  test("reads user and gemini assistant messages from object-shaped session JSON", async () => {
    const homeDir = await tempHome("shepherd-gemini-reader-");
    const projectDir = join(homeDir, ".gemini", "tmp", "repo-project");
    const chatsDir = join(projectDir, "chats");
    await mkdir(chatsDir, { recursive: true });
    const sessionPath = join(chatsDir, "session-2026-07-09T12-00-00abcdef.json");
    await writeFile(
      sessionPath,
      JSON.stringify({
        sessionId: "g1",
        messages: [
          {
            id: "u1",
            timestamp: "2026-07-09T12:00:00.000Z",
            type: "user",
            content: [{ text: "please check" }],
          },
          { id: "a1", timestamp: "2026-07-09T12:00:01.000Z", type: "gemini", content: "checked" },
          { id: "i1", timestamp: "2026-07-09T12:00:02.000Z", type: "info", content: "ignored" },
        ],
      }),
    );

    const messages = await new GeminiHistoryReader().read(
      { kind: "discovered_file", path: sessionPath, source: "gemini-json", value: sessionPath },
      { limit: 10 },
    );

    expect(messages).toEqual([
      expect.objectContaining({
        role: "user",
        text: "please check",
        timestamp: "2026-07-09T12:00:00.000Z",
      }),
      expect.objectContaining({
        role: "assistant",
        text: "checked",
        timestamp: "2026-07-09T12:00:01.000Z",
      }),
    ]);
  });

  test("reads tool result messages when Gemini session records tool output", async () => {
    const homeDir = await tempHome("shepherd-gemini-tool-");
    const sessionPath = join(homeDir, "session.json");
    await writeFile(
      sessionPath,
      JSON.stringify({
        messages: [
          {
            id: "t1",
            timestamp: "2026-07-09T12:00:03.000Z",
            type: "tool",
            tool: "shell",
            content: "ok",
          },
        ],
      }),
    );

    const messages = await new GeminiHistoryReader().read(
      { kind: "discovered_file", path: sessionPath, source: "gemini-json", value: sessionPath },
      { limit: 10 },
    );

    expect(messages).toEqual([expect.objectContaining({ role: "tool_result", toolName: "shell" })]);
    expect(messages[0]?.compact?.text).toContain("ok");
  });

  test("returns empty history when Gemini session JSON is malformed", async () => {
    const homeDir = await tempHome("shepherd-gemini-bad-json-");
    const sessionPath = join(homeDir, "session.json");
    await writeFile(sessionPath, "{not-json");

    await expect(
      new GeminiHistoryReader().read(
        { kind: "discovered_file", path: sessionPath, source: "gemini-json", value: sessionPath },
        { limit: 10 },
      ),
    ).resolves.toEqual([]);
  });
});

describe("AgyHistoryReader", () => {
  test("reads user, assistant, and actual tool output messages in multi-turn conversation", async () => {
    const homeDir = await tempHome("shepherd-agy-reader-");
    const transcriptDir = join(
      homeDir,
      ".gemini",
      "antigravity-cli",
      "brain",
      "sess_1",
      ".system_generated",
      "logs",
    );
    await mkdir(transcriptDir, { recursive: true });
    const transcriptPath = join(transcriptDir, "transcript.jsonl");
    await writeFile(
      transcriptPath,
      `${[
        {
          step_index: 0,
          source: "USER_EXPLICIT",
          type: "USER_INPUT",
          created_at: "2026-08-20T10:00:00.000Z",
          content: "list files",
        },
        {
          step_index: 1,
          source: "MODEL",
          type: "PLANNER_RESPONSE",
          created_at: "2026-08-20T10:00:01.000Z",
          tool_calls: [{ name: "list_dir", args: { path: "/repo" } }],
        },
        {
          step_index: 2,
          source: "MODEL",
          type: "LIST_DIRECTORY",
          created_at: "2026-08-20T10:00:02.000Z",
          content: "a.ts\nb.ts",
        },
        {
          step_index: 3,
          source: "MODEL",
          type: "PLANNER_RESPONSE",
          created_at: "2026-08-20T10:00:03.000Z",
          content: "Here are the files: a.ts, b.ts",
        },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n")}\n`,
    );

    const reader = new AgyHistoryReader({ homeDir });
    const messages = await reader.read(
      { kind: "discovered_file", path: transcriptPath, source: "agy-jsonl", value: transcriptPath },
      { limit: 10 },
    );

    expect(messages.map((m) => m.role)).toEqual(["user", "tool_result", "assistant"]);
    expect(messages[0]).toMatchObject({
      role: "user",
      text: "list files",
      timestamp: "2026-08-20T10:00:00.000Z",
    });
    expect(messages[1]).toMatchObject({
      role: "tool_result",
      toolName: "list_dir",
      timestamp: "2026-08-20T10:00:02.000Z",
    });
    expect(messages[1]?.compact?.text).toBe("a.ts\nb.ts");
    expect(messages[1]?.compact?.isError).toBe(false);
    expect(messages[2]).toMatchObject({
      role: "assistant",
      text: "Here are the files: a.ts, b.ts",
      timestamp: "2026-08-20T10:00:03.000Z",
    });

    const compact = await reader.readCompact({
      kind: "discovered_file",
      path: transcriptPath,
      source: "agy-jsonl",
      value: transcriptPath,
    });
    expect(compact.messageCount).toBe(3);
    expect(compact.lastUserMessage?.text).toBe("list files");
    expect(compact.lastAssistantMessage?.text).toBe("Here are the files: a.ts, b.ts");
    expect(compact.lastToolResult?.toolName).toBe("list_dir");
    expect(compact.lastToolResult?.text).toBe("a.ts\nb.ts");
  });

  test("reads tool error entries and marks them as isError", async () => {
    const homeDir = await tempHome("shepherd-agy-errors-");
    const transcriptPath = join(homeDir, "transcript.jsonl");
    await writeFile(
      transcriptPath,
      `${[
        {
          step_index: 0,
          source: "USER_EXPLICIT",
          type: "USER_INPUT",
          created_at: "2026-08-20T10:00:00.000Z",
          content: "run failing command",
        },
        {
          step_index: 1,
          source: "MODEL",
          type: "PLANNER_RESPONSE",
          created_at: "2026-08-20T10:00:01.000Z",
          tool_calls: [{ name: "run_command", args: { CommandLine: "pnpm test" } }],
        },
        {
          step_index: 2,
          source: "MODEL",
          type: "RUN_COMMAND",
          status: "ERROR",
          exit_code: 1,
          created_at: "2026-08-20T10:00:02.000Z",
          content: "FAIL test/a.test.ts\nAssertionError: expected 1 to be 0",
        },
        {
          step_index: 3,
          source: "MODEL",
          type: "PLANNER_RESPONSE",
          created_at: "2026-08-20T10:00:03.000Z",
          tool_calls: [{ name: "bad_tool", args: {} }],
        },
        {
          step_index: 4,
          source: "SYSTEM",
          type: "ERROR_MESSAGE",
          created_at: "2026-08-20T10:00:04.000Z",
          error: "There was a problem parsing the tool call.",
          content: "Error invalid tool call",
        },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n")}\n`,
    );

    const reader = new AgyHistoryReader();
    const messages = await reader.read({
      kind: "discovered_file",
      path: transcriptPath,
      source: "agy-jsonl",
      value: transcriptPath,
    });

    expect(messages.map((m) => m.role)).toEqual(["user", "tool_result", "tool_result"]);
    expect(messages[1]).toMatchObject({
      role: "tool_result",
      toolName: "run_command",
    });
    expect(messages[1]?.compact?.isError).toBe(true);
    expect(messages[1]?.compact?.text).toContain("AssertionError");

    expect(messages[2]).toMatchObject({
      role: "tool_result",
      toolName: "bad_tool",
    });
    expect(messages[2]?.compact?.isError).toBe(true);
    expect(messages[2]?.compact?.text).toContain("Error invalid tool call");
  });

  test("handles multiple tool calls in a single turn and pairs results sequentially", async () => {
    const homeDir = await tempHome("shepherd-agy-multicall-");
    const transcriptPath = join(homeDir, "transcript.jsonl");
    await writeFile(
      transcriptPath,
      `${[
        {
          step_index: 0,
          source: "USER_EXPLICIT",
          type: "USER_INPUT",
          created_at: "2026-08-20T10:00:00.000Z",
          content: "read two files",
        },
        {
          step_index: 1,
          source: "MODEL",
          type: "PLANNER_RESPONSE",
          created_at: "2026-08-20T10:00:01.000Z",
          tool_calls: [
            { name: "view_file", args: { AbsolutePath: "/repo/a.ts" } },
            { name: "view_file", args: { AbsolutePath: "/repo/b.ts" } },
          ],
        },
        {
          step_index: 2,
          source: "MODEL",
          type: "VIEW_FILE",
          created_at: "2026-08-20T10:00:02.000Z",
          content: "const a = 1;",
        },
        {
          step_index: 3,
          source: "MODEL",
          type: "VIEW_FILE",
          created_at: "2026-08-20T10:00:03.000Z",
          content: "const b = 2;",
        },
        {
          step_index: 4,
          source: "MODEL",
          type: "PLANNER_RESPONSE",
          created_at: "2026-08-20T10:00:04.000Z",
          content: "read both",
        },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n")}\n`,
    );

    const reader = new AgyHistoryReader();
    const messages = await reader.read({
      kind: "discovered_file",
      path: transcriptPath,
      source: "agy-jsonl",
      value: transcriptPath,
    });

    expect(messages.map((m) => m.role)).toEqual([
      "user",
      "tool_result",
      "tool_result",
      "assistant",
    ]);
    expect(messages[1]).toMatchObject({
      role: "tool_result",
      toolName: "view_file",
      text: "const a = 1;",
    });
    expect(messages[2]).toMatchObject({
      role: "tool_result",
      toolName: "view_file",
      text: "const b = 2;",
    });
    expect(messages[3]).toMatchObject({
      role: "assistant",
      text: "read both",
    });
  });

  test("omits tool results when tool calls have no following execution results", async () => {
    const homeDir = await tempHome("shepherd-agy-no-results-");
    const transcriptPath = join(homeDir, "transcript.jsonl");
    await writeFile(
      transcriptPath,
      `${[
        {
          step_index: 0,
          source: "USER_EXPLICIT",
          type: "USER_INPUT",
          created_at: "2026-08-20T10:00:00.000Z",
          content: "interrupted task",
        },
        {
          step_index: 1,
          source: "MODEL",
          type: "PLANNER_RESPONSE",
          created_at: "2026-08-20T10:00:01.000Z",
          tool_calls: [{ name: "run_cmd", args: "echo 1" }],
        },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n")}\n`,
    );

    const reader = new AgyHistoryReader();
    const messages = await reader.read({
      kind: "discovered_file",
      path: transcriptPath,
      source: "agy-jsonl",
      value: transcriptPath,
    });

    expect(messages).toEqual([expect.objectContaining({ role: "user", text: "interrupted task" })]);

    const compact = await reader.readCompact({
      kind: "discovered_file",
      path: transcriptPath,
      source: "agy-jsonl",
      value: transcriptPath,
    });
    expect(compact.messageCount).toBe(1);
    expect(compact.lastUserMessage?.text).toBe("interrupted task");
    expect(compact.lastAssistantMessage).toBeNull();
    expect(compact.lastToolResult).toBeNull();
  });

  test("parses assistant messages with structured array content and ignores empty content on tool_calls", async () => {
    const homeDir = await tempHome("shepherd-agy-array-content-");
    const transcriptPath = join(homeDir, "transcript.jsonl");
    await writeFile(
      transcriptPath,
      `${[
        {
          step_index: 0,
          source: "USER_EXPLICIT",
          type: "USER_INPUT",
          created_at: "2026-08-20T10:00:00.000Z",
          content: [{ type: "text", text: "hello array user" }],
        },
        {
          step_index: 1,
          source: "MODEL",
          type: "PLANNER_RESPONSE",
          created_at: "2026-08-20T10:00:01.000Z",
          content: "",
          tool_calls: [{ name: "run_cmd", args: "echo 1" }],
        },
        {
          step_index: 2,
          source: "MODEL",
          type: "RUN_COMMAND",
          created_at: "2026-08-20T10:00:02.000Z",
          content: "1",
        },
        {
          step_index: 3,
          source: "MODEL",
          type: "PLANNER_RESPONSE",
          created_at: "2026-08-20T10:00:03.000Z",
          content: [{ type: "text", text: "hello array assistant" }],
        },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n")}\n`,
    );

    const reader = new AgyHistoryReader({ homeDir });
    const messages = await reader.read(
      { kind: "discovered_file", path: transcriptPath, source: "agy-jsonl", value: transcriptPath },
      { limit: 10 },
    );

    expect(messages.map((m) => m.role)).toEqual(["user", "tool_result", "assistant"]);
    expect(messages[0]).toMatchObject({ role: "user", text: "hello array user" });
    expect(messages[1]).toMatchObject({ role: "tool_result", toolName: "run_cmd", text: "1" });
    expect(messages[2]).toMatchObject({ role: "assistant", text: "hello array assistant" });
  });

  test("returns empty history for empty file", async () => {
    const homeDir = await tempHome("shepherd-agy-empty-");
    const transcriptPath = join(homeDir, "transcript.jsonl");
    await writeFile(transcriptPath, "");

    const messages = await new AgyHistoryReader().read({
      kind: "discovered_file",
      path: transcriptPath,
      source: "agy-jsonl",
      value: transcriptPath,
    });
    expect(messages).toEqual([]);
  });

  test("skips malformed JSON lines and parses valid lines", async () => {
    const homeDir = await tempHome("shepherd-agy-bad-json-");
    const transcriptPath = join(homeDir, "transcript.jsonl");
    await writeFile(
      transcriptPath,
      `{not-valid-json\n${JSON.stringify({
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        content: "hello",
      })}\n{"half":"line\n`,
    );

    const messages = await new AgyHistoryReader().read({
      kind: "discovered_file",
      path: transcriptPath,
      source: "agy-jsonl",
      value: transcriptPath,
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: "user", text: "hello" });
  });

  test("returns empty array when file does not exist", async () => {
    const homeDir = await tempHome("shepherd-agy-nonexistent-");
    const transcriptPath = join(homeDir, "nonexistent.jsonl");

    const messages = await new AgyHistoryReader().read({
      kind: "discovered_file",
      path: transcriptPath,
      source: "agy-jsonl",
      value: transcriptPath,
    });
    expect(messages).toEqual([]);
  });

  test("resolves transcript path by session ID value and homeDir", async () => {
    const homeDir = await tempHome("shepherd-agy-valpath-");
    const sessionId = "30116061-fc68-4ce7-9406-7c9759193f45";
    const transcriptDir = join(
      homeDir,
      ".gemini",
      "antigravity-cli",
      "brain",
      sessionId,
      ".system_generated",
      "logs",
    );
    await mkdir(transcriptDir, { recursive: true });
    const transcriptPath = join(transcriptDir, "transcript.jsonl");
    await writeFile(
      transcriptPath,
      `${JSON.stringify({
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        content: "from sessionId",
      })}\n`,
    );

    const reader = new AgyHistoryReader({ homeDir });
    const messages = await reader.read({
      kind: "agent_session",
      source: "agy-jsonl",
      value: sessionId,
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: "user", text: "from sessionId" });
  });

  test("is registered in the default agent history service", async () => {
    const homeDir = await tempHome("shepherd-agy-service-");
    const cliDir = join(homeDir, ".gemini", "antigravity-cli");
    const transcriptDir = join(cliDir, "brain", "sess_service", ".system_generated", "logs");
    await mkdir(transcriptDir, { recursive: true });
    const transcriptPath = join(transcriptDir, "transcript.jsonl");
    await writeFile(
      transcriptPath,
      `${JSON.stringify({
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        content: "service integration",
      })}\n`,
    );

    const dbPath = join(cliDir, "conversation_summaries.db");
    const sqlite = new DatabaseSync(dbPath);
    sqlite.exec(
      "create table conversation_summaries (conversation_id text primary key, workspace_uris text not null)",
    );
    sqlite
      .prepare("insert into conversation_summaries (conversation_id, workspace_uris) values (?, ?)")
      .run("sess_service", JSON.stringify(["file:///repo"]));
    sqlite.close();

    const service = createAgentHistoryService({ homeDir });
    await expect(
      service.read(
        { agent: "agy", agentSession: null, cwd: "/repo", foregroundCwd: null },
        { limit: 10 },
      ),
    ).resolves.toMatchObject({
      historyRef: { source: "agy-jsonl", path: transcriptPath },
      messages: [expect.objectContaining({ role: "user", text: "service integration" })],
    });
  });

  test("omits orphan entries with unknown/generic types when pendingToolCalls is empty but accepts known execution types", async () => {
    const homeDir = await tempHome("shepherd-agy-orphan-filter-");
    const transcriptPath = join(homeDir, "transcript.jsonl");
    await writeFile(
      transcriptPath,
      `${[
        {
          step_index: 0,
          source: "USER_EXPLICIT",
          type: "USER_INPUT",
          created_at: "2026-08-20T10:00:00.000Z",
          content: "do work",
        },
        {
          step_index: 1,
          source: "MODEL",
          type: "PLANNER_RESPONSE",
          created_at: "2026-08-20T10:00:01.000Z",
          content: "thinking...",
        },
        {
          step_index: 2,
          source: "MODEL",
          type: "GENERIC",
          created_at: "2026-08-20T10:00:02.000Z",
          content: "internal bookkeeping record",
        },
        {
          step_index: 3,
          source: "MODEL",
          type: "CUSTOM_UNKNOWN_METADATA",
          created_at: "2026-08-20T10:00:03.000Z",
          content: "some other metadata",
        },
        {
          step_index: 4,
          source: "MODEL",
          type: "RUN_COMMAND",
          created_at: "2026-08-20T10:00:04.000Z",
          content: "command executed successfully",
        },
        {
          step_index: 5,
          source: "MODEL",
          type: "ERROR_MESSAGE",
          created_at: "2026-08-20T10:00:05.000Z",
          error: "something failed",
        },
        {
          step_index: 6,
          source: "MODEL",
          type: "PLANNER_RESPONSE",
          created_at: "2026-08-20T10:00:06.000Z",
          content: "all done",
        },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n")}\n`,
    );

    const reader = new AgyHistoryReader({ homeDir });
    const messages = await reader.read(
      { kind: "discovered_file", path: transcriptPath, source: "agy-jsonl", value: transcriptPath },
      { limit: 20 },
    );

    expect(messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool_result",
      "tool_result",
      "assistant",
    ]);
    expect(messages[0]).toMatchObject({ role: "user", text: "do work" });
    expect(messages[1]).toMatchObject({ role: "assistant", text: "thinking..." });
    expect(messages[2]).toMatchObject({
      role: "tool_result",
      toolName: "run_command",
      text: "command executed successfully",
    });
    expect(messages[3]).toMatchObject({
      role: "tool_result",
      toolName: "unknown",
      text: "something failed",
    });
    expect(messages[3]?.compact?.isError).toBe(true);
    expect(messages[4]).toMatchObject({ role: "assistant", text: "all done" });
  });
});

