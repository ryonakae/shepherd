import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { applyMigrations } from "@/db/apply-migrations.js";
import { openSqlite } from "@/db/client.js";
import { EventStore } from "@/db/event-store.js";
import { WorkerAgentBindingStore } from "@/db/worker-agent-bindings.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("WorkerAgentBindingStore", () => {
  test("inserts worker bindings with defaults", () => {
    const { bindings } = openHarness();

    const binding = bindings.upsertBinding({
      agentName: "impl",
      agentProfile: "codex",
      description: "Implementation worker",
      herdrSessionName: "herdr-session",
      paneId: "pane-1",
      role: "implementation",
      sessionId: "session-1",
      workspaceId: "workspace-1",
    });

    expect(binding).toMatchObject({
      agentName: "impl",
      agentProfile: "codex",
      agentStatus: "unknown",
      bindingHealth: "starting",
      description: "Implementation worker",
      herdrSessionName: "herdr-session",
      lastTask: null,
      metadata: null,
      paneId: "pane-1",
      role: "implementation",
      sessionId: "session-1",
      workspaceId: "workspace-1",
    });
    expect(binding.lastSeenAt).toBeInstanceOf(Date);
  });

  test("re-upserts the same session workspace agent without duplicates", () => {
    const { bindings } = openHarness();
    const first = bindings.upsertBinding({
      agentName: "reviewer",
      agentProfile: "claude",
      agentStatus: "working",
      bindingHealth: "present",
      description: "Review worker",
      herdrSessionName: "herdr-session",
      lastTask: "review plan",
      metadata: { a: 1 },
      paneId: "pane-1",
      role: "review",
      sessionId: "session-1",
      tabId: "tab-1",
      workspaceId: "workspace-1",
    });

    const second = bindings.upsertBinding({
      agentName: "reviewer",
      agentProfile: "claude",
      agentStatus: "idle",
      bindingHealth: "present",
      description: "Updated review worker",
      herdrSessionName: "herdr-session",
      lastTask: "review implementation",
      metadata: { b: 2 },
      paneId: "pane-2",
      role: "review",
      sessionId: "session-1",
      tabId: "tab-2",
      workspaceId: "workspace-1",
    });

    expect(second.id).toBe(first.id);
    expect(second).toMatchObject({
      agentStatus: "idle",
      bindingHealth: "present",
      description: "Updated review worker",
      lastTask: "review implementation",
      metadata: { b: 2 },
      paneId: "pane-2",
      tabId: "tab-2",
    });
    expect(bindings.listForSession("session-1")).toHaveLength(1);
  });

  test("lists worker bindings by updatedAt descending", () => {
    const { bindings } = openHarness();
    bindings.upsertBinding({
      agentName: "first",
      agentProfile: "codex",
      herdrSessionName: "herdr-session",
      paneId: "pane-1",
      role: "general",
      sessionId: "session-1",
      workspaceId: "workspace-1",
    });
    bindings.upsertBinding({
      agentName: "second",
      agentProfile: "codex",
      herdrSessionName: "herdr-session",
      paneId: "pane-2",
      role: "test",
      sessionId: "session-1",
      workspaceId: "workspace-1",
    });

    expect(bindings.listForSession("session-1").map((binding) => binding.agentName)).toEqual([
      "second",
      "first",
    ]);
  });

  test("gets worker binding by agent name", () => {
    const { bindings } = openHarness();
    bindings.upsertBinding({
      agentName: "researcher",
      agentProfile: "gemini",
      herdrSessionName: "herdr-session",
      paneId: "pane-1",
      role: "research",
      sessionId: "session-1",
      workspaceId: "workspace-1",
    });

    expect(
      bindings.getByAgentName({
        agentName: "researcher",
        sessionId: "session-1",
        workspaceId: "workspace-1",
      }),
    ).toMatchObject({ agentName: "researcher", role: "research" });
    expect(() =>
      bindings.getByAgentName({
        agentName: "missing",
        sessionId: "session-1",
        workspaceId: "workspace-1",
      }),
    ).toThrow("Worker agent binding not found");
  });

  test("validates role, status, and health inputs", () => {
    const { bindings } = openHarness();

    expect(() =>
      bindings.upsertBinding({
        agentName: "bad-role",
        agentProfile: "codex",
        herdrSessionName: "herdr-session",
        paneId: "pane-1",
        role: "invalid" as never,
        sessionId: "session-1",
        workspaceId: "workspace-1",
      }),
    ).toThrow("Invalid worker agent role: invalid");

    expect(() =>
      bindings.upsertBinding({
        agentName: "bad-status",
        agentProfile: "codex",
        agentStatus: "invalid" as never,
        herdrSessionName: "herdr-session",
        paneId: "pane-1",
        role: "general",
        sessionId: "session-1",
        workspaceId: "workspace-1",
      }),
    ).toThrow("Invalid worker agent status: invalid");

    expect(() =>
      bindings.upsertBinding({
        agentName: "bad-health",
        agentProfile: "codex",
        bindingHealth: "invalid" as never,
        herdrSessionName: "herdr-session",
        paneId: "pane-1",
        role: "general",
        sessionId: "session-1",
        workspaceId: "workspace-1",
      }),
    ).toThrow("Invalid worker binding health: invalid");
  });

  test("updates observed state", () => {
    const { bindings } = openHarness();
    bindings.upsertBinding({
      agentName: "impl",
      agentProfile: "codex",
      herdrSessionName: "herdr-session",
      paneId: "pane-1",
      role: "implementation",
      sessionId: "session-1",
      workspaceId: "workspace-1",
    });

    expect(
      bindings.updateObservedState({
        agentName: "impl",
        agentStatus: "working",
        bindingHealth: "present",
        metadata: { event: "pane.agent_status_changed" },
        sessionId: "session-1",
        workspaceId: "workspace-1",
      }),
    ).toMatchObject({
      agentStatus: "working",
      bindingHealth: "present",
      metadata: { event: "pane.agent_status_changed" },
    });
  });
});

function openHarness(): { bindings: WorkerAgentBindingStore } {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-worker-bindings-"));
  tempDirs.push(dir);

  const { sqlite } = openSqlite(join(dir, "test.sqlite"));
  applyMigrations(sqlite, { migrationsFolder: "drizzle" });
  const events = new EventStore(sqlite);
  events.createSession({ id: "session-1" });

  return { bindings: new WorkerAgentBindingStore(sqlite) };
}
