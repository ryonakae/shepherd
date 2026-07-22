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

const piSessionRef = {
  agent: "pi",
  kind: "path" as const,
  source: "herdr:pi",
  value: "/tmp/pi-session.jsonl",
};

const claudeSessionRef = {
  agent: "claude",
  kind: "id" as const,
  source: "herdr:claude",
  value: "session-1",
};

function replacePiAgent(
  agents: ReturnType<typeof openHarness>["agents"],
  input: {
    agent?: string;
    agentSession?: object | null;
    name?: string | null;
    paneId?: string;
    revision?: number;
    terminalId?: string;
  } = {},
) {
  return agents.replaceForSession({
    agents: [
      {
        agent: input.agent ?? "pi",
        agent_session: input.agentSession ?? null,
        agent_status: "working",
        ...(Object.hasOwn(input, "name") ? { name: input.name } : {}),
        pane_id: input.paneId ?? "wA:p1",
        revision: input.revision,
        terminal_id: input.terminalId ?? "term_1",
        workspace_id: "wA",
      },
    ],
    herdrSessionName: "default",
  })[0];
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

  test("maps pane revisions and preserves reported and Pi session refs by priority", () => {
    const { agents, sqlite } = openHarness();
    const initial = replacePiAgent(agents, { revision: 41 });
    if (!initial) throw new Error("Expected initial agent");
    expect(initial.paneRevision).toBe(41);
    expect(replacePiAgent(agents)?.paneRevision).toBeNull();

    expect(
      agents.setSessionRefByTerminal({
        agentSession: piSessionRef,
        herdrSessionName: "default",
        terminalId: "term_1",
      }),
    ).toMatchObject({ agentSession: piSessionRef, paneRevision: null });
    expect(
      sqlite
        .prepare("select agent_session_json, agent_session_hint_json from agents where id = ?")
        .get(initial.id),
    ).toEqual({ agent_session_json: null, agent_session_hint_json: JSON.stringify(piSessionRef) });

    expect(replacePiAgent(agents, { revision: 42 })?.agentSession).toEqual(piSessionRef);
    expect(
      replacePiAgent(agents, { agentSession: claudeSessionRef, revision: 43 })?.agentSession,
    ).toEqual(claudeSessionRef);
    expect(
      sqlite.prepare("select agent_session_hint_json from agents where id = ?").get(initial.id),
    ).toEqual({ agent_session_hint_json: JSON.stringify(piSessionRef) });
    expect(replacePiAgent(agents, { revision: 44 })?.agentSession).toEqual(piSessionRef);
  });

  test("rejects a Pi session hint for a terminal indexed as another agent", () => {
    const { agents, sqlite } = openHarness();
    const claude = replacePiAgent(agents, { agent: "claude" });
    if (!claude) throw new Error("Expected Claude agent");

    expect(
      agents.setSessionRefByTerminal({
        agentSession: piSessionRef,
        herdrSessionName: "default",
        terminalId: "term_1",
      }),
    ).toMatchObject({ agent: "claude", agentSession: null });
    expect(
      sqlite.prepare("select agent_session_hint_json from agents where id = ?").get(claude.id),
    ).toEqual({ agent_session_hint_json: null });
  });

  test("clears a Pi hint when the stable terminal changes agent", () => {
    const { agents } = openHarness();
    replacePiAgent(agents);
    agents.setSessionRefByTerminal({
      agentSession: piSessionRef,
      herdrSessionName: "default",
      terminalId: "term_1",
    });

    expect(replacePiAgent(agents, { agent: "claude", revision: 45 })).toMatchObject({
      agent: "claude",
      agentSession: null,
      paneRevision: 45,
    });
  });

  test("preserves identity and refs when a terminal moves panes", () => {
    const { agents } = openHarness();
    const initial = replacePiAgent(agents, { agentSession: piSessionRef, revision: 41 });
    agents.setSessionRefByTerminal({
      agentSession: piSessionRef,
      herdrSessionName: "default",
      terminalId: "term_1",
    });

    expect(
      replacePiAgent(agents, { agentSession: piSessionRef, paneId: "wB:p3", revision: 42 }),
    ).toMatchObject({
      agentSession: piSessionRef,
      id: initial?.id,
      paneId: "wB:p3",
      paneRevision: 42,
      terminalId: "term_1",
    });
  });

  test("does not reuse a pane occupant's identity, refs, hint, or snapshot", () => {
    const { agentContextSnapshots, agents } = openHarness();
    const initial = replacePiAgent(agents, { agentSession: piSessionRef, revision: 41 });
    if (!initial) throw new Error("Expected initial agent");
    agents.setSessionRefByTerminal({
      agentSession: piSessionRef,
      herdrSessionName: "default",
      terminalId: "term_1",
    });
    agentContextSnapshots.put({
      agentId: initial.id,
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
      paneRevision: 41,
      sourceFingerprint: null,
    });

    const replacement = replacePiAgent(agents, {
      agent: "claude",
      paneId: "wA:p1",
      revision: 1,
      terminalId: "term_2",
    });
    expect(replacement).toMatchObject({
      agent: "claude",
      agentSession: null,
      paneRevision: 1,
      terminalId: "term_2",
    });
    expect(replacement?.id).not.toBe(initial.id);
    expect(agentContextSnapshots.get(initial.id)).toBeUndefined();
  });

  test("keeps identity and refs when a live name changes or clears", () => {
    const { agents } = openHarness();
    const initial = replacePiAgent(agents, {
      agentSession: piSessionRef,
      name: "reviewer",
      revision: 41,
    });
    if (!initial) throw new Error("Expected initial agent");
    agents.setSessionRefByTerminal({
      agentSession: piSessionRef,
      herdrSessionName: "default",
      terminalId: "term_1",
    });

    expect(replacePiAgent(agents, { name: "implementer", revision: 42 })).toMatchObject({
      agent: "pi",
      agentSession: piSessionRef,
      id: initial.id,
      name: "implementer",
      terminalId: "term_1",
    });
    expect(replacePiAgent(agents, { name: null, revision: 43 })).toMatchObject({
      agentSession: piSessionRef,
      id: initial.id,
      name: null,
    });
  });

  test("does not create an agent for an unknown terminal hint", () => {
    const { agents } = openHarness();
    expect(
      agents.setSessionRefByTerminal({
        agentSession: piSessionRef,
        herdrSessionName: "default",
        terminalId: "unknown",
      }),
    ).toBeUndefined();
    expect(agents.listForHerdrSession("default")).toEqual([]);
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
