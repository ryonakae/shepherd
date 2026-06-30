import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const workingContexts = sqliteTable(
  "working_contexts",
  {
    id: text("id").primaryKey(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    detectionMetadataJson: text("detection_metadata_json"),
    herdrSessionName: text("herdr_session_name"),
    label: text("label").notNull(),
    path: text("path").notNull(),
    slug: text("slug").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("working_contexts_slug_idx").on(table.slug),
    uniqueIndex("working_contexts_path_idx").on(table.path),
  ],
);

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  metadataJson: text("metadata_json"),
  status: text("status", { enum: ["active", "archived"] })
    .notNull()
    .default("active"),
  title: text("title"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  workingContextId: text("working_context_id").references(() => workingContexts.id, {
    onDelete: "set null",
  }),
});

export const actors = sqliteTable(
  "actors",
  {
    id: text("id").primaryKey(),
    avatarUrl: text("avatar_url"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    displayName: text("display_name").notNull(),
    kind: text("kind", { enum: ["user", "gateway", "worker_agent", "system"] }).notNull(),
    presentationJson: text("presentation_json"),
    sourcePlatform: text("source_platform"),
    sourceUserId: text("source_user_id"),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("actors_source_identity_idx").on(table.sourcePlatform, table.sourceUserId),
  ],
);

export const events = sqliteTable(
  "events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    actorId: text("actor_id").references(() => actors.id, { onDelete: "set null" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    idempotencyKey: text("dedupe_key"),
    payloadJson: text("payload_json").notNull(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
  },
  (table) => [
    uniqueIndex("events_session_idempotency_key_idx").on(table.sessionId, table.idempotencyKey),
  ],
);

export const sessionBindings = sqliteTable(
  "session_bindings",
  {
    id: text("id").primaryKey(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    messageId: text("message_id"),
    metadataJson: text("metadata_json"),
    platform: text("platform").notNull(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    spaceId: text("space_id"),
    threadId: text("thread_id"),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("session_bindings_platform_thread_idx").on(
      table.platform,
      table.spaceId,
      table.threadId,
    ),
  ],
);

export const piTurns = sqliteTable("pi_turns", {
  id: text("id").primaryKey(),
  completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  inputEventIdsJson: text("input_event_ids_json"),
  ownerId: text("owner_id"),
  ownerKind: text("owner_kind", { enum: ["headless_pi", "tui_pi"] }),
  piSessionFile: text("pi_session_file"),
  piSessionId: text("pi_session_id"),
  recoveryJson: text("recovery_json"),
  sessionId: text("session_id")
    .notNull()
    .references(() => sessions.id, { onDelete: "cascade" }),
  source: text("source", { enum: ["extension", "interactive", "rpc"] }),
  startedAt: integer("started_at", { mode: "timestamp_ms" }),
  status: text("status", {
    enum: ["queued", "running", "completed", "failed", "recovery_required"],
  }).notNull(),
  triggeringEventId: integer("triggering_event_id").references(() => events.id, {
    onDelete: "set null",
  }),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const logicalToolCalls = sqliteTable(
  "logical_tool_calls",
  {
    id: text("id").primaryKey(),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    inputJson: text("input_json").notNull(),
    piTurnId: text("pi_turn_id")
      .notNull()
      .references(() => piTurns.id, { onDelete: "cascade" }),
    resultJson: text("result_json"),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["pending", "running", "completed", "failed"] }).notNull(),
    toolName: text("tool_name").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("logical_tool_calls_pi_turn_idempotency_idx").on(
      table.piTurnId,
      table.idempotencyKey,
    ),
  ],
);

export const deliveryReceipts = sqliteTable(
  "delivery_receipts",
  {
    id: text("id").primaryKey(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    eventId: integer("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    failureReason: text("failure_reason"),
    platform: text("platform").notNull(),
    remoteMessageId: text("remote_message_id"),
    status: text("status", {
      enum: ["pending", "sent", "failed", "updated", "skipped"],
    }).notNull(),
    targetId: text("target_id").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("delivery_receipts_event_target_idx").on(
      table.eventId,
      table.platform,
      table.targetId,
    ),
  ],
);

export const herdrBindings = sqliteTable(
  "herdr_bindings",
  {
    id: text("id").primaryKey(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    herdrSessionName: text("herdr_session_name").notNull(),
    metadataJson: text("metadata_json"),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    workspaceId: text("workspace_id").notNull(),
  },
  (table) => [uniqueIndex("herdr_bindings_session_idx").on(table.sessionId)],
);

export const workerAgentBindings = sqliteTable(
  "worker_agent_bindings",
  {
    id: text("id").primaryKey(),
    agentName: text("agent_name").notNull(),
    agentProfile: text("agent_profile").notNull(),
    agentStatus: text("agent_status", {
      enum: ["idle", "working", "blocked", "done", "unknown"],
    }).notNull(),
    bindingHealth: text("binding_health", {
      enum: ["starting", "present", "missing", "error"],
    }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    description: text("description"),
    herdrSessionName: text("herdr_session_name").notNull(),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }),
    lastTask: text("last_task"),
    metadataJson: text("metadata_json"),
    paneId: text("pane_id").notNull(),
    role: text("role", {
      enum: ["implementation", "review", "research", "test", "general"],
    }).notNull(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    tabId: text("tab_id"),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    workspaceId: text("workspace_id").notNull(),
  },
  (table) => [
    uniqueIndex("worker_agent_bindings_identity_idx").on(
      table.sessionId,
      table.workspaceId,
      table.agentName,
    ),
  ],
);

export const sessionSummaries = sqliteTable("session_summaries", {
  sessionId: text("session_id")
    .primaryKey()
    .references(() => sessions.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  summarizedThroughEventId: integer("summarized_through_event_id").notNull().default(0),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});
