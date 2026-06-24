import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type CreateSessionInput = {
  id?: string;
  title?: string;
  workingContextId?: string;
};

export type AppendEventInput = {
  actorId?: string;
  idempotencyKey?: string;
  payload: unknown;
  sessionId: string;
  type: string;
};

export type SessionRecord = {
  createdAt: Date;
  id: string;
  status: "active" | "archived";
  title: string | null;
  updatedAt: Date;
  workingContextId: string | null;
};

export type EventRecord = {
  actorId: string | null;
  createdAt: Date;
  id: number;
  idempotencyKey: string | null;
  payload: unknown;
  sessionId: string;
  type: string;
};

type SessionRow = {
  created_at: number;
  id: string;
  status: "active" | "archived";
  title: string | null;
  updated_at: number;
  working_context_id: string | null;
};

type EventRow = {
  actor_id: string | null;
  created_at: number;
  dedupe_key: string | null;
  id: number;
  payload_json: string;
  session_id: string;
  type: string;
};

export class EventStore {
  readonly #sqlite: DatabaseSync;

  constructor(sqlite: DatabaseSync) {
    this.#sqlite = sqlite;
  }

  createSession(input: CreateSessionInput = {}): SessionRecord {
    const id = input.id ?? randomUUID();
    const now = Date.now();

    this.#sqlite
      .prepare(
        "insert into sessions (id, title, status, working_context_id, created_at, updated_at) values (?, ?, 'active', ?, ?, ?)",
      )
      .run(id, input.title ?? null, input.workingContextId ?? null, now, now);

    return this.getSession(id);
  }

  getSession(id: string): SessionRecord {
    const row = this.#sqlite.prepare("select * from sessions where id = ?").get(id) as
      | SessionRow
      | undefined;

    if (!row) {
      throw new Error(`Session not found: ${id}`);
    }

    return mapSession(row);
  }

  appendEvent(input: AppendEventInput): EventRecord {
    const now = Date.now();
    const payloadJson = JSON.stringify(input.payload);

    if (payloadJson === undefined) {
      throw new TypeError("Event payload must be JSON-serializable");
    }

    if (input.idempotencyKey) {
      this.#sqlite
        .prepare(
          "insert or ignore into events (session_id, actor_id, type, payload_json, dedupe_key, created_at) values (?, ?, ?, ?, ?, ?)",
        )
        .run(
          input.sessionId,
          input.actorId ?? null,
          input.type,
          payloadJson,
          input.idempotencyKey,
          now,
        );

      return this.getEventByIdempotencyKey(input.sessionId, input.idempotencyKey);
    }

    const result = this.#sqlite
      .prepare(
        "insert into events (session_id, actor_id, type, payload_json, dedupe_key, created_at) values (?, ?, ?, ?, null, ?)",
      )
      .run(input.sessionId, input.actorId ?? null, input.type, payloadJson, now);

    return this.getEvent(Number(result.lastInsertRowid));
  }

  getEvent(id: number): EventRecord {
    const row = this.#sqlite.prepare("select * from events where id = ?").get(id) as
      | EventRow
      | undefined;

    if (!row) {
      throw new Error(`Event not found: ${id}`);
    }

    return mapEvent(row);
  }

  getEventByIdempotencyKey(sessionId: string, idempotencyKey: string): EventRecord {
    const row = this.#sqlite
      .prepare("select * from events where session_id = ? and dedupe_key = ?")
      .get(sessionId, idempotencyKey) as EventRow | undefined;

    if (!row) {
      throw new Error(`Event not found for idempotency key: ${idempotencyKey}`);
    }

    return mapEvent(row);
  }

  listEvents(sessionId: string, afterEventId = 0, limit = 100): EventRecord[] {
    const rows = this.#sqlite
      .prepare("select * from events where session_id = ? and id > ? order by id asc limit ?")
      .all(sessionId, afterEventId, limit) as EventRow[];

    return rows.map(mapEvent);
  }
}

function mapSession(row: SessionRow): SessionRecord {
  return {
    createdAt: new Date(row.created_at),
    id: row.id,
    status: row.status,
    title: row.title,
    updatedAt: new Date(row.updated_at),
    workingContextId: row.working_context_id,
  };
}

function mapEvent(row: EventRow): EventRecord {
  return {
    actorId: row.actor_id,
    createdAt: new Date(row.created_at),
    id: row.id,
    idempotencyKey: row.dedupe_key,
    payload: JSON.parse(row.payload_json) as unknown,
    sessionId: row.session_id,
    type: row.type,
  };
}
