import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import type { LanguageModel, ModelMessage, ToolSet } from "ai";
import { afterEach, describe, expect, test } from "vitest";
import { applyMigrations } from "@/db/apply-migrations.js";
import { openSqlite } from "@/db/client.js";
import { EventStore } from "@/db/event-store.js";
import { AiSdkGatewayProvider, createAiSdkTools } from "@/gateway/ai-sdk-provider.js";
import { LogicalToolRegistry, LogicalToolRunner } from "@/gateway/tools.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("createAiSdkTools", () => {
  test("adapts logical tools to AI SDK executable tools", async () => {
    const { events, registry, sessionId, tools } = openGatewayHarness();

    registry.register({
      description: "Echo a value",
      execute: (input: { value: string }) => ({ echoed: input.value }),
      inputSchema: Type.Object({ value: Type.String() }),
      name: "echo",
    });

    const aiTools = createAiSdkTools({
      context: { sessionId },
      tools,
    });

    await expect(executeAiTool(aiTools, "echo", { value: "hello" })).resolves.toEqual({
      echoed: "hello",
    });
    expect(events.listEvents(sessionId).map((event) => event.type)).toEqual([
      "gateway.tool.call",
      "gateway.tool.result",
    ]);
  });
});

describe("AiSdkGatewayProvider", () => {
  test("calls generateText with messages, tools, and provider options", async () => {
    const { registry, sessionId, tools } = openGatewayHarness();
    const calls: Array<{
      messages: ModelMessage[];
      providerOptions: Record<string, unknown> | undefined;
      system: string | undefined;
      tools: ToolSet | undefined;
    }> = [];
    registry.register({
      description: "Read session state",
      execute: () => ({ ok: true }),
      inputSchema: Type.Object({}),
      name: "session_read",
    });
    const provider = new AiSdkGatewayProvider({
      generateText: async (options) => {
        calls.push({
          messages: options.messages,
          providerOptions: options.providerOptions,
          system: options.system,
          tools: options.tools,
        });
        await executeAiTool(options.tools ?? {}, "session_read", {});
        return { text: "Done." };
      },
      maxSteps: 4,
      model: "test-model" as unknown as LanguageModel,
      providerOptions: { "codex-app-server": { threadMode: "persistent" } },
      system: "You are Shepherd gateway.",
    });

    await expect(
      provider.generate({
        messages: [{ content: "please check", role: "user" }],
        sessionId,
        tools,
      }),
    ).resolves.toEqual({ text: "Done." });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.messages).toEqual([{ content: "please check", role: "user" }]);
    expect(calls[0]?.providerOptions).toEqual({
      "codex-app-server": { threadMode: "persistent" },
    });
    expect(calls[0]?.system).toBe("You are Shepherd gateway.");
    expect(calls[0]?.tools).toHaveProperty("session_read");
  });
});

function executeAiTool(tools: ToolSet, name: string, input: unknown): Promise<unknown> {
  const candidate = tools[name] as { execute?: (input: unknown) => Promise<unknown> } | undefined;
  if (!candidate?.execute) {
    throw new Error(`Missing AI SDK tool: ${name}`);
  }

  return candidate.execute(input);
}

function openGatewayHarness(): {
  events: EventStore;
  registry: LogicalToolRegistry;
  sessionId: string;
  tools: LogicalToolRunner;
} {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-ai-sdk-"));
  tempDirs.push(dir);

  const { sqlite } = openSqlite(join(dir, "test.sqlite"));
  applyMigrations(sqlite, { migrationsFolder: "drizzle" });
  const events = new EventStore(sqlite);
  const session = events.createSession({ id: "session-1" });
  const registry = new LogicalToolRegistry();
  const tools = new LogicalToolRunner({
    events,
    policy: { allowedTools: new Set(["echo", "session_read"]) },
    registry,
  });

  return { events, registry, sessionId: session.id, tools };
}
