import { DatabaseSync } from "node:sqlite";

export function openSqlite(path: string) {
  const sqlite = new DatabaseSync(path);

  return { sqlite };
}
