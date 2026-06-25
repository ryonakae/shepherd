import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { CodexAppServerSettings } from "ai-sdk-provider-codex-cli";
import type { ShepherdConfig } from "@/config/schema.js";
import { AiSdkGatewayProvider, type AiSdkGenerateText } from "./ai-sdk-provider.js";
import {
  type ClosableGatewayProvider,
  type CodexAppServerFactory,
  createCodexAppServerGatewayProvider,
} from "./codex-provider.js";
import type { GatewayProviderOverride } from "./runner.js";

export type GatewayProviderFactoryDependencies = {
  createCodexProvider?: CodexAppServerFactory;
  environment?: NodeJS.ProcessEnv;
  generateText?: AiSdkGenerateText;
  system?: string;
};

export function createGatewayProviderFromConfig(
  config: ShepherdConfig,
  deps: GatewayProviderFactoryDependencies = {},
  selection: GatewayProviderOverride = {},
): ClosableGatewayProvider {
  const providerName = selection.provider ?? config.gateway.default_provider;
  const modelId = selection.model ?? config.gateway.model;
  if (!providerName || !modelId) {
    throw new Error("Gateway provider and model are not configured");
  }

  const providerConfig = config.providers?.[providerName];
  if (!providerConfig) {
    throw new Error(`Gateway provider is not configured: ${providerName}`);
  }

  if (providerConfig.type === "codex_cli") {
    return createCodexAppServerGatewayProvider({
      model: modelId,
      ...(deps.createCodexProvider !== undefined
        ? { createProvider: deps.createCodexProvider }
        : {}),
      ...(deps.generateText !== undefined ? { generateText: deps.generateText } : {}),
      ...(deps.system !== undefined ? { system: deps.system } : {}),
      ...(providerConfig.settings !== undefined
        ? { defaultSettings: providerConfig.settings as CodexAppServerSettings }
        : {}),
    });
  }

  const apiKey = requireEnv(deps.environment ?? process.env, providerConfig.api_key_env);
  const model =
    providerConfig.type === "openai"
      ? createOpenAI({ apiKey })(modelId)
      : providerConfig.type === "anthropic"
        ? createAnthropic({ apiKey })(modelId)
        : createOpenRouter({ apiKey })(modelId);

  const provider = new AiSdkGatewayProvider({
    model,
    ...(deps.generateText !== undefined ? { generateText: deps.generateText } : {}),
    ...(deps.system !== undefined ? { system: deps.system } : {}),
  });

  return {
    async close() {},
    generate: (input) => provider.generate(input),
  };
}

export function createGatewayProviderRouterFromConfig(
  config: ShepherdConfig,
  deps: GatewayProviderFactoryDependencies = {},
): ClosableGatewayProvider {
  const providers = new Map<string, ClosableGatewayProvider>();

  return {
    async close() {
      await Promise.all([...providers.values()].map((provider) => provider.close()));
      providers.clear();
    },
    generate(input) {
      const provider = getProvider(input.providerOverride);
      return provider.generate(input);
    },
  };

  function getProvider(selection: GatewayProviderOverride | undefined): ClosableGatewayProvider {
    const normalized = normalizeSelection(config, selection);
    if (!normalized.provider || !normalized.model) {
      throw new Error("Gateway provider and model are not configured");
    }

    const key = `${normalized.provider}:${normalized.model}`;
    const existing = providers.get(key);
    if (existing) {
      return existing;
    }

    const provider = createGatewayProviderFromConfig(config, deps, normalized);
    providers.set(key, provider);
    return provider;
  }
}

function normalizeSelection(
  config: ShepherdConfig,
  selection: GatewayProviderOverride | undefined,
): GatewayProviderOverride {
  return {
    ...((selection?.provider ?? config.gateway.default_provider)
      ? { provider: selection?.provider ?? config.gateway.default_provider }
      : {}),
    ...((selection?.model ?? config.gateway.model)
      ? { model: selection?.model ?? config.gateway.model }
      : {}),
  };
}

function requireEnv(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}
