import { Value } from "@sinclair/typebox/value";
import { describe, expect, test } from "vitest";
import type {
  AgentContextSnapshotRecord,
  AgentEventRecord,
  AgentIndexRecord,
  AgentOrchestratorChanged,
  AgentWorkspaceContextSnapshot,
} from "@/observability/contracts.js";
import {
  agentGetInputSchema,
  agentListInputSchema,
  agentOrchestratorAckInputSchema,
  agentOrchestratorGetInputSchema,
  agentOrchestratorRegisterInputSchema,
  agentOrchestratorSetInputSchema,
  agentReadInputSchema,
} from "@/observability/schemas.js";

describe("agent observability contracts", () => {
  test("validates agent list scopes", () => {
    expect(Value.Check(agentListInputSchema, {})).toBe(true);
    expect(Value.Check(agentListInputSchema, { all: true })).toBe(true);
    expect(
      Value.Check(agentListInputSchema, { herdrSessionName: "default", workspaceId: "wB" }),
    ).toBe(true);
    expect(Value.Check(agentListInputSchema, { observedWorkspaceId: "ow_1" })).toBe(false);
  });

  test("validates agent get and read input", () => {
    expect(Value.Check(agentGetInputSchema, { target: "claude", workspaceId: "wB" })).toBe(true);
    expect(Value.Check(agentReadInputSchema, { limit: 10, target: "wB:p2" })).toBe(true);
    expect(Value.Check(agentReadInputSchema, { limit: 0, target: "wB:p2" })).toBe(false);
    expect(Value.Check(agentReadInputSchema, { limit: 501, target: "wB:p2" })).toBe(false);
  });

  test("validates orchestrator connection-bound RPC inputs", () => {
    const validPiRegistration = {
      herdrSocketPath: "/tmp/herdr.sock",
      paneId: "wB:p1",
      sessionRef: {
        agent: "pi",
        kind: "path",
        source: "herdr:pi",
        value: "/tmp/pi-session.jsonl",
      },
      subscriberId: "pi-session",
      subscriberKind: "pi",
      workspaceId: "wB",
    };
    expect(Value.Check(agentOrchestratorRegisterInputSchema, validPiRegistration)).toBe(true);
    expect(
      Value.Check(agentOrchestratorRegisterInputSchema, {
        ...validPiRegistration,
        sessionRef: { ...validPiRegistration.sessionRef, kind: "id" },
      }),
    ).toBe(false);
    expect(
      Value.Check(agentOrchestratorRegisterInputSchema, {
        ...validPiRegistration,
        sessionRef: { ...validPiRegistration.sessionRef, agent: "claude" },
      }),
    ).toBe(false);
    expect(
      Value.Check(agentOrchestratorRegisterInputSchema, {
        ...validPiRegistration,
        sessionRef: { ...validPiRegistration.sessionRef, value: "" },
      }),
    ).toBe(false);
    expect(
      Value.Check(agentOrchestratorRegisterInputSchema, {
        herdrSocketPath: "/tmp/herdr.sock",
        paneId: "wB:p1",
        subscriberId: "pi-session",
        subscriberKind: "pi",
        workspaceId: "wB",
      }),
    ).toBe(false);
    expect(
      Value.Check(agentOrchestratorRegisterInputSchema, {
        ...validPiRegistration,
        ["auto" + "Resume"]: true,
      }),
    ).toBe(false);
    expect(
      Value.Check(agentOrchestratorRegisterInputSchema, {
        ...validPiRegistration,
        subscriberKind: "claude",
      }),
    ).toBe(false);
    expect(
      Value.Check(agentOrchestratorRegisterInputSchema, {
        ["auto" + "Resume"]: true,
        herdrSocketPath: "/tmp/herdr.sock",
        paneId: "wB:p1",
        subscriberId: "pi-session-1",
        subscriberKind: "pi",
        workspaceId: "wB",
      }),
    ).toBe(false);
    expect(
      Value.Check(agentOrchestratorRegisterInputSchema, {
        herdrSocketPath: "/tmp/herdr.sock",
        paneId: "wB:p1",
        subscriberId: "pi-session-1",
        subscriberKind: "claude",
        workspaceId: "wB",
      }),
    ).toBe(false);
    expect(Value.Check(agentOrchestratorSetInputSchema, { enabled: true })).toBe(true);
    expect(Value.Check(agentOrchestratorSetInputSchema, { enabled: false })).toBe(true);
    expect(Value.Check(agentOrchestratorSetInputSchema, {})).toBe(false);
    expect(Value.Check(agentOrchestratorGetInputSchema, {})).toBe(true);
    expect(Value.Check(agentOrchestratorAckInputSchema, { eventId: 42 })).toBe(true);
    expect(
      Value.Check(agentOrchestratorAckInputSchema, {
        eventId: 42,
        unexpected: "legacy",
      }),
    ).toBe(false);
  });

  test("exposes final cached-context types", () => {
    const agent: AgentIndexRecord = {
      agent: "pi",
      agentSession: null,
      agentStatus: "working",
      cwd: "/workspace",
      firstSeenAt: new Date(),
      focused: true,
      foregroundCwd: "/workspace",
      herdrSessionName: "default",
      id: "ag_1",
      lastSeenAt: new Date(),
      paneId: "wB:p1",
      paneRevision: 42,
      tabId: null,
      terminalId: "term_1",
      workspaceId: "wB",
    };
    const snapshot: AgentContextSnapshotRecord = {
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
      updatedAt: new Date(),
    };
    const workspaceSnapshot: AgentWorkspaceContextSnapshot = {
      agents: [{ ...agent, history: snapshot.compactHistory }],
      herdrSessionName: "default",
      updatedAt: "2026-07-16T00:00:00.000Z",
      workspaceId: "wB",
    };
    expect(workspaceSnapshot.agents[0]?.paneRevision).toBe(42);
  });

  test("keeps terminal identity in orchestrator contracts", () => {
    const event: AgentEventRecord = {
      agentId: null,
      compactHistory: null,
      createdAt: new Date(),
      herdrSessionName: "default",
      id: 1,
      paneId: "wB:p1",
      payload: {},
      terminalId: "term_1",
      type: "agent.done",
      workspaceId: "wB",
    };
    const change: AgentOrchestratorChanged = {
      current: {
        ackedEventId: 1,
        herdrSessionName: "default",
        owner: { paneId: "wB:p1", terminalId: "term_1" },
        updatedAt: "2026-07-10T00:00:00.000Z",
        workspaceId: "wB",
      },
      previous: {
        ackedEventId: 1,
        herdrSessionName: "default",
        owner: null,
        updatedAt: "2026-07-10T00:00:00.000Z",
        workspaceId: "wB",
      },
      reason: "claimed",
    };
    expect(event.terminalId).toBe("term_1");
    expect(change.current.updatedAt).toMatch(/Z$/);
  });
});
