import type { DatabaseSync } from "node:sqlite";
import { WebClient } from "@slack/web-api";
import type { ShepherdConfig } from "@/config/schema.js";
import type { EventRecord, EventStore } from "@/db/event-store.js";
import { SessionBindingStore } from "@/db/session-bindings.js";
import { SessionDeliveryFanout } from "@/delivery/fanout.js";
import { DeliveryReceiptStore, DeliveryRouter } from "@/delivery/router.js";
import { SlackDeliveryAdapter, type SlackPostMessageClient } from "./slack/delivery.js";
import { SlackInboundHandler } from "./slack/inbound.js";
import {
  createSlackBoltApp,
  type SlackBoltLikeApp,
  SlackSocketModeAdapter,
} from "./slack/socket-mode.js";

export type PlatformRuntime = {
  close(): Promise<void>;
  deliveryFanout?: SessionDeliveryFanout;
  start(): Promise<void>;
};

export type PlatformRuntimeOptions = {
  config: ShepherdConfig;
  createSlackApp?: (tokens: { appToken: string; botToken: string }) => SlackBoltLikeApp;
  createSlackWebClient?: (botToken: string) => SlackPostMessageClient;
  environment?: NodeJS.ProcessEnv;
  events: EventStore;
  receiveUserMessage(input: {
    actorId: string;
    idempotencyKey: string;
    presentation: {
      displayName: string;
      sourcePlatform: "slack";
      sourceUserId: string;
    };
    sessionId: string;
    text: string;
  }): Promise<{ event: EventRecord }>;
  sqlite: DatabaseSync;
};

type RuntimePart = {
  close(): Promise<void>;
  start(): Promise<void>;
};

export function createPlatformRuntime(options: PlatformRuntimeOptions): PlatformRuntime {
  const slack = options.config.platforms?.slack;
  if (!slack) {
    return noOpRuntime();
  }

  const bindings = new SessionBindingStore(options.sqlite);
  const receipts = new DeliveryReceiptStore(options.sqlite);
  const parts: RuntimePart[] = [];
  const adapters: Record<string, SlackDeliveryAdapter> = {};

  const botToken = requireEnv(options.environment ?? process.env, slack.bot_token_env);
  const appToken = requireEnv(options.environment ?? process.env, slack.app_token_env);
  const app =
    options.createSlackApp?.({ appToken, botToken }) ?? createSlackBoltApp({ appToken, botToken });
  const client = options.createSlackWebClient?.(botToken) ?? new WebClient(botToken);
  adapters.slack = new SlackDeliveryAdapter({
    allowCustomize: slack.allow_customize ?? false,
    client,
  });

  const inbound = new SlackInboundHandler(
    { bindings, events: options.events },
    {
      async appendUserMessage(input) {
        const result = await options.receiveUserMessage(input);
        return result.event;
      },
    },
  );
  const socketMode = new SlackSocketModeAdapter({ app, inbound });
  parts.push({
    close: () => socketMode.stop(),
    start: () => socketMode.start(),
  });

  const router = new DeliveryRouter({
    adapters,
    receipts,
  });
  const deliveryFanout = new SessionDeliveryFanout({ bindings, router });

  return {
    async close() {
      for (const part of parts.toReversed()) {
        await part.close();
      }
    },
    deliveryFanout,
    async start() {
      for (const part of parts) {
        await part.start();
      }
    },
  };
}

function noOpRuntime(): PlatformRuntime {
  return {
    async close() {},
    async start() {},
  };
}

function requireEnv(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}
