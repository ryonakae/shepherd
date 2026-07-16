import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { AgentHistoryService, ResolvedCompactAgentHistory } from "@/agent-history/service.js";
import { emptyCompactHistory } from "@/agent-history/service.js";
import { AgentContextService } from "@/observability/agent-context-service.js";
import type {
  AgentHistoryRef,
  AgentHistorySourceFingerprint,
  AgentIndexRecord,
  CompactAgentHistory,
} from "@/observability/contracts.js";
import { cleanupTempDirs, openObservabilityDbHarness } from "./observability-db-harness.js";

const sourceDirs: string[] = [];

afterEach(async () => {
  cleanupTempDirs();
  await Promise.all(sourceDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

async function source(
  name: string,
): Promise<{ fingerprint: AgentHistorySourceFingerprint; ref: AgentHistoryRef }> {
  const dir = await mkdtemp(join(tmpdir(), "shepherd-agent-context-"));
  sourceDirs.push(dir);
  const path = join(dir, name);
  await writeFile(path, "history\n");
  const info = await stat(path);
  return {
    fingerprint: { mtimeMs: Math.trunc(info.mtimeMs), path, size: info.size },
    ref: { kind: "discovered_file", path, source: "pi-jsonl", value: path },
  };
}

function history(ref: AgentHistoryRef | null, text = "done"): CompactAgentHistory {
  return {
    ...emptyCompactHistory(ref?.source ?? null),
    historyRef: ref,
    lastAssistantMessage: ref ? { ref: "entry", text, timestamp: null } : null,
  };
}

function resolved(
  historyRef: AgentHistoryRef | null,
  sourceFingerprint: AgentHistorySourceFingerprint | null,
  text = "done",
): ResolvedCompactAgentHistory {
  return { compactHistory: history(historyRef, text), historyRef, sourceFingerprint };
}

function openAgent(input: { agentSession?: unknown; revision?: number } = {}) {
  const harness = openObservabilityDbHarness();
  harness.herdrSessions.upsertRunning({
    name: "default",
    sessionDir: "/tmp/herdr",
    socketPath: "/tmp/herdr.sock",
  });
  const [agent] = harness.agents.replaceForSession({
    agents: [
      {
        agent: "pi",
        agent_session: input.agentSession,
        agent_status: "working",
        pane_id: "wB:p1",
        revision: input.revision ?? 1,
        terminal_id: "term_pi",
        workspace_id: "wB",
      },
    ],
    herdrSessionName: "default",
  });
  if (!agent) throw new Error("Expected agent");
  return { agent, ...harness };
}

function refreshAgent(
  harness: ReturnType<typeof openAgent>,
  input: { agentSession?: unknown; revision: number },
) {
  const [agent] = harness.agents.replaceForSession({
    agents: [
      {
        agent: "pi",
        agent_session: input.agentSession,
        agent_status: "working",
        pane_id: "wB:p1",
        revision: input.revision,
        terminal_id: "term_pi",
        workspace_id: "wB",
      },
    ],
    herdrSessionName: "default",
  });
  if (!agent) throw new Error("Expected refreshed agent");
  return agent;
}

function fakeHistory(result: ResolvedCompactAgentHistory) {
  const calls: Array<{ forceDiscovery?: boolean; preferredRef?: AgentHistoryRef | null }> = [];
  return {
    calls,
    service: {
      resolveCompactHistory: async (_input, options) => {
        calls.push(options ?? {});
        return result;
      },
    } as AgentHistoryService,
  };
}

function context(
  harness: ReturnType<typeof openAgent>,
  historyService: AgentHistoryService,
): AgentContextService {
  return new AgentContextService({
    history: historyService,
    stores: { agentContextSnapshots: harness.agentContextSnapshots, agents: harness.agents },
  });
}

function snapshotInput(agent: AgentIndexRecord, value: ResolvedCompactAgentHistory) {
  return {
    agentId: agent.id,
    compactHistory: value.compactHistory,
    historyRef: value.historyRef,
    paneRevision: agent.paneRevision,
    sourceFingerprint: value.sourceFingerprint,
  };
}

describe("AgentContextService refresh", () => {
  test("uses discovery for missing snapshots and retries snapshots with no resolved history", async () => {
    const harness = openAgent();
    const current = await source("current.jsonl");
    const fake = fakeHistory(resolved(current.ref, current.fingerprint));
    const service = context(harness, fake.service);

    await expect(
      service.refreshAgent({ agent: harness.agent, identityChanged: false }),
    ).resolves.toMatchObject({
      changed: true,
      snapshot: { historyRef: current.ref },
    });
    expect(fake.calls).toEqual([{ forceDiscovery: true }]);

    const empty = resolved(null, null);
    harness.agentContextSnapshots.put(snapshotInput(harness.agent, empty));
    const retry = fakeHistory(resolved(current.ref, current.fingerprint));
    await context(harness, retry.service).refreshAgent({
      agent: harness.agent,
      identityChanged: false,
    });
    expect(retry.calls).toEqual([{ forceDiscovery: true }]);
  });

  test("reuses a stored ref only for upward revisions with a changed source or unchanged revisions", async () => {
    const changed = await source("changed.jsonl");
    const harness = openAgent({ revision: 1 });
    harness.agentContextSnapshots.put({
      ...snapshotInput(harness.agent, resolved(changed.ref, { ...changed.fingerprint, size: 0 })),
      paneRevision: 1,
    });
    const fake = fakeHistory(resolved(changed.ref, changed.fingerprint));
    const refreshed = refreshAgent(harness, { revision: 2 });

    await context(harness, fake.service).refreshAgent({ agent: refreshed, identityChanged: false });
    expect(fake.calls).toEqual([{ forceDiscovery: false, preferredRef: changed.ref }]);

    const unchanged = await source("unchanged.jsonl");
    const unchangedHarness = openAgent({ revision: 2 });
    unchangedHarness.agentContextSnapshots.put(
      snapshotInput(unchangedHarness.agent, resolved(unchanged.ref, unchanged.fingerprint)),
    );
    const unchangedFake = fakeHistory(resolved(unchanged.ref, unchanged.fingerprint));
    await context(unchangedHarness, unchangedFake.service).refreshAgent({
      agent: unchangedHarness.agent,
      identityChanged: false,
    });
    expect(unchangedFake.calls).toEqual([{ forceDiscovery: false, preferredRef: unchanged.ref }]);
  });

  test("forces discovery for an unchanged source after revision advance, revision reset, identity changes, and deleted paths", async () => {
    const original = await source("original.jsonl");
    const cases = [
      { identityChanged: false, revision: 2, fingerprint: original.fingerprint },
      { identityChanged: false, revision: 0, fingerprint: { ...original.fingerprint, size: 0 } },
      { identityChanged: true, revision: 1, fingerprint: original.fingerprint },
      {
        identityChanged: false,
        revision: 2,
        fingerprint: { ...original.fingerprint, path: join(tmpdir(), "removed-history.jsonl") },
      },
    ];
    for (const item of cases) {
      const harness = openAgent({ revision: 1 });
      harness.agentContextSnapshots.put(
        snapshotInput(harness.agent, resolved(original.ref, item.fingerprint)),
      );
      const fake = fakeHistory(resolved(original.ref, original.fingerprint));
      const agent = refreshAgent(harness, { revision: item.revision });

      await context(harness, fake.service).refreshAgent({
        agent,
        identityChanged: item.identityChanged,
      });
      expect(fake.calls).toEqual([{ forceDiscovery: true, preferredRef: original.ref }]);
    }
  });

  test("prefers a changed authoritative session ref and retains an unchanged authoritative ref", async () => {
    const oldSource = await source("old.jsonl");
    const authoritative = await source("authoritative.jsonl");
    const authoritativePath = authoritative.ref.path;
    if (!authoritativePath) throw new Error("Expected authoritative path");
    const session = { agent: "pi", kind: "path", source: "pi", value: authoritative.ref.value };
    const harness = openAgent({ revision: 1 });
    harness.agentContextSnapshots.put(
      snapshotInput(harness.agent, resolved(oldSource.ref, oldSource.fingerprint)),
    );
    const fake = fakeHistory(resolved(authoritative.ref, authoritative.fingerprint));
    const changedIdentity = refreshAgent(harness, { agentSession: session, revision: 2 });

    await context(harness, fake.service).refreshAgent({
      agent: changedIdentity,
      identityChanged: true,
    });
    expect(fake.calls).toEqual([
      {
        forceDiscovery: false,
        preferredRef: {
          kind: "agent_session",
          path: authoritativePath,
          source: "pi-jsonl",
          value: authoritative.ref.value,
        },
      },
    ]);

    const retained = openAgent({ agentSession: session, revision: 1 });
    const authoritativeRef = {
      kind: "agent_session" as const,
      path: authoritativePath,
      source: "pi-jsonl" as const,
      value: authoritative.ref.value,
    };
    retained.agentContextSnapshots.put(
      snapshotInput(retained.agent, resolved(authoritativeRef, authoritative.fingerprint)),
    );
    const retainedFake = fakeHistory(resolved(authoritativeRef, authoritative.fingerprint));
    const revised = refreshAgent(retained, { agentSession: session, revision: 2 });
    await context(retained, retainedFake.service).refreshAgent({
      agent: revised,
      identityChanged: false,
    });
    expect(retainedFake.calls).toEqual([{ forceDiscovery: false, preferredRef: authoritativeRef }]);
  });

  test("reuses a resolved path for the same authoritative ID and rebinds changed IDs", async () => {
    const firstSource = await source("id-first.jsonl");
    const firstPath = firstSource.ref.path;
    if (!firstPath) throw new Error("Expected first history path");
    const firstSession = { agent: "pi", kind: "id", source: "herdr:pi", value: "session-1" };
    const firstRef = {
      kind: "agent_session" as const,
      path: firstPath,
      source: "pi-jsonl" as const,
      value: firstSession.value,
    };
    const harness = openAgent({ agentSession: firstSession, revision: 1 });
    harness.agentContextSnapshots.put(
      snapshotInput(harness.agent, resolved(firstRef, firstSource.fingerprint)),
    );
    const reused = fakeHistory(resolved(firstRef, firstSource.fingerprint));
    const revised = refreshAgent(harness, { agentSession: firstSession, revision: 2 });

    await context(harness, reused.service).refreshAgent({
      agent: revised,
      identityChanged: false,
    });
    expect(reused.calls).toEqual([{ forceDiscovery: false, preferredRef: firstRef }]);

    const secondSource = await source("id-second.jsonl");
    const secondSession = { agent: "pi", kind: "id", source: "herdr:pi", value: "session-2" };
    const discovered = resolved(secondSource.ref, secondSource.fingerprint);
    const changed = fakeHistory(discovered);
    const replaced = refreshAgent(harness, { agentSession: secondSession, revision: 3 });
    const result = await context(harness, changed.service).refreshAgent({
      agent: replaced,
      identityChanged: true,
    });

    expect(changed.calls).toEqual([{ forceDiscovery: true }]);
    expect(result.snapshot.historyRef).toEqual({
      kind: "agent_session",
      path: secondSource.ref.path,
      source: "pi-jsonl",
      value: "session-2",
    });
    expect(result.snapshot.compactHistory.historyRef).toEqual(result.snapshot.historyRef);
  });

  test("only writes when the complete snapshot payload changes", async () => {
    const current = await source("duplicate.jsonl");
    const harness = openAgent({ revision: 1 });
    const value = resolved(current.ref, current.fingerprint);
    const stored = harness.agentContextSnapshots.put(snapshotInput(harness.agent, value));
    const fake = fakeHistory(value);
    const service = context(harness, fake.service);

    await expect(
      service.refreshAgent({ agent: harness.agent, identityChanged: false }),
    ).resolves.toEqual({
      changed: false,
      snapshot: stored,
    });

    const advanced = refreshAgent(harness, { revision: 2 });
    const refreshed = await service.refreshAgent({ agent: advanced, identityChanged: false });
    expect(refreshed.changed).toBe(true);
    expect(refreshed.snapshot.paneRevision).toBe(2);
    expect(refreshed.snapshot.updatedAt).toBeInstanceOf(Date);
    expect(refreshed.snapshot.updatedAt.getTime()).toBeGreaterThan(stored.updatedAt.getTime());
  });
});

describe("AgentContextService cached reads", () => {
  test("joins indexed agents with persisted compact histories without invoking history", () => {
    const harness = openAgent();
    const agents = harness.agents.replaceForSession({
      agents: [
        {
          agent: "pi",
          agent_status: "working",
          pane_id: "wB:p1",
          terminal_id: "term_pi",
          workspace_id: "wB",
        },
        {
          agent: "claude",
          agent_status: "done",
          pane_id: "wB:p2",
          terminal_id: "term_claude",
          workspace_id: "wB",
        },
        {
          agent: "pi",
          agent_status: "working",
          pane_id: "wB:p3",
          terminal_id: "term_other_pi",
          workspace_id: "wB",
        },
      ],
      herdrSessionName: "default",
    });
    const claude = agents.find((agent) => agent.terminalId === "term_claude");
    const otherPi = agents.find((agent) => agent.terminalId === "term_other_pi");
    if (!claude || !otherPi) throw new Error("Expected seeded agents");
    const claudeRef: AgentHistoryRef = {
      kind: "discovered_file",
      path: "/tmp/claude.jsonl",
      source: "claude-jsonl",
      value: "/tmp/claude.jsonl",
    };
    const piRef: AgentHistoryRef = {
      kind: "discovered_file",
      path: "/tmp/pi.jsonl",
      source: "pi-jsonl",
      value: "/tmp/pi.jsonl",
    };
    const claudeSnapshot = harness.agentContextSnapshots.put({
      agentId: claude.id,
      compactHistory: history(claudeRef, "claude done"),
      historyRef: claudeRef,
      paneRevision: null,
      sourceFingerprint: { mtimeMs: 1, path: "/tmp/claude.jsonl", size: 1 },
    });
    const otherPiSnapshot = harness.agentContextSnapshots.put({
      agentId: otherPi.id,
      compactHistory: history(piRef, "pi done"),
      historyRef: piRef,
      paneRevision: null,
      sourceFingerprint: { mtimeMs: 1, path: "/tmp/pi.jsonl", size: 1 },
    });
    const historyMethodsThrow = new Proxy(
      {},
      {
        get: () => () => {
          throw new Error("history must not run");
        },
      },
    ) as AgentHistoryService;
    const service = context(harness, historyMethodsThrow);

    expect(service.getAgentSnapshot(claude.id)).toEqual(claudeSnapshot);
    expect(service.listAgents({ herdrSessionName: "default", workspaceId: "wB" })).toEqual([
      expect.objectContaining({
        agent: "pi",
        terminalId: "term_pi",
        history: {
          lastAssistantMessage: null,
          lastUserMessage: null,
          source: null,
          updatedAt: null,
        },
      }),
      expect.objectContaining({
        agent: "claude",
        terminalId: "term_claude",
        history: expect.objectContaining({
          lastAssistantMessage: expect.objectContaining({ text: "claude done" }),
        }),
      }),
      expect.objectContaining({ agent: "pi", terminalId: "term_other_pi" }),
    ]);
    const workspace = service.workspaceSnapshot({
      excludeTerminalId: "term_pi",
      herdrSessionName: "default",
      workspaceId: "wB",
    });
    expect(workspace).toMatchObject({
      agents: [{ terminalId: "term_claude" }, { terminalId: "term_other_pi" }],
      herdrSessionName: "default",
      workspaceId: "wB",
    });
    expect(workspace?.updatedAt).toBe(
      new Date(
        Math.max(claudeSnapshot.updatedAt.getTime(), otherPiSnapshot.updatedAt.getTime()),
      ).toISOString(),
    );
  });

  test("returns no workspace context without persisted non-self snapshots and excludes stopped sessions", () => {
    const harness = openAgent();
    const ownerRef: AgentHistoryRef = {
      kind: "discovered_file",
      path: "/tmp/owner.jsonl",
      source: "pi-jsonl",
      value: "/tmp/owner.jsonl",
    };
    harness.agentContextSnapshots.put({
      agentId: harness.agent.id,
      compactHistory: history(ownerRef, "owner done"),
      historyRef: ownerRef,
      paneRevision: null,
      sourceFingerprint: { mtimeMs: 1, path: "/tmp/owner.jsonl", size: 1 },
    });
    const historyMethodsThrow = new Proxy(
      {},
      {
        get: () => () => {
          throw new Error("history must not run");
        },
      },
    ) as AgentHistoryService;
    const service = context(harness, historyMethodsThrow);

    expect(
      service.workspaceSnapshot({
        excludeTerminalId: "term_pi",
        herdrSessionName: "default",
        workspaceId: "wB",
      }),
    ).toBeNull();
    harness.herdrSessions.markStoppedMissingFrom([]);
    expect(service.listAgents({ herdrSessionName: "default", workspaceId: "wB" })).toEqual([]);
    expect(
      service.workspaceSnapshot({
        excludeTerminalId: "other",
        herdrSessionName: "default",
        workspaceId: "wB",
      }),
    ).toBeNull();
  });
});
