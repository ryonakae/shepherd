import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  status: text("status", { enum: ["active", "archived"] })
    .notNull()
    .default("active"),
  title: text("title"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const events = sqliteTable(
  "events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    dedupeKey: text("dedupe_key"),
    payloadJson: text("payload_json").notNull(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
  },
  (table) => [uniqueIndex("events_session_dedupe_key_idx").on(table.sessionId, table.dedupeKey)],
);
