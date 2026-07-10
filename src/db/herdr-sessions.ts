import type { DatabaseSync } from "node:sqlite";
import type { HerdrSessionRecord } from "@/observability/contracts.js";

export type UpsertRunningHerdrSessionInput = {
  name: string;
  sessionDir: string;
  socketPath: string;
};

type HerdrSessionRow = {
  last_scanned_at: number | null;
  name: string;
  running: 0 | 1;
  session_dir: string;
  socket_path: string;
  updated_at: number;
};

export class HerdrSessionStore {
  readonly #sqlite: DatabaseSync;

  constructor(sqlite: DatabaseSync) {
    this.#sqlite = sqlite;
  }

  upsertRunning(input: UpsertRunningHerdrSessionInput): HerdrSessionRecord {
    const now = Date.now();
    this.#sqlite
      .prepare(
        `insert into herdr_sessions (name, running, session_dir, socket_path, last_scanned_at, updated_at)
         values (?, 1, ?, ?, ?, ?)
         on conflict(name) do update set
           running = 1,
           session_dir = excluded.session_dir,
           socket_path = excluded.socket_path,
           last_scanned_at = excluded.last_scanned_at,
           updated_at = excluded.updated_at`,
      )
      .run(input.name, input.sessionDir, input.socketPath, now, now);
    return this.get(input.name);
  }

  markStoppedMissingFrom(runningNames: string[]): void {
    const now = Date.now();
    if (runningNames.length === 0) {
      this.#sqlite.prepare("update herdr_sessions set running = 0, updated_at = ?").run(now);
      return;
    }
    const placeholders = runningNames.map(() => "?").join(", ");
    this.#sqlite
      .prepare(
        `update herdr_sessions set running = 0, updated_at = ? where name not in (${placeholders})`,
      )
      .run(now, ...runningNames);
  }

  findRunningBySocketPath(socketPath: string): HerdrSessionRecord | undefined {
    const row = this.#sqlite
      .prepare("select * from herdr_sessions where running = 1 and socket_path = ?")
      .get(socketPath) as HerdrSessionRow | undefined;
    return row ? mapHerdrSession(row) : undefined;
  }

  listRunning(): HerdrSessionRecord[] {
    const rows = this.#sqlite
      .prepare("select * from herdr_sessions where running = 1 order by name")
      .all() as HerdrSessionRow[];
    return rows.map(mapHerdrSession);
  }

  list(): HerdrSessionRecord[] {
    const rows = this.#sqlite
      .prepare("select * from herdr_sessions order by name")
      .all() as HerdrSessionRow[];
    return rows.map(mapHerdrSession);
  }

  get(name: string): HerdrSessionRecord {
    const row = this.#sqlite.prepare("select * from herdr_sessions where name = ?").get(name) as
      | HerdrSessionRow
      | undefined;
    if (!row) {
      throw new Error(`Herdr session not found: ${name}`);
    }
    return mapHerdrSession(row);
  }
}

function mapHerdrSession(row: HerdrSessionRow): HerdrSessionRecord {
  return {
    lastScannedAt: row.last_scanned_at === null ? null : new Date(row.last_scanned_at),
    name: row.name,
    running: row.running === 1,
    sessionDir: row.session_dir,
    socketPath: row.socket_path,
    updatedAt: new Date(row.updated_at),
  };
}
