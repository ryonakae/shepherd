import { afterEach, describe, expect, test } from "vitest";
import { cleanupTempDirs, openObservabilityDbHarness } from "./observability-db-harness.js";

afterEach(cleanupTempDirs);

function openHarness() {
  const harness = openObservabilityDbHarness();
  harness.herdrSessions.upsertRunning({
    name: "default",
    sessionDir: "/tmp/herdr",
    socketPath: "/tmp/herdr.sock",
  });
  return harness;
}

describe("AgentStore terminal identity", () => {
  test("keeps an agent id when its stable terminal moves to a new pane and workspace", () => {
    const { agents } = openHarness();
    agents.replaceForSession({
      agents: [
        {
          agent: "pi",
          agent_status: "working",
          pane_id: "wA:p1",
          terminal_id: "term_1",
          workspace_id: "wA",
        },
      ],
      herdrSessionName: "default",
    });
    const originalId = agents.findByPane({ herdrSessionName: "default", paneId: "wA:p1" })?.id;

    agents.replaceForSession({
      agents: [
        {
          agent: "pi",
          agent_status: "working",
          pane_id: "wB:p3",
          terminal_id: "term_1",
          workspace_id: "wB",
        },
      ],
      herdrSessionName: "default",
    });

    expect(
      agents.findByTerminal({ herdrSessionName: "default", terminalId: "term_1" }),
    ).toMatchObject({
      id: originalId,
      paneId: "wB:p3",
      terminalId: "term_1",
      workspaceId: "wB",
    });
    expect(agents.findByPane({ herdrSessionName: "default", paneId: "wA:p1" })).toBeUndefined();
  });

  test("persists terminal identity for new events and maps migrated events as null", () => {
    const { agentEvents } = openHarness();
    const event = agentEvents.append({
      herdrSessionName: "default",
      payload: {},
      terminalId: "term_1",
      type: "agent.done",
      workspaceId: "wA",
    });

    expect(agentEvents.get(event.id).terminalId).toBe("term_1");
    const migrated = agentEvents.append({
      herdrSessionName: "default",
      payload: {},
      type: "agent.idle",
      workspaceId: "wA",
    });
    expect(agentEvents.get(migrated.id).terminalId).toBeNull();
  });
});
