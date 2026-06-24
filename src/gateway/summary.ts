import type { EventStore } from "@/db/event-store.js";
import type { SessionSummaryRecord, SessionSummaryStore } from "@/db/session-summary.js";
import { buildGatewayMessagesFromEvents } from "./context.js";
import type { GatewayProvider } from "./runner.js";
import { LogicalToolRegistry, LogicalToolRunner } from "./tools.js";

export type GatewaySummaryUpdaterOptions = {
  events: EventStore;
  provider: GatewayProvider;
  summaries: SessionSummaryStore;
  thresholdEvents?: number;
  windowEvents?: number;
};

export class GatewaySummaryUpdater {
  readonly #events: EventStore;
  readonly #provider: GatewayProvider;
  readonly #summaries: SessionSummaryStore;
  readonly #thresholdEvents: number;
  readonly #tools: LogicalToolRunner;
  readonly #windowEvents: number;

  constructor(options: GatewaySummaryUpdaterOptions) {
    this.#events = options.events;
    this.#provider = options.provider;
    this.#summaries = options.summaries;
    this.#thresholdEvents = options.thresholdEvents ?? 30;
    this.#windowEvents = options.windowEvents ?? 80;
    this.#tools = new LogicalToolRunner({
      events: options.events,
      policy: { allowedTools: new Set() },
      registry: new LogicalToolRegistry(),
    });
  }

  async maybeUpdate(sessionId: string): Promise<SessionSummaryRecord | undefined> {
    const latestEventId = this.#events.getLatestEventId(sessionId);
    const current = this.#summaries.getSummary(sessionId);
    const summarizedThroughEventId = current?.summarizedThroughEventId ?? 0;
    if (latestEventId - summarizedThroughEventId < this.#thresholdEvents) {
      return undefined;
    }

    const output = await this.#provider.generate({
      messages: [
        {
          content:
            "Update the compact Shepherd session summary. Keep durable user intent, decisions, current work state, open questions, and important Herdr/agent results. Do not include transient logs.",
          role: "system",
        },
        ...buildGatewayMessagesFromEvents(
          this.#events.listRecentEvents(sessionId, this.#windowEvents),
          {
            ...(current?.content ? { summary: current.content } : {}),
          },
        ),
      ],
      sessionId,
      tools: this.#tools,
    });

    const summary = this.#summaries.upsertSummary({
      content: output.text,
      sessionId,
      summarizedThroughEventId: latestEventId,
    });
    this.#events.appendEvent({
      idempotencyKey: `summary:${sessionId}:${latestEventId}`,
      payload: {
        summarizedThroughEventId: latestEventId,
      },
      sessionId,
      type: "summary.updated",
    });

    return summary;
  }
}
