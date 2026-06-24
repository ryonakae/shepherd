import type { EventStore } from "@/db/event-store.js";
import type { LogicalToolRunner } from "./tools.js";

export type GatewayMessage = {
  content: string;
  role: "system" | "user" | "assistant";
};

export type GatewayTurnInput = {
  messages: GatewayMessage[];
  sessionId: string;
};

export type GatewayProvider = {
  generate(input: GatewayProviderInput): Promise<GatewayProviderOutput>;
};

export type GatewayProviderInput = {
  messages: GatewayMessage[];
  sessionId: string;
  tools: LogicalToolRunner;
};

export type GatewayProviderOutput = {
  text: string;
};

export class GatewayRunner {
  readonly #events: EventStore;
  readonly #provider: GatewayProvider;
  readonly #tools: LogicalToolRunner;

  constructor(options: {
    events: EventStore;
    provider: GatewayProvider;
    tools: LogicalToolRunner;
  }) {
    this.#events = options.events;
    this.#provider = options.provider;
    this.#tools = options.tools;
  }

  async runTurn(input: GatewayTurnInput): Promise<GatewayProviderOutput> {
    const run = this.#events.appendEvent({
      payload: { messageCount: input.messages.length },
      sessionId: input.sessionId,
      type: "gateway.run.started",
    });

    try {
      const output = await this.#provider.generate({
        messages: input.messages,
        sessionId: input.sessionId,
        tools: this.#tools,
      });
      this.#events.appendEvent({
        payload: { runEventId: run.id, text: output.text },
        sessionId: input.sessionId,
        type: "gateway.message",
      });
      this.#events.appendEvent({
        payload: { runEventId: run.id },
        sessionId: input.sessionId,
        type: "gateway.run.completed",
      });
      return output;
    } catch (error) {
      this.#events.appendEvent({
        payload: {
          message: error instanceof Error ? error.message : String(error),
          runEventId: run.id,
        },
        sessionId: input.sessionId,
        type: "gateway.run.failed",
      });
      throw error;
    }
  }
}
