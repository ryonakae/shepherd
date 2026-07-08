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

  test("uses current pane and wait socket methods for terminal control", async () => {
    const { requests, socketPath } = await openFakeHerdrServer((socket, request) => {
      socket.write(encodeJsonLine({ id: request.id, result: { ok: true } }));
    });

    const client = new HerdrSocketClient({ socketPath });
    await client.splitPane({ direction: "right", pane_id: "w1:p1", ratio: 0.5 });
    await client.sendPaneInput({ pane_id: "w1:p2", text: "pnpm test" });
    await client.readPane({ lines: 20, pane_id: "w1:p2", source: "recent" });
    await client.waitForOutput({
      match: "done",
      pane_id: "w1:p2",
      source: "recent",
      timeout_ms: 1000,
    });
    await client.waitForEvent({ timeout_ms: 1000, workspace_id: "w1" });
    client.close();

    expect(requests).toMatchObject([
      { method: "pane.split" },
      { method: "pane.send_input", params: { pane_id: "w1:p2", text: "pnpm test" } },
      { method: "pane.read" },
      {
        method: "pane.wait_for_output",
        params: {
          match: { type: "substring", value: "done" },
          pane_id: "w1:p2",
          source: "recent",
          timeout_ms: 1000,
        },
      },
      { method: "events.wait" },
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
          method: "events.event",
          params: { event: { id: "evt-1", type: "pane.agent_status_changed" } },
        }),
      );
    });

    const client = new HerdrSocketClient({ socketPath });
    const controller = new AbortController();
    const iterator = client
      .subscribeEvents({ paneIds: ["w1:p1"], workspaceId: "w1" }, { signal: controller.signal })
      [Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { id: "evt-1", type: "pane.agent_status_changed" },
    });
    controller.abort();
    client.close();

    expect(requests[0]).toMatchObject({
      method: "events.subscribe",
      params: {
        subscriptions: expect.arrayContaining([
          { type: "workspace.updated" },
          { type: "pane.agent_status_changed", pane_id: "w1:p1" },
        ]),
      },
    });
  });

  test("uses list/get/focus socket methods for Herdr inspection", async () => {
    const { requests, socketPath } = await openFakeHerdrServer((socket, request) => {
      socket.write(encodeJsonLine({ id: request.id, result: { ok: true } }));
    });

    const client = new HerdrSocketClient({ socketPath });
    await client.listWorkspaces();
    await client.getWorkspace({ workspace_id: "w1" });
    await client.focusWorkspace({ workspace_id: "w1" });
    await client.listTabs({ workspace_id: "w1" });
    await client.getTab({ tab_id: "w1:t1" });
    await client.listPanes({ tab_id: "w1:t1" });
    await client.getPane({ pane_id: "w1:p1" });
    await client.sendPaneInput({ pane_id: "w1:p1", text: "hello" });
    await client.listAgents({ workspace_id: "w1" });
    await client.getAgent({ target: "claude-impl" });
    await client.focusAgent({ target: "claude-impl" });
    client.close();

    expect(requests.map((request) => request.method)).toEqual([
      "workspace.list",
      "workspace.get",
      "workspace.focus",
      "tab.list",
      "tab.get",
      "pane.list",
      "pane.get",
      "pane.send_input",
      "agent.list",
      "agent.get",
      "agent.focus",
    ]);
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
