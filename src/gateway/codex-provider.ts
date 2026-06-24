import type { LanguageModel } from "ai";
import {
  type CodexAppServerProviderSettings,
  type CodexAppServerSettings,
  type CodexModelId,
  createCodexAppServer,
} from "ai-sdk-provider-codex-cli";
import { AiSdkGatewayProvider, type AiSdkGenerateText } from "./ai-sdk-provider.js";
import type { GatewayProvider, GatewayProviderInput, GatewayProviderOutput } from "./runner.js";
import { buildGatewaySystemPrompt } from "./system-prompt.js";

export type ClosableGatewayProvider = GatewayProvider & {
  close(): Promise<void>;
};

export type CodexAppServerLike = {
  (modelId: string, settings?: CodexAppServerSettings): LanguageModel;
  close(): Promise<void>;
};

export type CodexAppServerFactory = (
  options?: CodexAppServerProviderSettings,
) => CodexAppServerLike;

export type CodexGatewayProviderOptions = {
  createProvider?: CodexAppServerFactory;
  defaultSettings?: CodexAppServerSettings;
  generateText?: AiSdkGenerateText;
  maxSteps?: number;
  model: string;
  modelSettings?: CodexAppServerSettings;
  providerOptions?: Record<string, unknown>;
  system?: string;
};

export function createCodexAppServerGatewayProvider(
  options: CodexGatewayProviderOptions,
): ClosableGatewayProvider {
  const appServer = (options.createProvider ?? createCodexAppServer)({
    defaultSettings: {
      autoApprove: false,
      minCodexVersion: "0.130.0",
      personality: "pragmatic",
      ...options.defaultSettings,
    },
  });
  const aiProviderOptions = {
    model: appServer(options.model as CodexModelId, options.modelSettings),
    providerOptions: options.providerOptions ?? {
      "codex-app-server": {
        approvalPolicy: "on-failure",
        persistExtendedHistory: true,
        sandboxPolicy: { type: "workspaceWrite" },
        threadMode: "persistent",
      },
    },
    system: options.system ?? buildGatewaySystemPrompt(),
  };

  const aiProvider = new AiSdkGatewayProvider({
    ...aiProviderOptions,
    ...(options.generateText !== undefined ? { generateText: options.generateText } : {}),
    ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
  });

  return {
    close: () => appServer.close(),
    generate: (input: GatewayProviderInput): Promise<GatewayProviderOutput> =>
      aiProvider.generate(input),
  };
}
