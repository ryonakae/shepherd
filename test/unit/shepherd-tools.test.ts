import { Readable } from "node:stream";
import { describe, expect, test } from "vitest";
import {
  handleShepherdToolsRequest,
  parseShepherdToolsArgs,
  runShepherdToolsStdio,
  type ShepherdToolsClient,
  shepherdToolsHelpText,
} from "@/cli/shepherd-tools.js";
import { JsonLineDecoder } from "@/gateway/json-lines.js";

describe("shepherd-tools", () => {
  test("parses stdio helper arguments", () => {
    expect(parseShepherdToolsArgs([])).toEqual({ command: "serve" });
    expect(parseShepherdToolsArgs(["serve"])).toEqual({ command: "serve" });
    expect(parseShepherdToolsArgs(["--help"])).toEqual({ command: "help" });
    expect(parseShepherdToolsArgs(["help"])).toEqual({ command: "help" });
    expect(parseShepherdToolsArgs(["-h"])).toEqual({ command: "help" });
    expect(() => parseShepherdToolsArgs(["--socket", "/tmp/shepherd.sock"])).toThrow(
      "Unknown argument: --socket",
    );
    expect(shepherdToolsHelpText()).toContain("shepherd-tools [serve]");
    expect(shepherdToolsHelpText()).toContain("tool.run");
    expect(shepherdToolsHelpText()).not.toContain("--socket");
  });

  test("handles tool list and run requests", async () => {
    const client = fakeClient();

    await expect(handleShepherdToolsRequest(client, { method: "tool.list" })).resolves.toEqual({
      tools: [{ description: "Echo a message", inputSchema: {}, name: "echo" }],
    });
    await expect(
      handleShepherdToolsRequest(client, {
        method: "tool.run",
        params: { input: { text: "hello" }, name: "echo", sessionId: "session-1" },
      }),
    ).resolves.toEqual({ output: { echoed: "hello" } });
  });

  test("bridges JSON Lines stdio frames to the Shepherd gateway client", async () => {
    const writes: string[] = [];
    await runShepherdToolsStdio({
      client: fakeClient(),
      input: Readable.from([
        `${JSON.stringify({ id: "1", method: "tool.list" })}\n`,
        `${JSON.stringify({
          id: "2",
          method: "tool.run",
          params: { input: { text: "hello" }, name: "echo", sessionId: "session-1" },
        })}\n`,
        "{not-json}\n",
      ]),
      output: {
        write(chunk: string) {
          writes.push(chunk);
          return true;
        },
      },
    });

    const decoder = new JsonLineDecoder();
    const messages = writes.flatMap((write) => decoder.push(write));

    expect(messages).toEqual([
      {
        id: "1",
        result: {
          tools: [{ description: "Echo a message", inputSchema: {}, name: "echo" }],
        },
      },
      {
        id: "2",
        result: { output: { echoed: "hello" } },
      },
      {
        error: { message: expect.stringContaining("JSON") },
        id: null,
      },
    ]);
  });
});

function fakeClient(): ShepherdToolsClient {
  return {
    async close() {},
    async listTools() {
      return { tools: [{ description: "Echo a message", inputSchema: {}, name: "echo" }] };
    },
    async runTool(input) {
      return { output: { echoed: (input.input as { text: string }).text } };
    },
  };
}
