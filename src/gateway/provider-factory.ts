import type { CodexAppServerSettings } from "ai-sdk-provider-codex-cli";
import type { ShepherdConfig } from "@/config/schema.js";
import type { AiSdkGenerateText } from "./ai-sdk-provider.js";
import {
  type ClosableGatewayProvider,
  type CodexAppServerFactory,
  createCodexAppServerGatewayProvider,
} from "./codex-provider.js";

export type GatewayProviderFactoryDependencies = {
  createCodexProvider?: CodexAppServerFactory;
  generateText?: AiSdkGenerateText;
};

export function createGatewayProviderFromConfig(
  config: ShepherdConfig,
  deps: GatewayProviderFactoryDependencies = {},
): ClosableGatewayProvider {
  const providerConfig = config.providers[config.gateway.default_provider];
  if (!providerConfig) {
    throw new Error(`Gateway provider is not configured: ${config.gateway.default_provider}`);
  }

  if (providerConfig.type !== "codex_cli") {
    throw new Error(`Gateway provider type is not implemented: ${providerConfig.type}`);
  }

  return createCodexAppServerGatewayProvider({
    model: config.gateway.model,
    ...(deps.createCodexProvider !== undefined ? { createProvider: deps.createCodexProvider } : {}),
    ...(deps.generateText !== undefined ? { generateText: deps.generateText } : {}),
    ...(providerConfig.settings !== undefined
      ? { defaultSettings: providerConfig.settings as CodexAppServerSettings }
      : {}),
  });
}
