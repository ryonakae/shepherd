import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const observedWorkspaces = sqliteTable("observed_workspaces", {
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  herdrSessionName: text("herdr_session_name"),
  id: text("id").primaryKey(),
  lastResolvedAt: integer("last_resolved_at", { mode: "timestamp_ms" }),
  liveWorkspaceId: text("live_workspace_id"),
  metadataJson: text("metadata_json").notNull(),
  socketPath: text("socket_path"),
  status: text("status", { enum: ["active", "ambiguous", "missing"] }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const workers = sqliteTable(
  "workers",
  {
    agentName: text("agent_name"),
    agentSessionJson: text("agent_session_json"),
    currentPaneId: text("current_pane_id"),
    currentTabId: text("current_tab_id"),
    currentWorkspaceId: text("current_workspace_id"),
    firstSeenAt: integer("first_seen_at", { mode: "timestamp_ms" }).notNull(),
    id: text("id").primaryKey(),
    identityKind: text("identity_kind", { enum: ["agent_session", "live_pane"] }).notNull(),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).notNull(),
    metadataJson: text("metadata_json").notNull(),
    observedWorkspaceId: text("observed_workspace_id")
      .notNull()
      .references(() => observedWorkspaces.id, { onDelete: "cascade" }),
    runtime: text("runtime"),
    status: text("status", { enum: ["blocked", "done", "idle", "unknown", "working"] }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    workerKey: text("worker_key").notNull(),
  },
  (table) => [
    uniqueIndex("workers_observed_workspace_key_idx").on(
      table.observedWorkspaceId,
      table.workerKey,
    ),
  ],
);

export const workerEvents = sqliteTable(
  "worker_events",
  {
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    id: integer("id").primaryKey({ autoIncrement: true }),
    idempotencyKey: text("idempotency_key"),
    observedWorkspaceId: text("observed_workspace_id")
      .notNull()
      .references(() => observedWorkspaces.id, { onDelete: "cascade" }),
    payloadJson: text("payload_json").notNull(),
    type: text("type").notNull(),
    workerId: text("worker_id").references(() => workers.id, { onDelete: "set null" }),
  },
  (table) => [
    uniqueIndex("worker_events_observed_workspace_idempotency_idx").on(
      table.observedWorkspaceId,
      table.idempotencyKey,
    ),
  ],
);

export const workerSnapshots = sqliteTable("worker_snapshots", {
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  id: integer("id").primaryKey({ autoIncrement: true }),
  observedWorkspaceId: text("observed_workspace_id")
    .notNull()
    .references(() => observedWorkspaces.id, { onDelete: "cascade" }),
  snapshotJson: text("snapshot_json").notNull(),
  workerId: text("worker_id")
    .notNull()
    .references(() => workers.id, { onDelete: "cascade" }),
});

export const notificationSubscriptions = sqliteTable(
  "notification_subscriptions",
  {
    autoResume: integer("auto_resume", { mode: "boolean" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    id: text("id").primaryKey(),
    observedWorkspaceId: text("observed_workspace_id")
      .notNull()
      .references(() => observedWorkspaces.id, { onDelete: "cascade" }),
    subscriberId: text("subscriber_id").notNull(),
    subscriberKind: text("subscriber_kind").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("notification_subscriptions_workspace_subscriber_idx").on(
      table.observedWorkspaceId,
      table.subscriberId,
    ),
  ],
);

export const notificationCursors = sqliteTable("notification_cursors", {
  ackedEventId: integer("acked_event_id").notNull().default(0),
  autoResumeEventId: integer("auto_resume_event_id").notNull().default(0),
  deliveredEventId: integer("delivered_event_id").notNull().default(0),
  hiddenContextEventId: integer("hidden_context_event_id").notNull().default(0),
  subscriptionId: text("subscription_id")
    .primaryKey()
    .references(() => notificationSubscriptions.id, { onDelete: "cascade" }),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});
