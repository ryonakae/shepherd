import { afterEach, describe, expect, test } from "vitest";
import type { AgentHistoryService } from "@/agent-history/service.js";
import { emptyCompactHistory } from "@/agent-history/service.js";
import { AgentIndexService } from "@/observability/agent-index-service.js";
import type { AgentEventRecord } from "@/observability/contracts.js";
import { cleanupTempDirs, openObservabilityDbHarness } from "./observability-db-harness.js";

afterEach(cleanupTempDirs);

describe("AgentIndexService", () => {
  test("emits one terminal status event when a refreshed snapshot observes a missed transition", async () => {
    const harness = openObservabilityDbHarness();
    const emitted: AgentEventRecord[] = [];
    let status = "working";
    const index = new AgentIndexService({
      clientFactory: () => ({
        close() {},
        async sessionSnapshot() {
          return snapshot(status);
        },
      }),
      history: {
        async getCompactHistory() {
          return emptyCompactHistory("claude-jsonl");
        },
      } as unknown as AgentHistoryService,
      stores: harness,
    });
    const refresh = () =>
      index.refreshHerdrSession({
        herdrSessionName: "default",
        onAgentEvent: (event) => emitted.push(event),
        sessionDir: "/tmp/herdr",
        socketPath: "/tmp/herdr.sock",
      });

    await refresh();
    status = "idle";
    await refresh();
    await refresh();

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      paneId: "wJ:p2",
      terminalId: "term_claude",
      type: "agent.idle",
      workspaceId: "wJ",
    });
    expect(
      harness.agentEvents.listAfter({ herdrSessionName: "default", workspaceId: "wJ" }),
    ).toEqual([
      expect.objectContaining({ type: "agent.status.changed" }),
      expect.objectContaining({ type: "agent.idle" }),
    ]);
    harness.sqlite.close();
  });
});

function snapshot(agentStatus: string) {
  return {
    snapshot: {
      agents: [
        {
          agent: "claude",
          agent_status: agentStatus,
          cwd: "/repo",
          focused: false,
          foreground_cwd: "/repo",
          pane_id: "wJ:p2",
          tab_id: "wJ:t1",
          terminal_id: "term_claude",
          workspace_id: "wJ",
        },
      ],
      panes: [],
      tabs: [],
      workspaces: [
        {
          agent_status: agentStatus,
          focused: true,
          label: "repo",
          workspace_id: "wJ",
        },
      ],
    },
  };
}
