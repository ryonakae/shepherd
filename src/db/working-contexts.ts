import { randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { herdrSessionNameForWorkingContext, slugifyHerdrName } from "@/herdr/naming.js";

export type WorkingContextRecord = {
  createdAt: Date;
  detectionMetadata: unknown;
  herdrSessionName: string | null;
  id: string;
  label: string;
  path: string;
  slug: string;
  updatedAt: Date;
};

export type UpsertWorkingContextInput = {
  detectionMetadata?: unknown;
  id?: string;
  label?: string;
  path: string;
  slug?: string;
};

type WorkingContextRow = {
  created_at: number;
  detection_metadata_json: string | null;
  herdr_session_name: string | null;
  id: string;
  label: string;
  path: string;
  slug: string;
  updated_at: number;
};

export class WorkingContextStore {
  readonly #sqlite: DatabaseSync;

  constructor(sqlite: DatabaseSync) {
    this.#sqlite = sqlite;
  }

  findBySlug(slug: string): WorkingContextRecord | undefined {
    const row = this.#sqlite.prepare("select * from working_contexts where slug = ?").get(slug) as
      | WorkingContextRow
      | undefined;

    return row ? mapWorkingContext(row) : undefined;
  }

  findByPath(path: string): WorkingContextRecord | undefined {
    const resolvedPath = resolve(path);
    const row = this.#sqlite
      .prepare("select * from working_contexts where path = ?")
      .get(resolvedPath) as WorkingContextRow | undefined;

    return row ? mapWorkingContext(row) : undefined;
  }

  listRecent(limit = 20): WorkingContextRecord[] {
    const rows = this.#sqlite
      .prepare("select * from working_contexts order by updated_at desc limit ?")
      .all(limit) as WorkingContextRow[];

    return rows.map(mapWorkingContext);
  }

  upsert(input: UpsertWorkingContextInput): WorkingContextRecord {
    const path = resolve(input.path);
    const label = input.label ?? basename(path);
    const baseSlug = input.slug ?? slugifyHerdrName(label);
    const now = Date.now();
    const existingByPath = this.findByPath(path);
    const id = existingByPath?.id ?? input.id ?? randomUUID();
    const createdAt = existingByPath?.createdAt.getTime() ?? now;
    const slug = this.#allocateSlug(baseSlug, id);

    this.#sqlite
      .prepare(
        `insert into working_contexts
          (id, label, path, slug, herdr_session_name, detection_metadata_json, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(path) do update set
           label = excluded.label,
           slug = excluded.slug,
           herdr_session_name = excluded.herdr_session_name,
           detection_metadata_json = excluded.detection_metadata_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        id,
        label,
        path,
        slug,
        herdrSessionNameForWorkingContext(slug),
        input.detectionMetadata === undefined ? null : JSON.stringify(input.detectionMetadata),
        createdAt,
        now,
      );

    return this.findByPath(path) as WorkingContextRecord;
  }

  #allocateSlug(baseSlug: string, id: string): string {
    const existingBySlug = this.findBySlug(baseSlug);
    if (!existingBySlug || existingBySlug.id === id) {
      return baseSlug;
    }

    return disambiguateSlug(baseSlug, id);
  }
}

function disambiguateSlug(baseSlug: string, id: string): string {
  return `${baseSlug}-${id.slice(0, 8)}`;
}

function mapWorkingContext(row: WorkingContextRow): WorkingContextRecord {
  return {
    createdAt: new Date(row.created_at),
    detectionMetadata:
      row.detection_metadata_json === null ? null : JSON.parse(row.detection_metadata_json),
    herdrSessionName: row.herdr_session_name,
    id: row.id,
    label: row.label,
    path: row.path,
    slug: row.slug,
    updatedAt: new Date(row.updated_at),
  };
}
