import { describe, expect, test } from "vitest";
import { helpText, parseCliArgs, runCliCommand } from "@/cli/shepherd.js";

const CURRENT_HERDR_CONTEXT_ERROR =
  "--current requires HERDR_ENV=1, HERDR_SOCKET_PATH, and HERDR_WORKSPACE_ID. Run it inside a Herdr-managed pane or plugin command.";

describe("Shepherd CLI", () => {
  test("parses observed workspace commands", () => {
    expect(parseCliArgs(["daemon"])).toEqual({ action: "status", command: "daemon" });
    expect(parseCliArgs(["daemon", "start"])).toEqual({ action: "start", command: "daemon" });
    expect(
      parseCliArgs(["observe", "--herdr-session", "main", "--workspace", "w1", "--json"]),
    ).toEqual({
      command: "observe",
      current: false,
      herdrSessionName: "main",
      json: true,
      workspaceId: "w1",
    });
    expect(
      parseCliArgs(["observe", "--current", "--json"], {
        HERDR_ENV: "1",
        HERDR_SOCKET_PATH: "/tmp/herdr.sock",
        HERDR_WORKSPACE_ID: "w1",
      }),
    ).toEqual({
      command: "observe",
      current: true,
      json: true,
      socketPath: "/tmp/herdr.sock",
      workspaceId: "w1",
    });
    expect(
      parseCliArgs(["context", "--json"], {
        HERDR_ENV: "1",
        HERDR_SOCKET_PATH: "/tmp/herdr.sock",
        HERDR_WORKSPACE_ID: "w1",
      }),
    ).toEqual({
      command: "context",
      json: true,
      socketPath: "/tmp/herdr.sock",
      workspaceId: "w1",
    });
    expect(
      parseCliArgs(
        ["context", "--observed-workspace", "ow_1", "--subscriber", "shepherd-agent", "--json"],
        {},
      ),
    ).toEqual({
      command: "context",
      json: true,
      observedWorkspaceId: "ow_1",
      subscriberId: "shepherd-agent",
    });
    expect(parseCliArgs(["snapshot", "ow_123", "--json"])).toEqual({
      command: "snapshot",
      json: true,
      observedWorkspaceId: "ow_123",
    });
    expect(parseCliArgs(["events", "ow_123", "--after", "10", "--json"])).toEqual({
      command: "events",
      afterEventId: 10,
      json: true,
      observedWorkspaceId: "ow_123",
    });
    expect(parseCliArgs(["ack", "--subscription", "ns_1", "--event", "42", "--json"])).toEqual({
      command: "ack",
      eventId: 42,
      json: true,
      subscriptionId: "ns_1",
    });
  });

  test("rejects old commands and current context without Herdr env", () => {
    expect(() => parseCliArgs(["observe-current"], {})).toThrow("Unknown command: observe-current");
    expect(() => parseCliArgs(["observe", "--current"], {})).toThrow(CURRENT_HERDR_CONTEXT_ERROR);
    expect(() => parseCliArgs(["context"], {})).toThrow(CURRENT_HERDR_CONTEXT_ERROR);
    expect(() =>
      parseCliArgs(["observe", "--current", "--workspace", "w1"], {
        HERDR_ENV: "1",
        HERDR_SOCKET_PATH: "/tmp/herdr.sock",
        HERDR_WORKSPACE_ID: "w1",
      }),
    ).toThrow(
      "observe --current cannot be combined with --herdr-session, --socket, or --workspace",
    );
    for (const oldCommand of ["send", "open", "watch", "audit"]) {
      expect(() => parseCliArgs([oldCommand])).toThrow(`Unknown command: ${oldCommand}`);
    }
  });

  test("runs RPC commands", async () => {
    const calls: unknown[] = [];
    const output: string[] = [];
    const client = {
      close: () => calls.push(["close"]),
      request: async (method: string, params: unknown) => {
        calls.push([method, params]);
        return method === "worker.events"
          ? { events: [{ id: 11, type: "worker.completed" }] }
          : { ok: true };
      },
    };

    await runCliCommand(
      { command: "snapshot", json: true, observedWorkspaceId: "ow_123" },
      {
        connect: async () => client,
        output: (line) => output.push(line),
        socketPath: "/tmp/shepherd.sock",
      },
    );
    await runCliCommand(
      { command: "events", afterEventId: 10, json: true, observedWorkspaceId: "ow_123" },
      {
        connect: async () => client,
        output: (line) => output.push(line),
        socketPath: "/tmp/shepherd.sock",
      },
    );
    await runCliCommand(
      { command: "ack", eventId: 42, json: true, subscriptionId: "ns_1" },
      {
        connect: async () => client,
        output: (line) => output.push(line),
        socketPath: "/tmp/shepherd.sock",
      },
    );

    expect(calls).toEqual([
      ["workspace.snapshot", { observedWorkspaceId: "ow_123" }],
      ["close"],
      ["worker.events", { afterEventId: 10, observedWorkspaceId: "ow_123" }],
      ["close"],
      ["notification.ack", { eventId: 42, subscriptionId: "ns_1" }],
      ["close"],
    ]);
    expect(output).toHaveLength(3);
  });

  test("composes current context JSON from daemon RPC", async () => {
    const calls: unknown[] = [];
    const output: string[] = [];
    const client = createContextClient(calls);

    await runCliCommand(
      { command: "context", json: true, socketPath: "/tmp/herdr.sock", workspaceId: "w1" },
      {
        connect: async () => client,
        output: (line) => output.push(line),
        socketPath: "/tmp/shepherd.sock",
      },
    );

    expect(calls).toEqual([
      ["workspace.observe", { socketPath: "/tmp/herdr.sock", workspaceId: "w1" }],
      ["workspace.snapshot", { observedWorkspaceId: "ow_1" }],
      ["close"],
    ]);
    expect(JSON.parse(output[0] ?? "")).toEqual({
      observedWorkspace: { id: "ow_1", liveWorkspaceId: "w1", status: "active" },
      workers: [
        {
          id: "wk_1",
          status: "done",
          agent: "pi",
          summary: "completed",
          recommendedAction: "review",
        },
      ],
      notifications: { subscription: null, events: [] },
    });
  });

  test("composes known observed workspace context with notifications", async () => {
    const calls: unknown[] = [];
    const output: string[] = [];
    const client = createContextClient(calls);

    await runCliCommand(
      {
        command: "context",
        json: true,
        observedWorkspaceId: "ow_1",
        subscriberId: "shepherd-agent",
      },
      {
        connect: async () => client,
        output: (line) => output.push(line),
        socketPath: "/tmp/shepherd.sock",
      },
    );

    expect(calls).toEqual([
      ["workspace.snapshot", { observedWorkspaceId: "ow_1" }],
      [
        "notification.subscribe",
        {
          autoResume: false,
          observedWorkspaceId: "ow_1",
          subscriberId: "shepherd-agent",
          subscriberKind: "cli",
        },
      ],
      ["close"],
    ]);
    expect(JSON.parse(output[0] ?? "")).toEqual({
      observedWorkspace: { id: "ow_1" },
      workers: [
        {
          id: "wk_1",
          status: "done",
          agent: "pi",
          summary: "completed",
          recommendedAction: "review",
        },
      ],
      notifications: {
        subscription: { id: "ns_1" },
        events: [{ id: 7, type: "worker.completed" }],
      },
    });
  });

  test("renders context as a human table", async () => {
    const calls: unknown[] = [];
    const output: string[] = [];
    const client = createContextClient(calls);

    await runCliCommand(
      { command: "context", json: false, observedWorkspaceId: "ow_1" },
      {
        connect: async () => client,
        output: (line) => output.push(line),
        socketPath: "/tmp/shepherd.sock",
      },
    );

    expect(output).toEqual([
      "Observed workspace: ow_1\nWorkers: 1\nNotifications: 0\n\nstatus\tagent\tworker\tsummary\taction\ndone\tpi\twk_1\tcompleted\treview",
    ]);
  });

  test("renders help", () => {
    expect(helpText()).toContain(
      "shepherd observe --herdr-session <name> --workspace <workspace-id>",
    );
    expect(helpText()).toContain("shepherd observe --current [--json]");
    expect(helpText()).toContain(
      "shepherd context [--observed-workspace <id>] [--subscriber <id>] [--json]",
    );
    expect(helpText()).not.toContain("shepherd observe-current");
    expect(helpText()).not.toContain("shepherd send");
  });
});

function createContextClient(calls: unknown[]) {
  return {
    close: () => calls.push(["close"]),
    request: async (method: string, params: unknown) => {
      calls.push([method, params]);
      if (method === "workspace.observe") {
        return { observedWorkspace: { id: "ow_1", liveWorkspaceId: "w1", status: "active" } };
      }
      if (method === "workspace.snapshot") {
        return {
          workers: [
            {
              id: "wk_1",
              status: "done",
              agent: "pi",
              summary: "completed",
              recommendedAction: "review",
            },
          ],
        };
      }
      if (method === "notification.subscribe") {
        return { events: [{ id: 7, type: "worker.completed" }], subscription: { id: "ns_1" } };
      }
      return {};
    },
  };
}
