import type { DatabaseSync } from "node:sqlite";
import type { ShepherdConfig } from "@/config/schema.js";
import type { EventStore } from "@/db/event-store.js";
import { HerdrClientPool } from "@/herdr/client-pool.js";
import { type HerdrControlClient, HerdrOrchestrator } from "@/herdr/orchestrator.js";
import { herdrSocketPathForNamedSession } from "@/herdr/session.js";
import { HerdrSocketClient } from "@/herdr/socket-client.js";
import { createBuiltinToolRegistry } from "./builtin-tools.js";
import {
  createGatewayProviderFromConfig,
  type GatewayProviderFactoryDependencies,
} from "./provider-factory.js";
import { GatewayRunner } from "./runner.js";
import { buildGatewaySystemPrompt } from "./system-prompt.js";
import { LogicalToolRunner } from "./tools.js";
import { GatewayRunStore, GatewayTurnQueue } from "./turn-queue.js";

export type GatewayRuntimeHerdrClient = HerdrControlClient & {
  close(): void;
};

export type GatewayRuntimeOptions = GatewayProviderFactoryDependencies & {
  config: ShepherdConfig;
  createHerdrClient?: (herdrSessionName: string) => GatewayRuntimeHerdrClient;
  events: EventStore;
  sqlite: DatabaseSync;
};

export type GatewayRuntime = {
  close(): Promise<void>;
  runner: GatewayTurnQueue;
};

export function createGatewayRuntime(options: GatewayRuntimeOptions): GatewayRuntime {
  const herdrClients = new HerdrClientPool({
    createClient:
      options.createHerdrClient ??
      ((herdrSessionName) =>
        new HerdrSocketClient({
          socketPath: herdrSocketPathForNamedSession(herdrSessionName),
        })),
  });
  const herdr = new HerdrOrchestrator({
    clientForSession: (herdrSessionName) => herdrClients.get(herdrSessionName),
    sqlite: options.sqlite,
  });
  const registry = createBuiltinToolRegistry({
    agents: options.config.agents,
    events: options.events,
    herdr,
  });
  const tools = new LogicalToolRunner({
    events: options.events,
    policy: { allowedTools: new Set(registry.list().map((tool) => tool.name)) },
    registry,
  });
  const provider = createGatewayProviderFromConfig(options.config, {
    ...(options.createCodexProvider !== undefined
      ? { createCodexProvider: options.createCodexProvider }
      : {}),
    ...(options.generateText !== undefined ? { generateText: options.generateText } : {}),
    system: buildGatewaySystemPrompt({
      agents: options.config.agents,
      defaultAgent: options.config.default_agent,
    }),
  });

  const runner = new GatewayRunner({
    events: options.events,
    provider,
    tools,
  });

  return {
    async close() {
      await provider.close();
      herdrClients.closeAll();
    },
    runner: new GatewayTurnQueue({
      runStore: new GatewayRunStore(options.sqlite),
      runner,
    }),
  };
}
