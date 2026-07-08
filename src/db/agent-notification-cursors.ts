import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { type AgentEventStore, mapAgentEvent } from "@/db/agent-events.js";
import type {
  AgentEventRecord,
  AgentNotificationCursorRecord,
  AgentNotificationSubscriptionRecord,
} from "@/observability/contracts.js";

type SubscriptionRow = {
  auto_resume: 0 | 1;
  created_at: number;
  herdr_session_name: string | null;
  id: string;
  subscriber_id: string;
  subscriber_kind: string;
  updated_at: number;
  workspace_id: string | null;
};

type CursorRow = {
  acked_event_id: number;
  auto_resume_event_id: number;
  delivered_event_id: number;
  hidden_context_event_id: number;
  subscription_id: string;
  updated_at: number;
};

type EventRowForCursor = Parameters<typeof mapAgentEvent>[0];

export class AgentNotificationCursorStore {
  readonly #events: AgentEventStore;
  readonly #sqlite: DatabaseSync;

  constructor(options: { events: AgentEventStore; sqlite: DatabaseSync }) {
    this.#events = options.events;
    this.#sqlite = options.sqlite;
  }

  subscribe(input: {
    autoResume: boolean;
    herdrSessionName?: string | null;
    subscriberId: string;
    subscriberKind: string;
    workspaceId?: string | null;
  }): AgentNotificationSubscriptionRecord {
    const existing = this.#findSubscription({
      herdrSessionName: input.herdrSessionName ?? null,
      subscriberId: input.subscriberId,
      workspaceId: input.workspaceId ?? null,
    });
    const now = Date.now();
    if (existing) {
      this.#sqlite
        .prepare(
          "update agent_notification_subscriptions set auto_resume = ?, subscriber_kind = ?, updated_at = ? where id = ?",
        )
        .run(input.autoResume ? 1 : 0, input.subscriberKind, now, existing.id);
      return this.getSubscription(existing.id);
    }

    const id = `ans_${randomUUID()}`;
    this.#sqlite
      .prepare(
        `insert into agent_notification_subscriptions
         (id, subscriber_id, subscriber_kind, herdr_session_name, workspace_id, auto_resume, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.subscriberId,
        input.subscriberKind,
        input.herdrSessionName ?? null,
        input.workspaceId ?? null,
        input.autoResume ? 1 : 0,
        now,
        now,
      );
    this.#sqlite
      .prepare(
        `insert into agent_notification_cursors
         (subscription_id, acked_event_id, delivered_event_id, hidden_context_event_id, auto_resume_event_id, updated_at)
         values (?, 0, 0, 0, 0, ?)`,
      )
      .run(id, now);
    return this.getSubscription(id);
  }

  listPending(input: { limit?: number; subscriptionId: string }): AgentEventRecord[] {
    const subscription = this.getSubscription(input.subscriptionId);
    const cursor = this.getCursor(input.subscriptionId);
    const clauses = ["id > ?"];
    const params: Array<number | string | null> = [cursor.ackedEventId];
    if (subscription.herdrSessionName) {
      clauses.push("herdr_session_name = ?");
      params.push(subscription.herdrSessionName);
    }
    if (subscription.workspaceId) {
      clauses.push("workspace_id = ?");
      params.push(subscription.workspaceId);
    }
    const rows = this.#sqlite
      .prepare(`select * from agent_events where ${clauses.join(" and ")} order by id asc limit ?`)
      .all(...params, input.limit ?? 100) as EventRowForCursor[];
    return rows.map(mapAgentEvent);
  }

  ack(input: { eventId: number; subscriptionId: string }): void {
    this.#updateCursorMax(input.subscriptionId, "acked_event_id", input.eventId);
  }

  markDelivered(input: { eventId: number; subscriptionId: string }): void {
    this.#updateCursorMax(input.subscriptionId, "delivered_event_id", input.eventId);
  }

  markHiddenContextInjected(input: { eventId: number; subscriptionId: string }): void {
    this.#updateCursorMax(input.subscriptionId, "hidden_context_event_id", input.eventId);
  }

  markAutoResumed(input: { eventId: number; subscriptionId: string }): void {
    this.#updateCursorMax(input.subscriptionId, "auto_resume_event_id", input.eventId);
  }

  getSubscription(id: string): AgentNotificationSubscriptionRecord {
    const row = this.#sqlite
      .prepare("select * from agent_notification_subscriptions where id = ?")
      .get(id) as SubscriptionRow | undefined;
    if (!row) throw new Error(`Agent notification subscription not found: ${id}`);
    return mapSubscription(row);
  }

  getCursor(subscriptionId: string): AgentNotificationCursorRecord {
    const row = this.#sqlite
      .prepare("select * from agent_notification_cursors where subscription_id = ?")
      .get(subscriptionId) as CursorRow | undefined;
    if (!row) throw new Error(`Agent notification cursor not found: ${subscriptionId}`);
    return mapCursor(row);
  }

  #findSubscription(input: {
    herdrSessionName: string | null;
    subscriberId: string;
    workspaceId: string | null;
  }): SubscriptionRow | undefined {
    return this.#sqlite
      .prepare(
        `select * from agent_notification_subscriptions
         where subscriber_id = ?
           and ((herdr_session_name is null and ? is null) or herdr_session_name = ?)
           and ((workspace_id is null and ? is null) or workspace_id = ?)`,
      )
      .get(
        input.subscriberId,
        input.herdrSessionName,
        input.herdrSessionName,
        input.workspaceId,
        input.workspaceId,
      ) as SubscriptionRow | undefined;
  }

  #updateCursorMax(subscriptionId: string, column: string, eventId: number): void {
    const now = Date.now();
    this.#sqlite
      .prepare(
        `update agent_notification_cursors set ${column} = max(${column}, ?), updated_at = ? where subscription_id = ?`,
      )
      .run(eventId, now, subscriptionId);
  }
}

function mapSubscription(row: SubscriptionRow): AgentNotificationSubscriptionRecord {
  return {
    autoResume: row.auto_resume === 1,
    createdAt: new Date(row.created_at),
    herdrSessionName: row.herdr_session_name,
    id: row.id,
    subscriberId: row.subscriber_id,
    subscriberKind: row.subscriber_kind,
    updatedAt: new Date(row.updated_at),
    workspaceId: row.workspace_id,
  };
}

function mapCursor(row: CursorRow): AgentNotificationCursorRecord {
  return {
    ackedEventId: row.acked_event_id,
    autoResumeEventId: row.auto_resume_event_id,
    deliveredEventId: row.delivered_event_id,
    hiddenContextEventId: row.hidden_context_event_id,
    subscriptionId: row.subscription_id,
    updatedAt: new Date(row.updated_at),
  };
}
