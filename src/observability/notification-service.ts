import type {
  NotificationCursorStore,
  NotificationSubscriptionRecord,
} from "@/db/notification-cursors.js";
import type { WorkerEventRecord, WorkerEventStore } from "@/db/worker-events.js";

export class NotificationService {
  readonly #cursors: NotificationCursorStore;
  readonly #workerEvents: WorkerEventStore;

  constructor(options: { cursors: NotificationCursorStore; workerEvents: WorkerEventStore }) {
    this.#cursors = options.cursors;
    this.#workerEvents = options.workerEvents;
  }

  subscribe(input: {
    autoResume: boolean;
    observedWorkspaceId: string;
    subscriberId: string;
    subscriberKind: string;
  }): NotificationSubscriptionRecord {
    return this.#cursors.subscribe(input);
  }

  pending(input: { limit?: number; subscriptionId: string }): WorkerEventRecord[] {
    return this.#cursors.listPending(input);
  }

  markDelivered(input: { eventId: number; subscriptionId: string }): void {
    this.#cursors.markDelivered(input);
  }

  ack(input: { eventId: number; subscriptionId: string }): void {
    this.#cursors.ack(input);
  }

  nextHiddenContextEvents(input: { limit: number; subscriptionId: string }): WorkerEventRecord[] {
    const subscription = this.#cursors.getSubscription(input.subscriptionId);
    const cursor = this.#cursors.getCursor(input.subscriptionId);
    return this.#workerEvents.listAfter({
      afterEventId: Math.max(cursor.ackedEventId, cursor.hiddenContextEventId),
      limit: input.limit,
      observedWorkspaceId: subscription.observedWorkspaceId,
    });
  }

  markHiddenContextInjected(input: { eventId: number; subscriptionId: string }): void {
    this.#cursors.markHiddenContextInjected(input);
  }

  nextAutoResumeEvent(input: { subscriptionId: string }): WorkerEventRecord | undefined {
    const subscription = this.#cursors.getSubscription(input.subscriptionId);
    if (!subscription.autoResume) {
      return undefined;
    }
    const cursor = this.#cursors.getCursor(input.subscriptionId);
    return this.#workerEvents.listAfter({
      afterEventId: Math.max(cursor.ackedEventId, cursor.autoResumeEventId),
      limit: 1,
      observedWorkspaceId: subscription.observedWorkspaceId,
    })[0];
  }

  markAutoResumed(input: { eventId: number; subscriptionId: string }): void {
    this.#cursors.markAutoResumed(input);
  }
}
