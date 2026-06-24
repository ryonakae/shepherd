import type { EventStore } from "@/db/event-store.js";
import type { LogicalToolRunner } from "./tools.js";

export type GatewayMessage = {
  content: string;
  role: "system" | "user" | "assistant";
};

export type GatewayTurnInput = {
  messages: GatewayMessage[];
  providerOverride?: GatewayProviderOverride;
  sessionId: string;
};

export type GatewayProviderOverride = {
  model?: string;
  provider?: string;
};

export type GatewayProvider = {
  generate(input: GatewayProviderInput): Promise<GatewayProviderOutput>;
};

export type GatewayProviderInput = {
  messages: GatewayMessage[];
  providerOverride?: GatewayProviderOverride;
  sessionId: string;
  tools: LogicalToolRunner;
};

export type GatewayProviderOutput = {
  text: string;
};

export type GatewaySummaryUpdater = {
  maybeUpdate(sessionId: string): Promise<unknown>;
};

export class GatewayRunner {
  readonly #events: EventStore;
  readonly #provider: GatewayProvider;
  readonly #summaryUpdater: GatewaySummaryUpdater | undefined;
  readonly #tools: LogicalToolRunner;

  constructor(options: {
    events: EventStore;
    provider: GatewayProvider;
    summaryUpdater?: GatewaySummaryUpdater;
    tools: LogicalToolRunner;
  }) {
    this.#events = options.events;
    this.#provider = options.provider;
    this.#summaryUpdater = options.summaryUpdater;
    this.#tools = options.tools;
  }

  async runTurn(input: GatewayTurnInput): Promise<GatewayProviderOutput> {
    const run = this.#events.appendEvent({
      payload: {
        messageCount: input.messages.length,
        ...(input.providerOverride !== undefined
          ? { providerOverride: input.providerOverride }
          : {}),
      },
      sessionId: input.sessionId,
      type: "gateway.run.started",
    });

    try {
      const output = await this.#provider.generate({
        messages: input.messages,
        ...(input.providerOverride !== undefined
          ? { providerOverride: input.providerOverride }
          : {}),
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
      await this.#updateSummary(input.sessionId);
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

  async #updateSummary(sessionId: string): Promise<void> {
    if (!this.#summaryUpdater) {
      return;
    }

    try {
      await this.#summaryUpdater.maybeUpdate(sessionId);
    } catch (error) {
      this.#events.appendEvent({
        payload: {
          message: error instanceof Error ? error.message : String(error),
        },
        sessionId,
        type: "summary.update.failed",
      });
    }
  }
}
