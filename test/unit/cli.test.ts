import { describe, expect, test } from "vitest";
import { helpText, parseCliArgs, runCliCommand } from "@/cli/shepherd.js";

describe("Shepherd CLI", () => {
  test("parses observed workspace commands", () => {
    expect(parseCliArgs(["daemon"])).toEqual({ action: "status", command: "daemon" });
    expect(parseCliArgs(["daemon", "start"])).toEqual({ action: "start", command: "daemon" });
    expect(
      parseCliArgs(["observe", "--herdr-session", "main", "--workspace", "w1", "--json"]),
    ).toEqual({
      command: "observe",
      herdrSessionName: "main",
      json: true,
      workspaceId: "w1",
    });
    expect(
      parseCliArgs(["observe-current", "--json"], {
        HERDR_ENV: "1",
        HERDR_SOCKET_PATH: "/tmp/herdr.sock",
        HERDR_WORKSPACE_ID: "w1",
      }),
    ).toEqual({
      command: "observe-current",
      json: true,
      socketPath: "/tmp/herdr.sock",
      workspaceId: "w1",
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

  test("rejects observe-current outside Herdr and old commands", () => {
    expect(() => parseCliArgs(["observe-current"], {})).toThrow(
      "observe-current requires a Herdr-managed pane",
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

  test("renders help", () => {
    expect(helpText()).toContain(
      "shepherd observe --herdr-session <name> --workspace <workspace-id>",
    );
    expect(helpText()).toContain("shepherd observe-current [--json]");
    expect(helpText()).not.toContain("shepherd send");
  });
});
