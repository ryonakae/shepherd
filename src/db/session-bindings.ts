import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type EnsureSessionBindingInput = {
  id?: string;
  messageId?: string;
  metadata?: unknown;
  platform: string;
  sessionId: string;
  spaceId: string;
  threadId: string;
};

export type SessionBindingRecord = {
  createdAt: Date;
  id: string;
  messageId: string | null;
  metadata: unknown;
  platform: string;
  sessionId: string;
  spaceId: string;
  threadId: string;
  updatedAt: Date;
};

type SessionBindingRow = {
  created_at: number;
  id: string;
  message_id: string | null;
  metadata_json: string | null;
  platform: string;
  session_id: string;
  space_id: string | null;
  thread_id: string | null;
  updated_at: number;
};

export class SessionBindingStore {
  readonly #sqlite: DatabaseSync;

  constructor(sqlite: DatabaseSync) {
    this.#sqlite = sqlite;
  }

  ensureBinding(input: EnsureSessionBindingInput): SessionBindingRecord {
    validatePlatformThread(input);

    const existing = this.findByPlatformThread(input.platform, input.spaceId, input.threadId);
    if (existing) {
      return existing;
    }

    const id = input.id ?? randomUUID();
    const now = Date.now();
    this.#sqlite
      .prepare(
        `insert or ignore into session_bindings
          (id, session_id, platform, space_id, thread_id, message_id, metadata_json, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.sessionId,
        input.platform,
        input.spaceId,
        input.threadId,
        input.messageId ?? null,
        input.metadata === undefined ? null : JSON.stringify(input.metadata),
        now,
        now,
      );

    const binding = this.findByPlatformThread(input.platform, input.spaceId, input.threadId);
    if (!binding) {
      throw new Error("Failed to create session binding");
    }

    return binding;
  }

  findByPlatformThread(
    platform: string,
    spaceId: string,
    threadId: string,
  ): SessionBindingRecord | undefined {
    const row = this.#sqlite
      .prepare(
        "select * from session_bindings where platform = ? and space_id = ? and thread_id = ?",
      )
      .get(platform, spaceId, threadId) as SessionBindingRow | undefined;

    return row ? mapBinding(row) : undefined;
  }

  listForSession(sessionId: string): SessionBindingRecord[] {
    const rows = this.#sqlite
      .prepare("select * from session_bindings where session_id = ? order by created_at asc")
      .all(sessionId) as SessionBindingRow[];

    return rows.map(mapBinding);
  }
}

function validatePlatformThread(input: EnsureSessionBindingInput): void {
  if (!input.platform || !input.spaceId || !input.threadId) {
    throw new Error("platform, spaceId, and threadId are required");
  }
}

function mapBinding(row: SessionBindingRow): SessionBindingRecord {
  return {
    createdAt: new Date(row.created_at),
    id: row.id,
    messageId: row.message_id,
    metadata: row.metadata_json === null ? null : JSON.parse(row.metadata_json),
    platform: row.platform,
    sessionId: row.session_id,
    spaceId: row.space_id ?? "",
    threadId: row.thread_id ?? "",
    updatedAt: new Date(row.updated_at),
  };
}
