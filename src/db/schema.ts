import { integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const agentStatusValues = ["blocked", "done", "idle", "unknown", "working"] as const;

export const herdrSessions = sqliteTable("herdr_sessions", {
  lastScannedAt: integer("last_scanned_at", { mode: "timestamp_ms" }),
  name: text("name").primaryKey(),
  running: integer("running", { mode: "boolean" }).notNull(),
  sessionDir: text("session_dir").notNull(),
  socketPath: text("socket_path").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const herdrWorkspaces = sqliteTable(
  "herdr_workspaces",
  {
    agentStatus: text("agent_status", { enum: agentStatusValues }).notNull(),
    focused: integer("focused", { mode: "boolean" }).notNull(),
    herdrSessionName: text("herdr_session_name")
      .notNull()
      .references(() => herdrSessions.name, { onDelete: "cascade" }),
    label: text("label"),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).notNull(),
    workspaceId: text("workspace_id").notNull(),
  },
  (table) => [
    uniqueIndex("herdr_workspaces_session_workspace_idx").on(
      table.herdrSessionName,
      table.workspaceId,
    ),
  ],
);

export const agents = sqliteTable(
  "agents",
  {
    agent: text("agent"),
    agentSessionJson: text("agent_session_json"),
    agentStatus: text("agent_status", { enum: agentStatusValues }).notNull(),
    cwd: text("cwd"),
    firstSeenAt: integer("first_seen_at", { mode: "timestamp_ms" }).notNull(),
    focused: integer("focused", { mode: "boolean" }).notNull(),
    foregroundCwd: text("foreground_cwd"),
    herdrSessionName: text("herdr_session_name")
      .notNull()
      .references(() => herdrSessions.name, { onDelete: "cascade" }),
    id: text("id").primaryKey(),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).notNull(),
    paneId: text("pane_id").notNull(),
    tabId: text("tab_id"),
    terminalId: text("terminal_id"),
    workspaceId: text("workspace_id").notNull(),
  },
  (table) => [
    uniqueIndex("agents_session_pane_idx").on(table.herdrSessionName, table.paneId),
    uniqueIndex("agents_session_terminal_idx").on(table.herdrSessionName, table.terminalId),
  ],
);

export const agentEvents = sqliteTable(
  "agent_events",
  {
    agentId: text("agent_id").references(() => agents.id, { onDelete: "set null" }),
    compactHistoryJson: text("compact_history_json"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    herdrSessionName: text("herdr_session_name")
      .notNull()
      .references(() => herdrSessions.name, { onDelete: "cascade" }),
    id: integer("id").primaryKey({ autoIncrement: true }),
    idempotencyKey: text("idempotency_key"),
    paneId: text("pane_id"),
    payloadJson: text("payload_json").notNull(),
    terminalId: text("terminal_id"),
    type: text("type").notNull(),
    workspaceId: text("workspace_id"),
  },
  (table) => [
    uniqueIndex("agent_events_session_idempotency_idx").on(
      table.herdrSessionName,
      table.idempotencyKey,
    ),
  ],
);

export const agentOrchestratorScopes = sqliteTable(
  "agent_orchestrator_scopes",
  {
    ackedEventId: integer("acked_event_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    herdrSessionName: text("herdr_session_name")
      .notNull()
      .references(() => herdrSessions.name, { onDelete: "cascade" }),
    ownerPaneId: text("owner_pane_id"),
    ownerTerminalId: text("owner_terminal_id"),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    workspaceId: text("workspace_id").notNull(),
  },
  (table) => [primaryKey({ columns: [table.herdrSessionName, table.workspaceId] })],
);

export const agentHistoryCache = sqliteTable(
  "agent_history_cache",
  {
    compactHistoryJson: text("compact_history_json").notNull(),
    formatterVersion: text("formatter_version").notNull(),
    historyRefJson: text("history_ref_json").notNull(),
    id: integer("id").primaryKey({ autoIncrement: true }),
    sourceMtimeMs: integer("source_mtime_ms").notNull(),
    sourcePath: text("source_path").notNull(),
    sourceSize: integer("source_size").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("agent_history_cache_source_formatter_idx").on(
      table.sourcePath,
      table.formatterVersion,
    ),
  ],
);
