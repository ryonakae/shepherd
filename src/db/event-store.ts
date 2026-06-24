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

export type UpsertActorInput = {
  avatarUrl?: string;
  displayName: string;
  id: string;
  kind: "gateway" | "system" | "user" | "worker_agent";
  presentation?: unknown;
  sourcePlatform?: string;
  sourceUserId?: string;
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

export type ActorRecord = {
  avatarUrl: string | null;
  createdAt: Date;
  displayName: string;
  id: string;
  kind: "gateway" | "system" | "user" | "worker_agent";
  presentation: unknown;
  sourcePlatform: string | null;
  sourceUserId: string | null;
  updatedAt: Date;
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

type ActorRow = {
  avatar_url: string | null;
  created_at: number;
  display_name: string;
  id: string;
  kind: "gateway" | "system" | "user" | "worker_agent";
  presentation_json: string | null;
  source_platform: string | null;
  source_user_id: string | null;
  updated_at: number;
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

  upsertActor(input: UpsertActorInput): ActorRecord {
    const now = Date.now();
    const presentationJson =
      input.presentation === undefined ? null : JSON.stringify(input.presentation);
    this.#sqlite
      .prepare(
        `insert into actors (id, kind, display_name, avatar_url, source_platform, source_user_id, presentation_json, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(id) do update set
           kind = excluded.kind,
           display_name = excluded.display_name,
           avatar_url = excluded.avatar_url,
           source_platform = excluded.source_platform,
           source_user_id = excluded.source_user_id,
           presentation_json = excluded.presentation_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.id,
        input.kind,
        input.displayName,
        input.avatarUrl ?? null,
        input.sourcePlatform ?? null,
        input.sourceUserId ?? null,
        presentationJson,
        now,
        now,
      );

    return this.getActor(input.id);
  }

  getActor(id: string): ActorRecord {
    const row = this.#sqlite.prepare("select * from actors where id = ?").get(id) as
      | ActorRow
      | undefined;
    if (!row) {
      throw new Error(`Actor not found: ${id}`);
    }

    return mapActor(row);
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

  getLatestEventId(sessionId: string): number {
    const row = this.#sqlite
      .prepare("select max(id) as latest_event_id from events where session_id = ?")
      .get(sessionId) as { latest_event_id: number | null } | undefined;

    return row?.latest_event_id ?? 0;
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

function mapActor(row: ActorRow): ActorRecord {
  return {
    avatarUrl: row.avatar_url,
    createdAt: new Date(row.created_at),
    displayName: row.display_name,
    id: row.id,
    kind: row.kind,
    presentation: row.presentation_json === null ? null : JSON.parse(row.presentation_json),
    sourcePlatform: row.source_platform,
    sourceUserId: row.source_user_id,
    updatedAt: new Date(row.updated_at),
  };
}
