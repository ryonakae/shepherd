import { dirname, resolve } from "node:path";
import { env, exit } from "node:process";
import { resolveRuntime } from "@/config/runtime.js";
import { applyMigrations } from "@/db/apply-migrations.js";
import { openSqlite } from "@/db/client.js";
import { EventStore } from "@/db/event-store.js";
import { WorkingContextStore } from "@/db/working-contexts.js";
import { readOrCreateGatewayId } from "@/gateway/identity.js";
import { checkPiReadiness } from "@/gateway/pi-readiness.js";
import { PiSessionMetadataStore } from "@/gateway/pi-sessions.js";
import { HeadlessPiSupervisor } from "@/gateway/pi-supervisor.js";
import { prepareGatewaySocketPath } from "@/gateway/process-manager.js";
import { recoverGatewayState } from "@/gateway/recovery.js";
import { createGatewayRuntime } from "@/gateway/runtime.js";
import { ShepherdGatewayServer } from "@/gateway/server.js";
import { WorkingContextResolver } from "@/gateway/working-contexts.js";
import { createPlatformRuntime } from "@/platforms/runtime.js";

export async function runGatewayService(
  input: { environment?: NodeJS.ProcessEnv | undefined } = {},
): Promise<void> {
  const runtime = resolveRuntime({ environment: input.environment });
  applyEnvironment(runtime.environment);

  const stateDir = dirname(resolve(runtime.paths.dbPath));
  const { sqlite } = openSqlite(runtime.paths.dbPath);
  applyMigrations(sqlite, { migrationsFolder: "drizzle" });
  const events = new EventStore(sqlite);
  recoverGatewayState({ events, sqlite });

  const config = runtime.config;
  const workingContexts = new WorkingContextResolver({
    allowedRoots: config?.context?.allowed_roots ?? [],
    allowUnconfiguredLocalPaths: true,
    store: new WorkingContextStore(sqlite),
  });
  const piSessions = new PiSessionMetadataStore({
    events,
    sessionDir: runtime.paths.piSessionDir,
  });

  let server: ShepherdGatewayServer;
  const gatewayRuntime = config
    ? createGatewayRuntime({
        config,
        events,
        piSessionDir: runtime.paths.piSessionDir,
        receiveHerdrProgress: async (progress) => server.receiveHerdrProgress(progress),
        sqlite,
      })
    : undefined;
  const headlessPi = config
    ? new HeadlessPiSupervisor({
        idleTimeoutMs: config.gateway.pi?.idle_timeout_ms ?? 600_000,
        socketPath: runtime.paths.socketPath,
      })
    : undefined;
  const platformRuntime = config
    ? createPlatformRuntime({
        config,
        events,
        receiveUserMessage: async (message) => server.receiveUserMessage(message),
        sqlite,
      })
    : undefined;

  server = new ShepherdGatewayServer({
    gatewayId: readOrCreateGatewayId(stateDir),
    ...(platformRuntime?.deliveryFanout ? { deliveryFanout: platformRuntime.deliveryFanout } : {}),
    ...(platformRuntime?.runtimeDelivery
      ? { runtimeDelivery: platformRuntime.runtimeDelivery }
      : {}),
    ...(gatewayRuntime ? { piTurns: gatewayRuntime.turns } : {}),
    ...(headlessPi ? { headlessPi } : {}),
    localWorkingContexts: workingContexts,
    ...(gatewayRuntime ? { logicalTools: gatewayRuntime.tools } : {}),
    piSessions,
    socketPath: runtime.paths.socketPath,
    store: events,
    ...(config ? { configPath: runtime.paths.configPath } : {}),
  });

  await prepareGatewaySocketPath({ socketPath: runtime.paths.socketPath });
  await server.start();
  if (config && shouldCheckPiReadiness(gatewayRuntime)) {
    await checkPiReadiness({
      socketPath: runtime.paths.socketPath,
      timeoutMs: config.gateway.pi?.readiness_timeout_ms ?? 10_000,
      waitForHandshake: (timeoutMs) => server.waitForPiHandshake({ timeoutMs }),
    });
  }
  await platformRuntime?.start();
  console.log(`Shepherd gateway listening on ${runtime.paths.socketPath}`);

  const stop = async () => {
    await platformRuntime?.close();
    headlessPi?.stopAll();
    await server.stop();
    await gatewayRuntime?.close();
    sqlite.close();
    exit(0);
  };

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

function shouldCheckPiReadiness(gatewayRuntime: ReturnType<typeof createGatewayRuntime> | undefined): boolean {
  return gatewayRuntime !== undefined;
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
