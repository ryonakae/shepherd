import type { AgentNotificationCursorStore } from "@/db/agent-notification-cursors.js";
import type { AgentEventRecord } from "@/observability/contracts.js";

export class AgentNotificationService {
  readonly #cursors: AgentNotificationCursorStore;

  constructor(options: { cursors: AgentNotificationCursorStore }) {
    this.#cursors = options.cursors;
  }

  subscribe(input: {
    autoResume: boolean;
    herdrSessionName?: string | null;
    subscriberId: string;
    subscriberKind: string;
    workspaceId?: string | null;
  }) {
    return this.#cursors.subscribe(input);
  }

  pending(input: { limit?: number; subscriptionId: string }): AgentEventRecord[] {
    return this.#cursors.listPending(input);
  }

  ack(input: { eventId: number; subscriptionId: string }): void {
    this.#cursors.ack(input);
  }

  markHiddenContextInjected(input: { eventId: number; subscriptionId: string }): void {
    this.#cursors.markHiddenContextInjected(input);
  }

  markAutoResumed(input: { eventId: number; subscriptionId: string }): void {
    this.#cursors.markAutoResumed(input);
  }
}
