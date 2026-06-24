import type { DatabaseSync } from "node:sqlite";

export type SessionSummaryRecord = {
  content: string;
  createdAt: Date;
  sessionId: string;
  summarizedThroughEventId: number;
  updatedAt: Date;
};

type SessionSummaryRow = {
  content: string;
  created_at: number;
  session_id: string;
  summarized_through_event_id: number;
  updated_at: number;
};

export class SessionSummaryStore {
  readonly #sqlite: DatabaseSync;

  constructor(sqlite: DatabaseSync) {
    this.#sqlite = sqlite;
  }

  getSummary(sessionId: string): SessionSummaryRecord | undefined {
    const row = this.#sqlite
      .prepare("select * from session_summaries where session_id = ?")
      .get(sessionId) as SessionSummaryRow | undefined;

    return row ? mapSummary(row) : undefined;
  }

  upsertSummary(input: {
    content: string;
    sessionId: string;
    summarizedThroughEventId: number;
  }): SessionSummaryRecord {
    const now = Date.now();
    this.#sqlite
      .prepare(
        `insert into session_summaries
          (session_id, content, summarized_through_event_id, created_at, updated_at)
         values (?, ?, ?, ?, ?)
         on conflict(session_id) do update set
           content = excluded.content,
           summarized_through_event_id = excluded.summarized_through_event_id,
           updated_at = excluded.updated_at`,
      )
      .run(input.sessionId, input.content, input.summarizedThroughEventId, now, now);

    return this.getSummary(input.sessionId) as SessionSummaryRecord;
  }
}

function mapSummary(row: SessionSummaryRow): SessionSummaryRecord {
  return {
    content: row.content,
    createdAt: new Date(row.created_at),
    sessionId: row.session_id,
    summarizedThroughEventId: row.summarized_through_event_id,
    updatedAt: new Date(row.updated_at),
  };
}
