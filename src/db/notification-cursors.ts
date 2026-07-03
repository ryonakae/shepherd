import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { mapWorkerEvent, type WorkerEventRecord } from "@/db/worker-events.js";

export type NotificationSubscriptionRecord = {
  autoResume: boolean;
  createdAt: Date;
  id: string;
  observedWorkspaceId: string;
  subscriberId: string;
  subscriberKind: string;
  updatedAt: Date;
};

export type NotificationCursorRecord = {
  ackedEventId: number;
  autoResumeEventId: number;
  deliveredEventId: number;
  hiddenContextEventId: number;
  subscriptionId: string;
  updatedAt: Date;
};

type NotificationSubscriptionRow = {
  auto_resume: 0 | 1;
  created_at: number;
  id: string;
  observed_workspace_id: string;
  subscriber_id: string;
  subscriber_kind: string;
  updated_at: number;
};

type NotificationCursorRow = {
  acked_event_id: number;
  auto_resume_event_id: number;
  delivered_event_id: number;
  hidden_context_event_id: number;
  subscription_id: string;
  updated_at: number;
};

type WorkerEventRow = Parameters<typeof mapWorkerEvent>[0];

export class NotificationCursorStore {
  readonly #sqlite: DatabaseSync;

  constructor(sqlite: DatabaseSync) {
    this.#sqlite = sqlite;
  }

  subscribe(input: {
    autoResume: boolean;
    observedWorkspaceId: string;
    subscriberId: string;
    subscriberKind: string;
  }): NotificationSubscriptionRecord {
    const existing = this.#findSubscription(input.observedWorkspaceId, input.subscriberId);
    const now = Date.now();
    if (existing) {
      this.#sqlite
        .prepare(
          "update notification_subscriptions set auto_resume = ?, subscriber_kind = ?, updated_at = ? where id = ?",
        )
        .run(input.autoResume ? 1 : 0, input.subscriberKind, now, existing.id);
      return this.#getSubscription(existing.id);
    }

    const id = `ns_${randomUUID()}`;
    this.#sqlite
      .prepare(
        `insert into notification_subscriptions
          (id, observed_workspace_id, subscriber_id, subscriber_kind, auto_resume, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.observedWorkspaceId,
        input.subscriberId,
        input.subscriberKind,
        input.autoResume ? 1 : 0,
        now,
        now,
      );
    this.#sqlite
      .prepare(
        `insert into notification_cursors
          (subscription_id, delivered_event_id, acked_event_id, hidden_context_event_id, auto_resume_event_id, updated_at)
         values (?, 0, 0, 0, 0, ?)`,
      )
      .run(id, now);

    return this.#getSubscription(id);
  }

  markDelivered(input: { eventId: number; subscriptionId: string }): void {
    this.#advanceCursorColumn(input.subscriptionId, "delivered_event_id", input.eventId);
  }

  ack(input: { eventId: number; subscriptionId: string }): void {
    this.#advanceCursorColumn(input.subscriptionId, "acked_event_id", input.eventId);
  }

  listPending(input: { limit?: number; subscriptionId: string }): WorkerEventRecord[] {
    const subscription = this.#getSubscription(input.subscriptionId);
    const cursor = this.getCursor(input.subscriptionId);
    const rows = this.#sqlite
      .prepare(
        `select * from worker_events
         where observed_workspace_id = ? and id > ?
         order by id asc
         limit ?`,
      )
      .all(
        subscription.observedWorkspaceId,
        cursor.ackedEventId,
        input.limit ?? 100,
      ) as WorkerEventRow[];

    return rows.map(mapWorkerEvent);
  }

  getSubscription(id: string): NotificationSubscriptionRecord {
    return this.#getSubscription(id);
  }

  markHiddenContextInjected(input: { eventId: number; subscriptionId: string }): void {
    this.#advanceCursorColumn(input.subscriptionId, "hidden_context_event_id", input.eventId);
  }

  markAutoResumed(input: { eventId: number; subscriptionId: string }): void {
    this.#advanceCursorColumn(input.subscriptionId, "auto_resume_event_id", input.eventId);
  }

  getCursor(subscriptionId: string): NotificationCursorRecord {
    const row = this.#sqlite
      .prepare("select * from notification_cursors where subscription_id = ?")
      .get(subscriptionId) as NotificationCursorRow | undefined;
    if (!row) {
      throw new Error(`Notification cursor not found: ${subscriptionId}`);
    }

    return mapCursor(row);
  }

  #advanceCursorColumn(
    subscriptionId: string,
    column:
      | "acked_event_id"
      | "auto_resume_event_id"
      | "delivered_event_id"
      | "hidden_context_event_id",
    eventId: number,
  ): void {
    const now = Date.now();
    this.#sqlite
      .prepare(
        `update notification_cursors set ${column} = max(${column}, ?), updated_at = ? where subscription_id = ?`,
      )
      .run(eventId, now, subscriptionId);
  }

  #findSubscription(
    observedWorkspaceId: string,
    subscriberId: string,
  ): NotificationSubscriptionRow | undefined {
    return this.#sqlite
      .prepare(
        "select * from notification_subscriptions where observed_workspace_id = ? and subscriber_id = ?",
      )
      .get(observedWorkspaceId, subscriberId) as NotificationSubscriptionRow | undefined;
  }

  #getSubscription(id: string): NotificationSubscriptionRecord {
    const row = this.#sqlite
      .prepare("select * from notification_subscriptions where id = ?")
      .get(id) as NotificationSubscriptionRow | undefined;
    if (!row) {
      throw new Error(`Notification subscription not found: ${id}`);
    }

    return mapSubscription(row);
  }
}

function mapSubscription(row: NotificationSubscriptionRow): NotificationSubscriptionRecord {
  return {
    autoResume: row.auto_resume === 1,
    createdAt: new Date(row.created_at),
    id: row.id,
    observedWorkspaceId: row.observed_workspace_id,
    subscriberId: row.subscriber_id,
    subscriberKind: row.subscriber_kind,
    updatedAt: new Date(row.updated_at),
  };
}

function mapCursor(row: NotificationCursorRow): NotificationCursorRecord {
  return {
    ackedEventId: row.acked_event_id,
    autoResumeEventId: row.auto_resume_event_id,
    deliveredEventId: row.delivered_event_id,
    hiddenContextEventId: row.hidden_context_event_id,
    subscriptionId: row.subscription_id,
    updatedAt: new Date(row.updated_at),
  };
}
