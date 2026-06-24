import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { encodeJsonLine, JsonLineDecoder } from "@/daemon/json-lines.js";
import { HerdrSocketClient } from "@/herdr/socket-client.js";

const tempDirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("HerdrSocketClient", () => {
  test("sends newline-delimited Herdr socket requests", async () => {
    const { requests, socketPath } = await openFakeHerdrServer((socket, request) => {
      socket.write(encodeJsonLine({ id: request.id, result: { type: "workspace_created" } }));
    });

    const client = new HerdrSocketClient({ socketPath });
    const result = await client.createWorkspace({ cwd: "/repo", label: "api" });
    client.close();

    expect(result).toEqual({ type: "workspace_created" });
    expect(requests).toEqual([
      {
        id: "shepherd-1",
        method: "workspace.create",
        params: { cwd: "/repo", label: "api" },
      },
    ]);
  });

  test("uses agent.send for agent messages", async () => {
    const { requests, socketPath } = await openFakeHerdrServer((socket, request) => {
      socket.write(encodeJsonLine({ id: request.id, result: { type: "agent_input_sent" } }));
    });

    const client = new HerdrSocketClient({ socketPath });
    await client.sendAgentMessage({ target: "w1:p1", text: "please review" });
    client.close();

    expect(requests[0]).toMatchObject({
      method: "agent.send",
      params: {
        target: "w1:p1",
        text: "please review",
      },
    });
  });

  test("uses agent.read for agent output", async () => {
    const { requests, socketPath } = await openFakeHerdrServer((socket, request) => {
      socket.write(encodeJsonLine({ id: request.id, result: { text: "done" } }));
    });

    const client = new HerdrSocketClient({ socketPath });
    await client.readAgent({ lines: 40, source: "recent", target: "w1:p1" });
    client.close();

    expect(requests[0]).toMatchObject({
      method: "agent.read",
      params: {
        lines: 40,
        source: "recent",
        target: "w1:p1",
      },
    });
  });
});

async function openFakeHerdrServer(
  onRequest: (socket: Socket, request: Record<string, unknown>) => void,
): Promise<{ requests: Record<string, unknown>[]; socketPath: string }> {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-herdr-"));
  tempDirs.push(dir);
  const socketPath = join(dir, "herdr.sock");
  if (existsSync(socketPath)) {
    unlinkSync(socketPath);
  }

  const requests: Record<string, unknown>[] = [];
  const server = createServer((socket) => {
    const decoder = new JsonLineDecoder();
    socket.on("data", (chunk) => {
      for (const message of decoder.push(chunk.toString("utf8"))) {
        const request = message as Record<string, unknown>;
        requests.push(request);
        onRequest(socket, request);
      }
    });
  });
  servers.push(server);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return { requests, socketPath };
}
