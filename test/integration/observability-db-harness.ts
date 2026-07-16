import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentContextSnapshotStore } from "@/db/agent-context-snapshots.js";
import { AgentEventStore } from "@/db/agent-events.js";
import { AgentHistoryCacheStore } from "@/db/agent-history-cache.js";
import { AgentOrchestratorScopeStore } from "@/db/agent-orchestrator-scopes.js";
import { AgentStore } from "@/db/agents.js";
import { applyMigrations } from "@/db/apply-migrations.js";
import { openSqlite } from "@/db/client.js";
import { HerdrSessionStore } from "@/db/herdr-sessions.js";
import { HerdrWorkspaceStore } from "@/db/herdr-workspaces.js";

export const tempDirs: string[] = [];

export function openObservabilityDbHarness() {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-agent-db-"));
  tempDirs.push(dir);
  const { sqlite } = openSqlite(join(dir, "test.sqlite"));
  applyMigrations(sqlite, { migrationsFolder: "drizzle" });
  const agentEvents = new AgentEventStore(sqlite);
  return {
    agentContextSnapshots: new AgentContextSnapshotStore(sqlite),
    agentEvents,
    agentHistoryCache: new AgentHistoryCacheStore(sqlite),
    agentOrchestratorScopes: new AgentOrchestratorScopeStore(sqlite),
    agents: new AgentStore(sqlite),
    herdrSessions: new HerdrSessionStore(sqlite),
    herdrWorkspaces: new HerdrWorkspaceStore(sqlite),
    sqlite,
  };
}

export function cleanupTempDirs(): void {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
}
