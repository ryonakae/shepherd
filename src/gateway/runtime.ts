import type { DatabaseSync } from "node:sqlite";
import type { ShepherdConfig } from "@/config/schema.js";
import type { EventStore } from "@/db/event-store.js";
import { SessionSummaryStore } from "@/db/session-summary.js";
import { WorkingContextStore } from "@/db/working-contexts.js";
import { HerdrClientPool } from "@/herdr/client-pool.js";
import { ManagedHerdrSocketClient } from "@/herdr/managed-socket-client.js";
import { type HerdrControlClient, HerdrOrchestrator } from "@/herdr/orchestrator.js";
import {
  type HerdrProgressReceiverInput,
  HerdrProgressSubscriptionManager,
} from "@/herdr/progress-subscriptions.js";
import { createBuiltinToolRegistry } from "./builtin-tools.js";
import { ExternalGatewayRunQueue } from "./external-run-queue.js";
import { PiSessionMetadataStore } from "./pi-sessions.js";
import {
  createGatewayProviderRouterFromConfig,
  type GatewayProviderFactoryDependencies,
} from "./provider-factory.js";
import { GatewayRunner } from "./runner.js";
import { GatewaySummaryUpdater } from "./summary.js";
import { buildGatewaySystemPrompt } from "./system-prompt.js";
import { LogicalToolCallStore, LogicalToolRunner } from "./tools.js";
import { GatewayRunStore, GatewayTurnQueue } from "./turn-queue.js";
import { WorkingContextResolver } from "./working-contexts.js";

export type GatewayRuntimeHerdrClient = HerdrControlClient & {
  close(): void;
};

export type GatewayRuntimeOptions = GatewayProviderFactoryDependencies & {
  config: ShepherdConfig;
  createHerdrClient?: (herdrSessionName: string) => GatewayRuntimeHerdrClient;
  events: EventStore;
  piSessionDir?: string;
  receiveHerdrProgress?: (input: HerdrProgressReceiverInput) => Promise<unknown>;
  sqlite: DatabaseSync;
};

export type GatewayRuntime = {
  close(): Promise<void>;
  runner?: GatewayTurnQueue;
  runs: ExternalGatewayRunQueue;
  tools: LogicalToolRunner;
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
  const herdrProgressSubscriptions = options.receiveHerdrProgress
    ? new HerdrProgressSubscriptionManager({
        receiveProgress: options.receiveHerdrProgress,
        sourceForSession: (herdrSessionName) => herdrClients.get(herdrSessionName),
      })
    : undefined;
  const herdr = new HerdrOrchestrator({
    clientForSession: (herdrSessionName) => herdrClients.get(herdrSessionName),
    onWorkspaceBound: (binding) => {
      herdrProgressSubscriptions?.subscribe(binding);
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
  const runStore = new GatewayRunStore(options.sqlite);
  const provider = hasLegacyProviderConfig(options.config)
    ? createGatewayProviderRouterFromConfig(options.config, {
        ...(options.createCodexProvider !== undefined
          ? { createCodexProvider: options.createCodexProvider }
          : {}),
        ...(options.generateText !== undefined ? { generateText: options.generateText } : {}),
        system: buildGatewaySystemPrompt({
          agents: options.config.agents,
          defaultAgent: options.config.default_agent,
        }),
      })
    : undefined;
  const runner = provider
    ? new GatewayRunner({
        events: options.events,
        provider,
        summaryUpdater: new GatewaySummaryUpdater({
          events: options.events,
          provider,
          summaries: new SessionSummaryStore(options.sqlite),
        }),
        tools,
      })
    : undefined;

  return {
    async close() {
      herdrProgressSubscriptions?.close();
      await provider?.close();
      herdrClients.closeAll();
    },
    ...(runner ? { runner: new GatewayTurnQueue({ runStore, runner }) } : {}),
    runs: new ExternalGatewayRunQueue({
      events: options.events,
      ...(options.piSessionDir !== undefined
        ? {
            piSessions: new PiSessionMetadataStore({
              events: options.events,
              sessionDir: options.piSessionDir,
            }),
          }
        : {}),
      runStore,
    }),
    tools,
  };
}

function hasLegacyProviderConfig(config: ShepherdConfig): boolean {
  return Boolean(config.gateway.default_provider && config.gateway.model && config.providers);
}
