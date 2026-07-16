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

function createAgent() {
  const harness = openHarness();
  const [agent] = harness.agents.replaceForSession({
    agents: [
      {
        agent: "claude",
        agent_status: "working",
        pane_id: "wB:p1",
        terminal_id: "term_1",
        workspace_id: "wB",
      },
    ],
    herdrSessionName: "default",
  });
  if (!agent) throw new Error("Expected indexed agent");
  return { agent, ...harness };
}

function snapshotInput(agentId: string) {
  const historyRef = {
    kind: "discovered_file" as const,
    path: "/tmp/claude.jsonl",
    source: "claude-jsonl" as const,
    value: "/tmp/claude.jsonl",
  };
  return {
    agentId,
    compactHistory: {
      historyRef,
      lastAssistantMessage: { ref: "entry-2", text: "done", timestamp: null },
      lastToolResult: null,
      lastUserMessage: { ref: "entry-1", text: "work", timestamp: null },
      messageCount: 2,
      source: "claude-jsonl",
      updatedAt: "2026-07-16T00:00:00.000Z",
    },
    historyRef,
    paneRevision: 42,
    sourceFingerprint: { mtimeMs: 100, path: "/tmp/claude.jsonl", size: 200 },
  };
}

describe("AgentContextSnapshotStore", () => {
  test("round-trips, upserts, lists, and cascades snapshots", () => {
    const { agent, agentContextSnapshots, agents, sqlite } = createAgent();
    expect(agentContextSnapshots.get(agent.id)).toBeUndefined();

    const input = snapshotInput(agent.id);
    const inserted = agentContextSnapshots.put(input);
    expect(inserted).toMatchObject(input);
    expect(inserted.updatedAt).toBeInstanceOf(Date);
    expect(agentContextSnapshots.get(agent.id)).toEqual(inserted);

    const updated = agentContextSnapshots.put({
      ...input,
      compactHistory: {
        ...input.compactHistory,
        lastAssistantMessage: { ref: "entry-3", text: "finished", timestamp: null },
      },
      paneRevision: 43,
      sourceFingerprint: { ...input.sourceFingerprint, mtimeMs: 101 },
    });
    expect(updated.compactHistory.lastAssistantMessage?.text).toBe("finished");
    expect(updated.paneRevision).toBe(43);
    expect(updated.sourceFingerprint?.mtimeMs).toBe(101);
    expect(sqlite.prepare("select count(*) as count from agent_context_snapshots").get()).toEqual({
      count: 1,
    });
    expect(agentContextSnapshots.listByAgentIds([agent.id, "unknown"])).toEqual([updated]);

    agents.replaceForSession({ agents: [], herdrSessionName: "default" });
    expect(agentContextSnapshots.get(agent.id)).toBeUndefined();
  });

  test("round-trips a snapshot without readable history", () => {
    const { agent, agentContextSnapshots } = createAgent();
    const snapshot = agentContextSnapshots.put({
      agentId: agent.id,
      compactHistory: {
        historyRef: null,
        lastAssistantMessage: null,
        lastToolResult: null,
        lastUserMessage: null,
        messageCount: 0,
        source: null,
        updatedAt: null,
      },
      historyRef: null,
      paneRevision: null,
      sourceFingerprint: null,
    });
    expect(snapshot.historyRef).toBeNull();
    expect(snapshot.sourceFingerprint).toBeNull();
    expect(snapshot.compactHistory.historyRef).toBeNull();
  });

  test("rejects partial history metadata", () => {
    const { agent, agentContextSnapshots } = createAgent();
    const input = snapshotInput(agent.id);
    expect(() => agentContextSnapshots.put({ ...input, sourceFingerprint: null })).toThrow(
      "Agent context history ref and source fingerprint must both be null or non-null",
    );
  });
});
