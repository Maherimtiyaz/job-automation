import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Db } from "../src/db/connection.js";
import { openDatabase } from "../src/db/connection.js";
import { getLatestSchemaVersion, MIGRATIONS } from "../src/db/migrations.js";
import { seedCompanyAndJob } from "./support/db.js";

function tableNames(db: Db): Set<string> {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as { name: string }[];
  return new Set(rows.map((row) => row.name));
}

function countRows(db: Db, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  return row.count;
}

test("initializes the full schema in a new database", () => {
  const db = openDatabase(":memory:");
  try {
    const names = tableNames(db);
    for (const expected of [
      "companies",
      "jobs",
      "applications",
      "application_events",
      "schema_migrations",
    ]) {
      assert.ok(names.has(expected), `expected table ${expected}`);
    }
  } finally {
    db.close();
  }
});

test("records the applied migration version", () => {
  const db = openDatabase(":memory:");
  try {
    const expectedVersion = MIGRATIONS.reduce((max, migration) => Math.max(max, migration.version), 0);
    assert.equal(getLatestSchemaVersion(db), expectedVersion);
    assert.equal(countRows(db, "schema_migrations"), MIGRATIONS.length);
  } finally {
    db.close();
  }
});

test("runs migrations once and creates parent directories for file databases", () => {
  const dir = mkdtempSync(join(tmpdir(), "job-automation-db-"));
  try {
    const databasePath = join(dir, "nested", "deeper", "test.db");
    assert.equal(existsSync(join(dir, "nested")), false);

    const first = openDatabase(databasePath);
    assert.equal(countRows(first, "schema_migrations"), MIGRATIONS.length);
    first.close();

    const second = openDatabase(databasePath);
    try {
      assert.equal(countRows(second, "schema_migrations"), MIGRATIONS.length);
    } finally {
      second.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("enforces foreign keys", () => {
  const db = openDatabase(":memory:");
  try {
    assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO jobs (company_id, title, canonical_url, dedupe_key, source, discovered_at, last_seen_at, created_at, updated_at)
             VALUES (999, 'x', 'https://x.test/job', 'url:https://x.test/job', 'test', 't', 't', 't', 't')`,
          )
          .run(),
      /FOREIGN KEY/i,
    );
  } finally {
    db.close();
  }
});

test("cascades deletes from companies to jobs", () => {
  const db = openDatabase(":memory:");
  try {
    const { companyId } = seedCompanyAndJob(db);
    db.prepare("DELETE FROM companies WHERE id = ?").run(companyId);
    assert.equal(countRows(db, "jobs"), 0);
  } finally {
    db.close();
  }
});

test("enforces the application status check constraint", () => {
  const db = openDatabase(":memory:");
  try {
    const { jobId } = seedCompanyAndJob(db);
    db.prepare(
      `INSERT INTO applications (job_id, status, last_updated_at, created_at)
       VALUES (?, 'DISCOVERED', 't', 't')`,
    ).run(jobId);

    assert.throws(
      () => db.prepare("UPDATE applications SET status = 'BOGUS'").run(),
      /CHECK/i,
    );
  } finally {
    db.close();
  }
});

test("rolls back a transaction when a statement fails", () => {
  const db = openDatabase(":memory:");
  try {
    db.prepare(
      "INSERT INTO companies (name, normalized_name, created_at, updated_at) VALUES ('A', 'a', 't', 't')",
    ).run();

    const tx = db.transaction(() => {
      db.prepare(
        "INSERT INTO companies (name, normalized_name, created_at, updated_at) VALUES ('B', 'b', 't', 't')",
      ).run();
      db.prepare(
        "INSERT INTO companies (name, normalized_name, created_at, updated_at) VALUES ('C', 'a', 't', 't')",
      ).run();
    });

    assert.throws(() => tx(), /UNIQUE/i);
    assert.equal(countRows(db, "companies"), 1);
  } finally {
    db.close();
  }
});
