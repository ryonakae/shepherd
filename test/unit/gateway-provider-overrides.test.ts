import { describe, expect, test } from "vitest";
import type { ShepherdConfig } from "@/config/schema.js";
import type { SessionBindingRecord } from "@/db/session-bindings.js";
import {
  createConfiguredProviderOverrideResolver,
  parseGatewayProviderOverride,
} from "@/gateway/provider-overrides.js";

describe("gateway provider overrides", () => {
  test("parses explicit provider override payloads", () => {
    expect(parseGatewayProviderOverride({ model: "gpt-4.1", provider: "openai" })).toEqual({
      model: "gpt-4.1",
      provider: "openai",
    });
    expect(parseGatewayProviderOverride({ model: "", provider: "" })).toBeUndefined();
    expect(parseGatewayProviderOverride(null)).toBeUndefined();
  });

  test("resolves session overrides before channel and thread overrides", () => {
    const resolver = createConfiguredProviderOverrideResolver({
      bindings: {
        listForSession() {
          return [
            binding({
              platform: "slack",
              sessionId: "session-1",
              spaceId: "C123",
              threadId: "1700000001.000001",
            }),
          ];
        },
      },
      config: configWithOverrides({
        channels: {
          "slack:C123": { provider: "anthropic" },
          "slack:C123:1700000001.000001": { provider: "openai" },
        },
        sessions: {
          "session-1": { provider: "codex", model: "gpt-5.3-codex-high" },
        },
      }),
    });

    expect(resolver({ sessionId: "session-1" })).toEqual({
      model: "gpt-5.3-codex-high",
      provider: "codex",
    });
  });

  test("resolves thread override before channel override", () => {
    const resolver = createConfiguredProviderOverrideResolver({
      bindings: {
        listForSession() {
          return [
            binding({
              platform: "slack",
              sessionId: "session-2",
              spaceId: "C123",
              threadId: "1700000001.000001",
            }),
          ];
        },
      },
      config: configWithOverrides({
        channels: {
          "slack:C123": { provider: "anthropic" },
          "slack:C123:1700000001.000001": { provider: "openai" },
        },
      }),
    });

    expect(resolver({ sessionId: "session-2" })).toEqual({ provider: "openai" });
  });
});

function configWithOverrides(
  providerOverrides: NonNullable<ShepherdConfig["gateway"]["provider_overrides"]>,
): ShepherdConfig {
  return {
    agents: {
      codex: { command: "codex" },
    },
    default_agent: "codex",
    gateway: {
      default_provider: "codex",
      model: "gpt-5.3-codex",
      provider_overrides: providerOverrides,
    },
    providers: {
      anthropic: { api_key_env: "ANTHROPIC_API_KEY", type: "anthropic" },
      codex: { auth_source: "codex_cli", mode: "app_server", type: "codex_cli" },
      openai: { api_key_env: "OPENAI_API_KEY", type: "openai" },
    },
  };
}

function binding(input: {
  platform: string;
  sessionId: string;
  spaceId: string;
  threadId: string;
}): SessionBindingRecord {
  return {
    createdAt: new Date(0),
    id: "binding-1",
    messageId: null,
    metadata: null,
    platform: input.platform,
    sessionId: input.sessionId,
    spaceId: input.spaceId,
    threadId: input.threadId,
    updatedAt: new Date(0),
  };
}
