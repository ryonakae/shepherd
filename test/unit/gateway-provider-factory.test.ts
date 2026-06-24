import type { LanguageModel } from "ai";
import { describe, expect, test } from "vitest";
import type { ShepherdConfig } from "@/config/schema.js";
import {
  createGatewayProviderFromConfig,
  type GatewayProviderFactoryDependencies,
} from "@/gateway/provider-factory.js";

describe("createGatewayProviderFromConfig", () => {
  test("creates the configured Codex CLI app-server provider", async () => {
    const calls: unknown[] = [];
    const deps: GatewayProviderFactoryDependencies = {
      createCodexProvider: (options) => {
        calls.push({ options });
        const provider = (modelId: string) => {
          calls.push({ modelId });
          return "codex-model" as unknown as LanguageModel;
        };
        provider.close = async () => {};
        return provider;
      },
      generateText: async () => ({ text: "ok" }),
    };

    const provider = createGatewayProviderFromConfig(openConfig(), deps);
    await provider.close();

    expect(calls).toEqual([
      {
        options: {
          defaultSettings: {
            autoApprove: false,
            minCodexVersion: "0.130.0",
            personality: "pragmatic",
            requestTimeoutMs: 123,
          },
        },
      },
      { modelId: "gpt-5.3-codex" },
    ]);
  });

  test("rejects non-Codex providers until adapters are implemented", () => {
    const config = openConfig();
    config.providers.gateway = {
      api_key_env: "OPENAI_API_KEY",
      type: "openai",
    };

    expect(() => createGatewayProviderFromConfig(config)).toThrow(
      "Gateway provider type is not implemented: openai",
    );
  });
});

function openConfig(): ShepherdConfig {
  return {
    agents: {
      codex: { command: "codex" },
    },
    default_agent: "codex",
    gateway: {
      default_provider: "gateway",
      model: "gpt-5.3-codex",
    },
    providers: {
      gateway: {
        auth_source: "codex_cli",
        mode: "app_server",
        settings: { requestTimeoutMs: 123 },
        type: "codex_cli",
      },
    },
  };
}
