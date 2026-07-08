import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ManagedHerdrSocketClient } from "@/herdr/managed-socket-client.js";
import type { HerdrSessionLifecycle } from "@/herdr/session-lifecycle.js";
import { encodeJsonLine, JsonLineDecoder } from "@/shared/json-lines.js";

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

describe("ManagedHerdrSocketClient", () => {
  test("delegates session snapshots through the managed socket", async () => {
    const sessionSnapshot = {
      type: "session_snapshot",
      snapshot: {
        agents: [{ agent: "pi", pane_id: "w1:p1", workspace_id: "w1" }],
        focused_pane_id: "w1:p1",
        focused_workspace_id: "w1",
        panes: [{ focused: true, pane_id: "w1:p1", workspace_id: "w1" }],
        tabs: [{ focused: true, tab_id: "w1:t1", workspace_id: "w1" }],
        workspaces: [{ focused: true, workspace_id: "w1" }],
      },
    };
    const { requests, socketPath } = await openFakeHerdrServer((socket, request) => {
      socket.write(encodeJsonLine({ id: request.id, result: sessionSnapshot }));
    });
    const client = new ManagedHerdrSocketClient({
      herdrSessionName: "shepherd-api",
      lifecycle: {
        async ensureNamedSession() {
          return { socketPath, started: false };
        },
      } as unknown as HerdrSessionLifecycle,
    });

    await expect(client.sessionSnapshot()).resolves.toEqual(sessionSnapshot);
    client.close();

    expect(requests.map((request) => request.method)).toEqual(["session.snapshot"]);
  });

  test("ensures the named session before sending socket requests", async () => {
    const { requests, socketPath } = await openFakeHerdrServer((socket, request) => {
      socket.write(encodeJsonLine({ id: request.id, result: { workspace_id: "w1" } }));
    });
    const ensured: string[] = [];
    const client = new ManagedHerdrSocketClient({
      herdrSessionName: "shepherd-api",
      lifecycle: {
        async ensureNamedSession(name: string) {
          ensured.push(name);
          return { socketPath, started: false };
        },
      } as unknown as HerdrSessionLifecycle,
    });

    await expect(client.createWorkspace({ cwd: "/repo", label: "api" })).resolves.toEqual({
      workspace_id: "w1",
    });
    client.close();

    expect(ensured).toEqual(["shepherd-api"]);
    expect(requests).toEqual([
      {
        id: "shepherd-1",
        method: "workspace.create",
        params: { cwd: "/repo", label: "api" },
      },
    ]);
  });
});

async function openFakeHerdrServer(
  onRequest: (socket: Socket, request: Record<string, unknown>) => void,
): Promise<{ requests: Record<string, unknown>[]; socketPath: string }> {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-managed-herdr-"));
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
