import type { DatabaseSync } from "node:sqlite";
import type { ShepherdConfig } from "@/config/schema.js";
import type { EventStore } from "@/db/event-store.js";
import { PiTurnStore } from "@/db/pi-turns.js";
import { WorkingContextStore } from "@/db/working-contexts.js";
import { HerdrClientPool } from "@/herdr/client-pool.js";
import { ManagedHerdrSocketClient } from "@/herdr/managed-socket-client.js";
import { type HerdrControlClient, HerdrOrchestrator } from "@/herdr/orchestrator.js";
import {
  type HerdrProgressReceiverInput,
  HerdrProgressSubscriptionManager,
} from "@/herdr/progress-subscriptions.js";
import { createBuiltinToolRegistry } from "./builtin-tools.js";
import { PiSessionMetadataStore } from "./pi-sessions.js";
import { PiTurnQueue } from "./pi-turn-queue.js";
import { LogicalToolCallStore, LogicalToolRunner } from "./tools.js";
import { WorkingContextResolver } from "./working-contexts.js";

export type GatewayRuntimeHerdrClient = HerdrControlClient & {
  close(): void;
};

export type GatewayRuntimeOptions = {
  config: ShepherdConfig;
  createHerdrClient?: (herdrSessionName: string) => GatewayRuntimeHerdrClient;
  events: EventStore;
  piSessionDir?: string;
  receiveHerdrProgress?: (input: HerdrProgressReceiverInput) => Promise<unknown>;
  sqlite: DatabaseSync;
};

export type GatewayRuntime = {
  close(): Promise<void>;
  herdrProgress: HerdrProgressSubscriptionManager;
  tools: LogicalToolRunner;
  turns: PiTurnQueue;
};

export function createGatewayRuntime(options: GatewayRuntimeOptions): GatewayRuntime {
  const herdrClients = new HerdrClientPool({
    createClient:
      options.createHerdrClient ??
      ((herdrSessionName) =>
        new ManagedHerdrSocketClient({
          herdrSessionName,
        })),
  });
  const herdrProgress = new HerdrProgressSubscriptionManager({
    receiveProgress: options.receiveHerdrProgress ?? (async () => undefined),
    sourceForSession: (herdrSessionName) => herdrClients.get(herdrSessionName),
  });
  const herdr = new HerdrOrchestrator({
    clientForSession: (herdrSessionName) => herdrClients.get(herdrSessionName),
    onWorkspaceBound: (binding) => {
      herdrProgress.subscribe(binding);
    },
    sqlite: options.sqlite,
  });
  const registry = createBuiltinToolRegistry({
    agents: options.config.agents,
    events: options.events,
    herdr,
    workingContexts: new WorkingContextResolver({
      allowedRoots: options.config.context?.allowed_roots ?? [],
      store: new WorkingContextStore(options.sqlite),
    }),
  });
  const tools = new LogicalToolRunner({
    events: options.events,
    policy: { allowedTools: new Set(registry.list().map((tool) => tool.name)) },
    registry,
    toolCalls: new LogicalToolCallStore(options.sqlite),
  });
  const turnStore = new PiTurnStore(options.sqlite);

  return {
    async close() {
      herdrProgress.close();
      herdrClients.closeAll();
    },
    herdrProgress,
    tools,
    turns: new PiTurnQueue({
      events: options.events,
      ...(options.piSessionDir !== undefined
        ? {
            piSessions: new PiSessionMetadataStore({
              events: options.events,
              sessionDir: options.piSessionDir,
            }),
          }
        : {}),
      turnStore,
    }),
  };
}
