import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { env, exit } from "node:process";
import { createAgentHistoryService } from "@/agent-history/service.js";
import { resolveRuntime } from "@/config/runtime.js";
import { AgentEventStore } from "@/db/agent-events.js";
import { AgentHistoryCacheStore } from "@/db/agent-history-cache.js";
import { AgentNotificationCursorStore } from "@/db/agent-notification-cursors.js";
import { AgentStore } from "@/db/agents.js";
import { applyMigrations } from "@/db/apply-migrations.js";
import { openSqlite } from "@/db/client.js";
import { HerdrSessionStore } from "@/db/herdr-sessions.js";
import { HerdrWorkspaceStore } from "@/db/herdr-workspaces.js";
import { createHerdrSessionListRunner } from "@/herdr/session-list.js";
import { AgentIndexService } from "@/observability/agent-index-service.js";
import { AgentNotificationService } from "@/observability/agent-notification-service.js";
import { HerdrSessionWatchManager } from "./herdr-session-watch-manager.js";
import { ObservabilityRpcServer } from "./observability-server.js";

export async function runObservabilityDaemonService(
  input: { environment?: NodeJS.ProcessEnv | undefined } = {},
): Promise<void> {
  const runtime = resolveRuntime({ environment: input.environment });
  applyEnvironment(runtime.environment);
  mkdirSync(dirname(runtime.paths.dbPath), { recursive: true });
  mkdirSync(dirname(runtime.paths.socketPath), { recursive: true });

  const { sqlite } = openSqlite(runtime.paths.dbPath);
  applyMigrations(sqlite, { migrationsFolder: "drizzle" });

  const herdrSessions = new HerdrSessionStore(sqlite);
  const herdrWorkspaces = new HerdrWorkspaceStore(sqlite);
  const agents = new AgentStore(sqlite);
  const agentEvents = new AgentEventStore(sqlite);
  const agentHistoryCache = new AgentHistoryCacheStore(sqlite);
  const agentNotificationCursors = new AgentNotificationCursorStore({
    events: agentEvents,
    sqlite,
  });
  const history = createAgentHistoryService({ cache: agentHistoryCache });
  const notifications = new AgentNotificationService({ cursors: agentNotificationCursors });
  const index = new AgentIndexService({
    history,
    stores: { agentEvents, agentHistoryCache, agents, herdrSessions, herdrWorkspaces },
  });

  const server = new ObservabilityRpcServer({
    history,
    notifications,
    socketPath: runtime.paths.socketPath,
    stores: { agentEvents, agents, herdrWorkspaces },
  });
  const watchManager = new HerdrSessionWatchManager({
    agents,
    herdrSessions,
    index,
    onAgentEvent: (event) => server.publishAgentEvent(event),
    sessionList: createHerdrSessionListRunner({ env: runtime.environment }),
  });

  await server.start();
  await watchManager.start();
  console.log(`Shepherd daemon listening on ${runtime.paths.socketPath}`);

  const stop = async () => {
    await watchManager.stop();
    await server.stop();
    sqlite.close();
    exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

function applyEnvironment(environment: NodeJS.ProcessEnv): void {
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
}
