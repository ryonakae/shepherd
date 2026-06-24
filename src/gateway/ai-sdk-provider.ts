import {
  tool as aiTool,
  generateText,
  jsonSchema,
  type LanguageModel,
  type ModelMessage,
  stepCountIs,
  type ToolSet,
} from "ai";
import type {
  GatewayMessage,
  GatewayProvider,
  GatewayProviderInput,
  GatewayProviderOutput,
} from "./runner.js";
import type { LogicalToolContext, LogicalToolRunner } from "./tools.js";

export type AiSdkGenerateTextOptions = {
  messages: ModelMessage[];
  model: LanguageModel;
  providerOptions?: Record<string, unknown>;
  stopWhen: ReturnType<typeof stepCountIs>;
  system?: string;
  tools?: ToolSet;
};

export type AiSdkGenerateText = (
  options: AiSdkGenerateTextOptions,
) => Promise<GatewayProviderOutput>;

export type AiSdkGatewayProviderOptions = {
  generateText?: AiSdkGenerateText;
  maxSteps?: number;
  model: LanguageModel;
  providerOptions?: Record<string, unknown>;
  system?: string;
};

export class AiSdkGatewayProvider implements GatewayProvider {
  readonly #generateText: AiSdkGenerateText;
  readonly #maxSteps: number;
  readonly #model: LanguageModel;
  readonly #providerOptions: Record<string, unknown> | undefined;
  readonly #system: string | undefined;

  constructor(options: AiSdkGatewayProviderOptions) {
    this.#generateText = options.generateText ?? (generateText as AiSdkGenerateText);
    this.#maxSteps = options.maxSteps ?? 8;
    this.#model = options.model;
    this.#providerOptions = options.providerOptions;
    this.#system = options.system;
  }

  async generate(input: GatewayProviderInput): Promise<GatewayProviderOutput> {
    const options: AiSdkGenerateTextOptions = {
      messages: input.messages.map(toModelMessage),
      model: this.#model,
      stopWhen: stepCountIs(this.#maxSteps),
      tools: createAiSdkTools({
        context: { sessionId: input.sessionId },
        tools: input.tools,
      }),
    };

    if (this.#providerOptions !== undefined) {
      options.providerOptions = this.#providerOptions;
    }

    if (this.#system !== undefined) {
      options.system = this.#system;
    }

    return this.#generateText(options);
  }
}

export function createAiSdkTools(options: {
  context: LogicalToolContext;
  tools: LogicalToolRunner;
}): ToolSet {
  const entries = options.tools.list().map((definition) => [
    definition.name,
    aiTool({
      description: definition.description,
      execute: (input: unknown) => options.tools.run(definition.name, input, options.context),
      inputSchema: jsonSchema(definition.inputSchema as Parameters<typeof jsonSchema>[0]),
    }),
  ]);

  return Object.fromEntries(entries) as ToolSet;
}

function toModelMessage(message: GatewayMessage): ModelMessage {
  return {
    content: message.content,
    role: message.role,
  } as ModelMessage;
}
