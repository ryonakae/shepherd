#!/usr/bin/env node
import { resolve } from "node:path";
import { argv, exit, stdin, stdout } from "node:process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { resolveRuntime } from "@/config/runtime.js";
import { encodeJsonLine } from "@/gateway/json-lines.js";
import { ShepherdSessionClient } from "@/tui/client.js";

export type ShepherdToolsCommand = { command: "serve" } | { command: "help" };

export type ShepherdToolsJsonRpcRequest = {
  id?: string | number | null;
  method?: string;
  params?: unknown;
};

export type ShepherdToolsClient = Pick<ShepherdSessionClient, "close" | "listTools" | "runTool">;

export function parseShepherdToolsArgs(args: string[]): ShepherdToolsCommand {
  const [first, ...rest] = args;
  if (first === "--help" || first === "-h" || first === "help") {
    if (rest.length > 0) {
      throw new Error(`Unknown argument: ${rest[0]}`);
    }
    return { command: "help" };
  }

  if (!first || first === "serve") {
    if (rest.length > 0) {
      throw new Error(`Unknown argument: ${rest[0]}`);
    }
    return { command: "serve" };
  }

  if (first.startsWith("--")) {
    throw new Error(`Unknown argument: ${first}`);
  }

  throw new Error(`Unknown command: ${first}`);
}

export function shepherdToolsHelpText(): string {
  return `Usage:
  shepherd-tools [serve]

Protocol:
  Send newline-delimited JSON-RPC frames on stdin and read responses from stdout.
  Supported methods: tool.list, tool.run
`;
}

export async function handleShepherdToolsRequest(
  client: ShepherdToolsClient,
  request: ShepherdToolsJsonRpcRequest,
): Promise<unknown> {
  if (request.method === "tool.list") {
    return client.listTools();
  }

  if (request.method === "tool.run") {
    const params = request.params as { input?: unknown; name?: string; sessionId?: string };
    if (!params?.sessionId || !params.name) {
      throw new Error("tool.run requires sessionId and name");
    }

    return client.runTool({
      name: params.name,
      sessionId: params.sessionId,
      ...(params.input !== undefined ? { input: params.input } : {}),
    });
  }

  throw new Error(`Unknown method: ${String(request.method)}`);
}

export async function runShepherdToolsStdio(options: {
  client: ShepherdToolsClient;
  input: NodeJS.ReadableStream;
  output: Pick<NodeJS.WritableStream, "write">;
}): Promise<void> {
  const lines = createInterface({ crlfDelay: Number.POSITIVE_INFINITY, input: options.input });

  for await (const line of lines) {
    if (line.trim().length === 0) {
      continue;
    }

    let responseId: string | number | null = null;
    try {
      const request = JSON.parse(line) as ShepherdToolsJsonRpcRequest;
      responseId = request.id ?? null;
      const result = await handleShepherdToolsRequest(options.client, request);
      options.output.write(encodeJsonLine({ id: responseId, result }));
    } catch (error) {
      options.output.write(
        encodeJsonLine({
          error: { message: error instanceof Error ? error.message : String(error) },
          id: responseId,
        }),
      );
    }
  }
}

async function main(): Promise<void> {
  const command = parseShepherdToolsArgs(argv.slice(2));
  if (command.command === "help") {
    console.log(shepherdToolsHelpText());
    return;
  }

  const runtime = resolveRuntime();
  const client = await ShepherdSessionClient.connect(runtime.paths.socketPath);
  try {
    await runShepherdToolsStdio({ client, input: stdin, output: stdout });
  } finally {
    await client.close();
  }
}

if (fileURLToPath(import.meta.url) === resolve(argv[1] ?? "")) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    exit(1);
  });
}
