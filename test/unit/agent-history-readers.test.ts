import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { CodexHistoryReader } from "@/agent-history/codex-reader.js";
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
