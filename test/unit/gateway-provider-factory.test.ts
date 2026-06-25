import type { LanguageModel } from "ai";
import { describe, expect, test } from "vitest";
import type { ShepherdConfig } from "@/config/schema.js";
import {
  createGatewayProviderFromConfig,
  createGatewayProviderRouterFromConfig,
  type GatewayProviderFactoryDependencies,
} from "@/gateway/provider-factory.js";
import type { LogicalToolRunner } from "@/gateway/tools.js";

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

  test("creates API key backed AI SDK providers", async () => {
    const config = openConfig();
    configuredProviders(config).gateway = {
      api_key_env: "OPENAI_API_KEY",
      type: "openai",
    };
    config.gateway.model = "gpt-4.1";
    const calls: unknown[] = [];

    const provider = createGatewayProviderFromConfig(config, {
      environment: { OPENAI_API_KEY: "test-key" },
      generateText: async (options) => {
        calls.push(options.model);
        return { text: "ok" };
      },
    });
    await expect(
      provider.generate({
        messages: [{ content: "hello", role: "user" }],
        sessionId: "session-1",
        tools: {
          list: () => [],
          run: async () => ({}),
        } as unknown as LogicalToolRunner,
      }),
    ).resolves.toEqual({ text: "ok" });
    await provider.close();

    expect(calls).toHaveLength(1);
  });

  test("requires configured API key environment variables", () => {
    const config = openConfig();
    configuredProviders(config).gateway = {
      api_key_env: "OPENAI_API_KEY",
      type: "openai",
    };

    expect(() =>
      createGatewayProviderFromConfig(config, {
        environment: {},
      }),
    ).toThrow("Missing required environment variable: OPENAI_API_KEY");
  });

  test("routes turns to provider and model overrides", async () => {
    const calls: unknown[] = [];
    const deps: GatewayProviderFactoryDependencies = {
      createCodexProvider: () => {
        const provider = (modelId: string) => {
          calls.push({ modelId });
          return modelId as unknown as LanguageModel;
        };
        provider.close = async () => {
          calls.push({ closed: true });
        };
        return provider;
      },
      generateText: async (options) => {
        calls.push({ generatedWith: options.model });
        return { text: "ok" };
      },
    };
    const config = openConfig();
    configuredProviders(config).alt = {
      auth_source: "codex_cli",
      mode: "app_server",
      type: "codex_cli",
    };
    const router = createGatewayProviderRouterFromConfig(config, deps);

    await router.generate({
      messages: [{ content: "hello", role: "user" }],
      providerOverride: { model: "gpt-5.3-alt", provider: "alt" },
      sessionId: "session-1",
      tools: {
        list: () => [],
        run: async () => ({}),
      } as unknown as LogicalToolRunner,
    });
    await router.close();

    expect(calls).toEqual([
      { modelId: "gpt-5.3-alt" },
      { generatedWith: "gpt-5.3-alt" },
      { closed: true },
    ]);
  });
});

function configuredProviders(config: ShepherdConfig): NonNullable<ShepherdConfig["providers"]> {
  if (!config.providers) {
    throw new Error("Expected legacy providers to be configured");
  }

  return config.providers;
}

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
