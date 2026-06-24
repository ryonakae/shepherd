import type { EventRecord } from "@/db/event-store.js";
import type { SessionBindingRecord, SessionBindingStore } from "@/db/session-bindings.js";
import type { DeliveryResult, DeliveryRouter } from "./router.js";

export type SessionDeliveryFanoutResult = DeliveryResult & {
  platform: string;
  targetId: string;
};

const deliverableEventTypes = new Set(["gateway.message", "user.message"]);

export class SessionDeliveryFanout {
  readonly #bindings: SessionBindingStore;
  readonly #router: Pick<DeliveryRouter, "deliver">;

  constructor(options: {
    bindings: SessionBindingStore;
    router: Pick<DeliveryRouter, "deliver">;
  }) {
    this.#bindings = options.bindings;
    this.#router = options.router;
  }

  async deliverEvent(event: EventRecord): Promise<SessionDeliveryFanoutResult[]> {
    if (!deliverableEventTypes.has(event.type)) {
      return [];
    }

    const results: SessionDeliveryFanoutResult[] = [];
    for (const binding of this.#bindings.listForSession(event.sessionId)) {
      if (shouldSkipEcho(event, binding)) {
        continue;
      }

      const targetId = bindingTargetId(binding);
      const result = await this.#router.deliver({
        event,
        platform: binding.platform,
        targetId,
      });
      results.push({
        ...result,
        platform: binding.platform,
        targetId,
      });
    }

    return results;
  }
}

function shouldSkipEcho(event: EventRecord, binding: SessionBindingRecord): boolean {
  if (event.type !== "user.message") {
    return false;
  }

  return eventSourcePlatform(event) === binding.platform;
}

function eventSourcePlatform(event: EventRecord): string | undefined {
  if (typeof event.payload !== "object" || event.payload === null) {
    return undefined;
  }

  const presentation = (event.payload as { presentation?: unknown }).presentation;
  if (typeof presentation !== "object" || presentation === null) {
    return undefined;
  }

  const sourcePlatform = (presentation as { sourcePlatform?: unknown }).sourcePlatform;
  return typeof sourcePlatform === "string" ? sourcePlatform : undefined;
}

function bindingTargetId(binding: SessionBindingRecord): string {
  return `${binding.spaceId}:${binding.threadId}`;
}
