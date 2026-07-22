import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { HerdrSocketClient } from "@/herdr/socket-client.js";
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

describe("HerdrSocketClient", () => {
  test("gets pane metadata over the persistent Herdr socket", async () => {
    const { requests, socketPath } = await openFakeHerdrServer((socket, request) => {
      socket.write(
        encodeJsonLine({
          id: request.id,
          result: { pane: { pane_id: "w1:p2", terminal_id: "term_2" } },
        }),
      );
    });

    const client = new HerdrSocketClient({ socketPath });
    await expect(client.getPane({ pane_id: "w1:p2" })).resolves.toEqual({
      pane: { pane_id: "w1:p2", terminal_id: "term_2" },
    });
    client.close();

    expect(requests).toEqual([
      {
        id: "shepherd-1",
        method: "pane.get",
        params: { pane_id: "w1:p2" },
      },
    ]);
  });

  test("uses Herdr session snapshots when available", async () => {
    const sessionSnapshot = {
      type: "session_snapshot",
      snapshot: {
        agents: [{ agent: "pi", pane_id: "w1:p1", workspace_id: "w1" }],
        focused_pane_id: "w1:p1",
        focused_tab_id: "w1:t1",
        focused_workspace_id: "w1",
        layouts: [{ focused_pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1" }],
        panes: [{ focused: true, pane_id: "w1:p1", workspace_id: "w1" }],
        protocol: 16,
        tabs: [{ focused: true, tab_id: "w1:t1", workspace_id: "w1" }],
        version: "0.7.2",
        workspaces: [{ focused: true, label: "Repo", workspace_id: "w1" }],
      },
    };
    const { requests, socketPath } = await openFakeHerdrServer((socket, request) => {
      socket.write(encodeJsonLine({ id: request.id, result: sessionSnapshot }));
    });

    const client = new HerdrSocketClient({ socketPath });
    await expect(client.sessionSnapshot()).resolves.toEqual(sessionSnapshot);
    client.close();

    expect(requests.map((request) => request.method)).toEqual(["session.snapshot"]);
  });

  test("falls back to list APIs when Herdr session snapshots are unavailable", async () => {
    const { requests, socketPath } = await openFakeHerdrServer((socket, request) => {
      if (request.method === "session.snapshot") {
        socket.write(
          encodeJsonLine({
            error: {
              code: "invalid_request",
              message: "invalid request: unknown variant `session.snapshot`",
            },
            id: "",
          }),
        );
        return;
      }
      if (request.method === "workspace.list") {
        socket.write(
          encodeJsonLine({
            id: request.id,
            result: {
              type: "workspace_list",
              workspaces: [{ focused: true, label: "Repo", workspace_id: "w1" }],
            },
          }),
        );
        return;
      }
      if (request.method === "pane.list") {
        socket.write(
          encodeJsonLine({
            id: request.id,
            result: { panes: [{ focused: true, pane_id: "w1:p1", workspace_id: "w1" }] },
          }),
        );
        return;
      }
      if (request.method === "tab.list") {
        socket.write(
          encodeJsonLine({
            id: request.id,
            result: { tabs: [{ focused: true, tab_id: "w1:t1", workspace_id: "w1" }] },
          }),
        );
        return;
      }
      if (request.method === "agent.list") {
        socket.write(
          encodeJsonLine({
            id: request.id,
            result: { agents: [{ agent: "Pi", pane_id: "w1:p1", status: "working" }] },
          }),
        );
        return;
      }
      socket.write(encodeJsonLine({ id: request.id, result: {} }));
    });

    const client = new HerdrSocketClient({ socketPath });
    await expect(client.sessionSnapshot()).resolves.toEqual({
      snapshot: {
        agents: [{ agent: "Pi", pane_id: "w1:p1", status: "working" }],
        focused_pane_id: "w1:p1",
        focused_workspace_id: "w1",
        panes: [{ focused: true, pane_id: "w1:p1", workspace_id: "w1" }],
        tabs: [{ focused: true, tab_id: "w1:t1", workspace_id: "w1" }],
        workspaces: [{ focused: true, label: "Repo", workspace_id: "w1" }],
      },
    });
    client.close();

    expect(requests.map((request) => request.method)).toEqual([
      "session.snapshot",
      "workspace.list",
      "pane.list",
      "tab.list",
      "agent.list",
    ]);
  });

  test("subscribes to Herdr events and yields socket notifications", async () => {
    const { requests, socketPath } = await openFakeHerdrServer((socket, request) => {
      socket.write(encodeJsonLine({ id: request.id, result: { subscribed: true } }));
      socket.write(
        encodeJsonLine({
          data: { agent_status: "idle", pane_id: "w1:p1", workspace_id: "w1" },
          event: "pane.agent_status_changed",
        }),
      );
      socket.write(
        encodeJsonLine({
          data: { pane_id: "w1:p2", workspace_id: "w1" },
          event: "pane_created",
        }),
      );
    });

    const client = new HerdrSocketClient({ socketPath });
    const controller = new AbortController();
    const iterator = client
      .subscribeEvents({ paneIds: ["w1:p1"] }, { signal: controller.signal })
      [Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: {
        agent_status: "idle",
        pane_id: "w1:p1",
        type: "pane.agent_status_changed",
        workspace_id: "w1",
      },
    });
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { pane_id: "w1:p2", type: "pane.created", workspace_id: "w1" },
    });
    controller.abort();
    client.close();

    expect(requests[0]).toMatchObject({
      method: "events.subscribe",
      params: {
        subscriptions: [{ type: "pane.agent_status_changed", pane_id: "w1:p1" }],
      },
    });
  });

  test("rejects the event stream when the Herdr socket closes", async () => {
    const { socketPath } = await openFakeHerdrServer((socket, request) => {
      socket.end(encodeJsonLine({ id: request.id, result: { subscribed: true } }));
    });

    const client = new HerdrSocketClient({ socketPath });
    const iterator = client.subscribeEvents()[Symbol.asyncIterator]();
    const nextEvent = Promise.race([
      iterator.next(),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("event stream did not close")), 100);
      }),
    ]);

    await expect(nextEvent).rejects.toThrow("Herdr socket closed");
    client.close();
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
