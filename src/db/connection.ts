import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { runMigrations } from "./migrations.js";

export type Db = BetterSqlite3.Database;

export const MEMORY_DATABASE = ":memory:";

export function openDatabase(databasePath: string): Db {
  const isMemory = databasePath === MEMORY_DATABASE;
  const target = isMemory ? MEMORY_DATABASE : resolve(databasePath);

  if (!isMemory) {
    mkdirSync(dirname(target), { recursive: true });
  }

  const db = new BetterSqlite3(target);
  db.pragma("foreign_keys = ON");
  if (!isMemory) {
    db.pragma("journal_mode = WAL");
  }

  runMigrations(db);
  return db;
}

export function closeDatabase(db: Db): void {
  if (db.open) {
    db.close();
  }
}

export function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string" &&
    (error as { code: string }).code.startsWith("SQLITE_CONSTRAINT")
  );
}
