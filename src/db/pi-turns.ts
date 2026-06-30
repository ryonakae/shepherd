import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type PiTurnStatus = "completed" | "failed" | "queued" | "recovery_required" | "running";
export type PiOwnerKind = "headless_pi" | "tui_pi";
export type PiTurnSource = "extension" | "interactive" | "rpc";

export type PiTurnRecord = {
  completedAt: Date | null;
  createdAt: Date;
  id: string;
  inputEventIds: number[];
  ownerId: string | null;
  ownerKind: PiOwnerKind | null;
  piSessionFile: string | null;
  piSessionId: string | null;
  recovery: unknown;
  sessionId: string;
  source: PiTurnSource | null;
  startedAt: Date | null;
  status: PiTurnStatus;
  triggeringEventId: number | null;
  updatedAt: Date;
};

type PiTurnRow = {
  completed_at: number | null;
  created_at: number;
  id: string;
  input_event_ids_json: string | null;
  owner_id: string | null;
  owner_kind: PiOwnerKind | null;
  pi_session_file: string | null;
  pi_session_id: string | null;
  recovery_json: string | null;
  session_id: string;
  source: PiTurnSource | null;
  started_at: number | null;
  status: PiTurnStatus;
  triggering_event_id: number | null;
  updated_at: number;
};

export class PiTurnStore {
  readonly #sqlite: DatabaseSync;

  constructor(sqlite: DatabaseSync) {
    this.#sqlite = sqlite;
  }

  createQueuedTurn(input: {
    id?: string;
    sessionId: string;
    triggeringEventId?: number;
  }): PiTurnRecord {
    const id = input.id ?? randomUUID();
    const now = Date.now();
    this.#sqlite
      .prepare(
        `insert into pi_turns
          (id, session_id, triggering_event_id, status, owner_id, owner_kind, pi_session_id, pi_session_file, source, input_event_ids_json, recovery_json, started_at, completed_at, created_at, updated_at)
         values (?, ?, ?, 'queued', null, null, null, null, null, ?, null, null, null, ?, ?)`,
      )
      .run(id, input.sessionId, input.triggeringEventId ?? null, JSON.stringify([]), now, now);

    return this.getTurn(id);
  }

  createRunningTurn(input: {
    id: string;
    inputEventIds: number[];
    ownerId: string;
    ownerKind: PiOwnerKind;
    piSessionFile: string;
    piSessionId: string;
    sessionId: string;
    source: PiTurnSource;
    triggeringEventId?: number;
  }): PiTurnRecord {
    const now = Date.now();
    this.#sqlite
      .prepare(
        `insert into pi_turns
          (id, session_id, triggering_event_id, status, owner_id, owner_kind, pi_session_id, pi_session_file, source, input_event_ids_json, recovery_json, started_at, completed_at, created_at, updated_at)
         values (?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, null, ?, null, ?, ?)`,
      )
      .run(
        input.id,
        input.sessionId,
        input.triggeringEventId ?? null,
        input.ownerId,
        input.ownerKind,
        input.piSessionId,
        input.piSessionFile,
        input.source,
        JSON.stringify(input.inputEventIds),
        now,
        now,
        now,
      );

    return this.getTurn(input.id);
  }

  claimNextQueuedTurn(sessionId: string): PiTurnRecord | undefined {
    const row = this.#sqlite
      .prepare(
        "select * from pi_turns where session_id = ? and status = 'queued' and not exists (select 1 from pi_turns where session_id = ? and status = 'running') order by created_at asc, id asc limit 1",
      )
      .get(sessionId, sessionId) as PiTurnRow | undefined;

    return row ? mapPiTurn(row) : undefined;
  }

  markRunning(input: {
    id: string;
    inputEventIds: number[];
    ownerId: string;
    ownerKind: PiOwnerKind;
    piSessionFile: string;
    piSessionId: string;
    source: PiTurnSource;
  }): PiTurnRecord {
    const now = Date.now();
    this.#sqlite
      .prepare(
        `update pi_turns
         set status = 'running', owner_id = ?, owner_kind = ?, pi_session_id = ?, pi_session_file = ?, source = ?, input_event_ids_json = ?, started_at = ?, updated_at = ?
         where id = ?`,
      )
      .run(
        input.ownerId,
        input.ownerKind,
        input.piSessionId,
        input.piSessionFile,
        input.source,
        JSON.stringify(input.inputEventIds),
        now,
        now,
        input.id,
      );

    return this.getTurn(input.id);
  }

  markCompletedIfRunning(id: string): { changed: boolean; turn: PiTurnRecord } {
    return this.#markTerminalIfRunning(id, "completed");
  }

  markFailedIfRunning(id: string, error: unknown): { changed: boolean; turn: PiTurnRecord } {
    return this.#markTerminalIfRunning(id, "failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  }

  markRecoveryRequiredForRunning(input: {
    message: string;
    ownerId: string;
    sessionId: string;
  }): PiTurnRecord | undefined {
    const row = this.#sqlite
      .prepare(
        "select * from pi_turns where session_id = ? and owner_id = ? and status = 'running' order by started_at asc, id asc limit 1",
      )
      .get(input.sessionId, input.ownerId) as PiTurnRow | undefined;
    if (!row) {
      return undefined;
    }

    const now = Date.now();
    this.#sqlite
      .prepare(
        "update pi_turns set status = 'recovery_required', recovery_json = ?, updated_at = ? where id = ? and status = 'running'",
      )
      .run(JSON.stringify({ message: input.message }), now, row.id);

    return this.getTurn(row.id);
  }

  getTurn(id: string): PiTurnRecord {
    const row = this.#sqlite.prepare("select * from pi_turns where id = ?").get(id) as
      | PiTurnRow
      | undefined;
    if (!row) {
      throw new Error(`Pi turn not found: ${id}`);
    }

    return mapPiTurn(row);
  }

  findRunningTurn(sessionId: string): PiTurnRecord | undefined {
    const row = this.#sqlite
      .prepare(
        "select * from pi_turns where session_id = ? and status = 'running' order by started_at asc, id asc limit 1",
      )
      .get(sessionId) as PiTurnRow | undefined;

    return row ? mapPiTurn(row) : undefined;
  }

  listTurns(sessionId: string): PiTurnRecord[] {
    const rows = this.#sqlite
      .prepare("select * from pi_turns where session_id = ? order by created_at asc, id asc")
      .all(sessionId) as PiTurnRow[];

    return rows.map(mapPiTurn);
  }

  listRecoverableTurns(): PiTurnRecord[] {
    const rows = this.#sqlite
      .prepare(
        "select * from pi_turns where status in ('queued', 'running') order by created_at asc, id asc",
      )
      .all() as PiTurnRow[];

    return rows.map(mapPiTurn);
  }

  #markTerminalIfRunning(
    id: string,
    status: Extract<PiTurnStatus, "completed" | "failed">,
    recovery?: unknown,
  ): { changed: boolean; turn: PiTurnRecord } {
    const now = Date.now();
    const result = this.#sqlite
      .prepare(
        "update pi_turns set status = ?, completed_at = ?, recovery_json = ?, updated_at = ? where id = ? and status in ('queued', 'running')",
      )
      .run(status, now, recovery === undefined ? null : JSON.stringify(recovery), now, id);

    return { changed: result.changes === 1, turn: this.getTurn(id) };
  }
}

function mapPiTurn(row: PiTurnRow): PiTurnRecord {
  return {
    completedAt: row.completed_at === null ? null : new Date(row.completed_at),
    createdAt: new Date(row.created_at),
    id: row.id,
    inputEventIds: parseInputEventIds(row.input_event_ids_json),
    ownerId: row.owner_id,
    ownerKind: row.owner_kind,
    piSessionFile: row.pi_session_file,
    piSessionId: row.pi_session_id,
    recovery: row.recovery_json === null ? null : JSON.parse(row.recovery_json),
    sessionId: row.session_id,
    source: row.source,
    startedAt: row.started_at === null ? null : new Date(row.started_at),
    status: row.status,
    triggeringEventId: row.triggering_event_id,
    updatedAt: new Date(row.updated_at),
  };
}

function parseInputEventIds(value: string | null): number[] {
  if (!value) {
    return [];
  }
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed)
    ? parsed.filter((item): item is number => typeof item === "number")
    : [];
}
