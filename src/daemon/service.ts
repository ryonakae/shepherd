import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { env, exit } from "node:process";
import { resolveRuntime } from "@/config/runtime.js";
import { applyMigrations } from "@/db/apply-migrations.js";
import { openSqlite } from "@/db/client.js";
import { NotificationCursorStore } from "@/db/notification-cursors.js";
import { ObservedWorkspaceStore } from "@/db/observed-workspaces.js";
import { WorkerEventStore } from "@/db/worker-events.js";
import { WorkerSnapshotStore } from "@/db/worker-snapshots.js";
import { WorkerStore } from "@/db/workers.js";
import { ManagedHerdrSocketClient } from "@/herdr/managed-socket-client.js";
import { HerdrSocketClient } from "@/herdr/socket-client.js";
import type { HerdrControlClientWithSnapshot } from "@/observability/contracts.js";
import { NotificationService } from "@/observability/notification-service.js";
import { WorkerStatePipeline } from "@/observability/worker-state-pipeline.js";
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

  const observedWorkspaces = new ObservedWorkspaceStore(sqlite);
  const workers = new WorkerStore(sqlite);
  const workerEvents = new WorkerEventStore(sqlite);
  const snapshots = new WorkerSnapshotStore(sqlite);
  const cursors = new NotificationCursorStore(sqlite);
  const notifications = new NotificationService({ cursors, workerEvents });
  const pipeline = new WorkerStatePipeline({
    herdrClientForWorkspace(workspace) {
      if (workspace.socketPath) {
        return asSnapshotClient(new HerdrSocketClient({ socketPath: workspace.socketPath }));
      }
      if (!workspace.herdrSessionName) {
        throw new Error(`Observed workspace has no Herdr selector: ${workspace.id}`);
      }
      return asSnapshotClient(
        new ManagedHerdrSocketClient({ herdrSessionName: workspace.herdrSessionName }),
      );
    },
    observedWorkspaces,
    snapshots,
    transcriptAdapters: [],
    workerEvents,
    workers,
  });

  for (const workspace of observedWorkspaces.listActive()) {
    await pipeline.refreshWorkspace(workspace.id).catch(() => undefined);
  }

  const server = new ObservabilityRpcServer({
    notifications,
    pipeline,
    socketPath: runtime.paths.socketPath,
    stores: { observedWorkspaces, snapshots, workerEvents, workers },
  });
  await server.start();
  console.log(`Shepherd observability daemon listening on ${runtime.paths.socketPath}`);

  const stop = async () => {
    await server.stop();
    sqlite.close();
    exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

function asSnapshotClient(
  client: HerdrSocketClient | ManagedHerdrSocketClient,
): HerdrControlClientWithSnapshot {
  return {
    agentRead: (params) => client.readAgent(params),
    agentSend: (params) => client.sendAgentMessage(params),
    agentStart: (params) =>
      client.startAgent({
        args: params.argv.slice(1),
        command: params.argv[0] ?? params.name,
        ...(params.cwd ? { cwd: params.cwd } : {}),
        name: params.name,
        ...(params.tab_id ? { tab_id: params.tab_id } : {}),
        ...(params.workspace_id ? { workspace_id: params.workspace_id } : {}),
      }),
    close: () => client.close(),
    listAgents: () => client.listAgents(),
    sessionSnapshot: () => client.sessionSnapshot(),
    subscribeEvents: (params, options) => client.subscribeEvents(params, options),
  };
}

function applyEnvironment(environment: NodeJS.ProcessEnv): void {
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
}
