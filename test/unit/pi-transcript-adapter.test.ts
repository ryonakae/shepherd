import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { PiTranscriptAdapter } from "@/observability/pi-transcript-adapter.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("PiTranscriptAdapter", () => {
  test("reads Pi JSONL transcript hints and evidence", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-transcript-"));
    tempDirs.push(dir);
    const sessionFile = join(dir, "session.jsonl");
    writeFileSync(
      sessionFile,
      [
        {
          type: "session",
          version: 3,
          id: "pi-session",
          timestamp: "2026-07-02T00:00:00.000Z",
          cwd: "/repo",
        },
        {
          type: "message",
          id: "u1",
          parentId: null,
          timestamp: "2026-07-02T00:00:01.000Z",
          message: { role: "user", content: "implement feature" },
        },
        {
          type: "message",
          id: "a1",
          parentId: "u1",
          timestamp: "2026-07-02T00:00:02.000Z",
          message: {
            role: "assistant",
            content: [
              { type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "pnpm test" } },
            ],
            stopReason: "toolUse",
          },
        },
        {
          type: "message",
          id: "t1",
          parentId: "a1",
          timestamp: "2026-07-02T00:00:03.000Z",
          message: {
            role: "toolResult",
            toolCallId: "tool-1",
            toolName: "bash",
            content: [{ type: "text", text: "failed: expected true to be false" }],
            isError: true,
          },
        },
        {
          type: "message",
          id: "a2",
          parentId: "t1",
          timestamp: "2026-07-02T00:00:04.000Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Blocked: tests fail because fixture is outdated." }],
            stopReason: "stop",
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n"),
    );

    const adapter = new PiTranscriptAdapter();
    await expect(
      adapter.read({ source: "herdr:pi", agent: "pi", kind: "path", value: sessionFile }),
    ).resolves.toMatchObject({
      lastMessageExcerpt: "Blocked: tests fail because fixture is outdated.",
      lastTool: {
        isError: true,
        name: "bash",
        outputExcerpt: "failed: expected true to be false",
        toolCallId: "tool-1",
      },
      statusHints: { blockedReason: "Blocked: tests fail because fixture is outdated." },
    });

    const backfill = await adapter.read({
      source: "herdr:pi",
      agent: "pi",
      kind: "path",
      value: sessionFile,
    });
    expect(backfill.evidence.map((evidence) => evidence.ref)).toEqual(
      expect.arrayContaining([`${sessionFile}#entry=t1`, `${sessionFile}#entry=a2`]),
    );
  });
});
