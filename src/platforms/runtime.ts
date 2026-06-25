import type { DatabaseSync } from "node:sqlite";
import { WebClient } from "@slack/web-api";
import type { ShepherdConfig } from "@/config/schema.js";
import type { EventRecord, EventStore } from "@/db/event-store.js";
import { SessionBindingStore } from "@/db/session-bindings.js";
import { SessionDeliveryFanout } from "@/delivery/fanout.js";
import { DeliveryReceiptStore, DeliveryRouter } from "@/delivery/router.js";
import {
  SlackDeliveryAdapter,
  type SlackPostMessageClient,
  SlackStreamDelivery,
} from "./slack/delivery.js";
import { SlackInboundHandler, type SlackPolicyLogMetadata } from "./slack/inbound.js";
import {
  createSlackBoltApp,
  type SlackBoltLikeApp,
  SlackSocketModeAdapter,
} from "./slack/socket-mode.js";

export type GatewayStreamDelivery = {
  delta(input: { delta: string; gatewayRunId: string; sessionId: string }): Promise<void>;
  finish(input: { finalText?: string; gatewayRunId: string }): Promise<void>;
  hasFinished(gatewayRunId: string): boolean;
};

export type PlatformRuntime = {
  close(): Promise<void>;
  deliveryFanout?: SessionDeliveryFanout;
  streamDelivery?: GatewayStreamDelivery;
  start(): Promise<void>;
};

export type PlatformLogger = {
  debug?: (message: string, metadata?: Record<string, unknown>) => void;
};

export type PlatformRuntimeOptions = {
  config: ShepherdConfig;
  createSlackApp?: (tokens: { appToken: string; botToken: string }) => SlackBoltLikeApp;
  createSlackWebClient?: (botToken: string) => SlackPostMessageClient;
  environment?: NodeJS.ProcessEnv;
  events: EventStore;
  logger?: PlatformLogger;
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
  const logger = options.logger ?? consolePlatformLogger;

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
      logger: {
        debug(message: string, metadata: SlackPolicyLogMetadata) {
          logger.debug?.(message, metadata);
        },
      },
      policy: {
        ...(slack.allowed_channels ? { allowedChannels: slack.allowed_channels } : {}),
        ...(slack.allowed_teams ? { allowedTeams: slack.allowed_teams } : {}),
        ...(slack.allowed_users ? { allowedUsers: slack.allowed_users } : {}),
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
  const slackStream = new SlackStreamDelivery({
    client,
    config: {
      bufferThresholdChars: slack.streaming?.buffer_threshold_chars ?? 40,
      cursor: slack.streaming?.cursor ?? " ▉",
      editIntervalMs: slack.streaming?.edit_interval_ms ?? 750,
    },
  });
  const streamDelivery: GatewayStreamDelivery | undefined =
    slack.streaming?.enabled === false
      ? undefined
      : {
          async delta(input) {
            for (const binding of bindings.listForSession(input.sessionId)) {
              if (binding.platform !== "slack") {
                continue;
              }
              await slackStream.delta({
                delta: input.delta,
                gatewayRunId: input.gatewayRunId,
                targetId: `${binding.spaceId}:${binding.threadId}`,
              });
            }
          },
          finish(input) {
            return slackStream.finish(input);
          },
          hasFinished(gatewayRunId) {
            return slackStream.hasFinished(gatewayRunId);
          },
        };

  return {
    async close() {
      for (const part of parts.toReversed()) {
        await part.close();
      }
    },
    deliveryFanout,
    ...(streamDelivery !== undefined ? { streamDelivery } : {}),
    async start() {
      for (const part of parts) {
        await part.start();
      }
    },
  };
}

const consolePlatformLogger: PlatformLogger = {
  debug(message, metadata) {
    console.debug(message, metadata ?? {});
  },
};

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
