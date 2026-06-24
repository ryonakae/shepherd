import type { ShepherdConfig } from "@/config/schema.js";
import type { SessionBindingStore } from "@/db/session-bindings.js";
import type { GatewayProviderOverride } from "./runner.js";

export type ProviderOverrideResolver = (input: {
  sessionId: string;
}) => GatewayProviderOverride | undefined;

export function parseGatewayProviderOverride(value: unknown): GatewayProviderOverride | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const override = {
    ...(typeof record.provider === "string" && record.provider.length > 0
      ? { provider: record.provider }
      : {}),
    ...(typeof record.model === "string" && record.model.length > 0 ? { model: record.model } : {}),
  };

  return Object.keys(override).length > 0 ? override : undefined;
}

export function createConfiguredProviderOverrideResolver(options: {
  bindings: Pick<SessionBindingStore, "listForSession">;
  config: ShepherdConfig;
}): ProviderOverrideResolver {
  return ({ sessionId }) => {
    const overrides = options.config.gateway.provider_overrides;
    const sessionOverride = overrides?.sessions?.[sessionId];
    if (sessionOverride) {
      return sessionOverride;
    }

    for (const binding of options.bindings.listForSession(sessionId)) {
      const threadOverride =
        overrides?.channels?.[`${binding.platform}:${binding.spaceId}:${binding.threadId}`];
      if (threadOverride) {
        return threadOverride;
      }

      const channelOverride = overrides?.channels?.[`${binding.platform}:${binding.spaceId}`];
      if (channelOverride) {
        return channelOverride;
      }
    }

    return undefined;
  };
}
