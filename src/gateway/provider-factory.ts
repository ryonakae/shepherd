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

export type GatewayProviderFactoryDependencies = {
  createCodexProvider?: CodexAppServerFactory;
  environment?: NodeJS.ProcessEnv;
  generateText?: AiSdkGenerateText;
  system?: string;
};

export function createGatewayProviderFromConfig(
  config: ShepherdConfig,
  deps: GatewayProviderFactoryDependencies = {},
): ClosableGatewayProvider {
  const providerConfig = config.providers[config.gateway.default_provider];
  if (!providerConfig) {
    throw new Error(`Gateway provider is not configured: ${config.gateway.default_provider}`);
  }

  if (providerConfig.type === "codex_cli") {
    return createCodexAppServerGatewayProvider({
      model: config.gateway.model,
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
      ? createOpenAI({ apiKey })(config.gateway.model)
      : providerConfig.type === "anthropic"
        ? createAnthropic({ apiKey })(config.gateway.model)
        : createOpenRouter({ apiKey })(config.gateway.model);

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

function requireEnv(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}
