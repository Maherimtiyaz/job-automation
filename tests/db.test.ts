import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import type { Db } from "../src/db/connection.js";
import { openDatabase } from "../src/db/connection.js";
import {
  getLatestSchemaVersion,
  INITIAL_SCHEMA,
  MIGRATIONS,
  runMigrations,
  SCHEMA_MIGRATIONS_TABLE,
  SCORING_COLUMNS,
} from "../src/db/migrations.js";
import { nowIso } from "../src/domain/time.js";
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
       VALUES (?, 'DRAFT', 't', 't')`,
    ).run(jobId);

    assert.throws(
      () => db.prepare("UPDATE applications SET status = 'BOGUS'").run(),
      /CHECK/i,
    );
  } finally {
    db.close();
  }
});

test("migration v3 maps legacy application statuses and preserves history", () => {
  const db = new Database(":memory:");
  try {
    db.pragma("foreign_keys = ON");
    db.exec(SCHEMA_MIGRATIONS_TABLE);
    db.exec(INITIAL_SCHEMA);
    db.exec(SCORING_COLUMNS);
    for (const migration of MIGRATIONS) {
      if (migration.version > 2) {
        continue;
      }
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        migration.version,
        migration.name,
        nowIso(),
      );
    }

    db.exec(
      "INSERT INTO companies (name, normalized_name, created_at, updated_at) VALUES ('PreserveCo', 'preserveco', 't', 't')",
    );
    db.prepare(
      "INSERT INTO jobs (company_id, title, canonical_url, dedupe_key, source, workplace_type, discovered_at, last_seen_at, created_at, updated_at) VALUES (1, 'Legacy Role', 'https://preserveco.test/1', 'url:https://preserveco.test/1', 'test', 'unknown', 't', 't', 't', 't')",
    ).run();
    const reviewJobId = 1;
    const readyJobId = 2;

    db.prepare(
      "INSERT INTO jobs (company_id, title, canonical_url, dedupe_key, source, workplace_type, discovered_at, last_seen_at, created_at, updated_at) VALUES (1, 'Ready Role', 'https://preserveco.test/2', 'url:https://preserveco.test/2', 'test', 'unknown', 't', 't', 't', 't')",
    ).run();

    db.prepare(
      "INSERT INTO applications (job_id, status, last_updated_at, notes, created_at) VALUES (?, 'REVIEW', 't', 'keep me', 't')",
    ).run(reviewJobId);
    const reviewAppId = Number(
      (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id,
    );
    db.prepare(
      "INSERT INTO application_events (application_id, event_type, previous_status, new_status, message, created_at) VALUES (?, 'STATUS_CHANGED', 'DISCOVERED', 'REVIEW', 'legacy', 't')",
    ).run(reviewAppId);

    db.prepare(
      "INSERT INTO applications (job_id, status, last_updated_at, notes, created_at) VALUES (?, 'SUBMITTED', 't', 'keep me too', 't')",
    ).run(readyJobId);
    const submittedAppId = Number(
      (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id,
    );

    const applied = runMigrations(db);
    const expectedApplied = MIGRATIONS.filter((migration) => migration.version > 2)
      .map((migration) => migration.version)
      .sort((left, right) => left - right);
    assert.deepEqual([...applied], expectedApplied);

    const mapped = db.prepare("SELECT status FROM applications WHERE id = ?").get(reviewAppId) as {
      status: string;
    };
    assert.equal(mapped.status, "DRAFT");
    const preserved = db
      .prepare("SELECT status, notes FROM applications WHERE id = ?")
      .get(submittedAppId) as { status: string; notes: string };
    assert.equal(preserved.status, "SUBMITTED");
    assert.equal(preserved.notes, "keep me too");

    const event = db
      .prepare("SELECT previous_status, new_status FROM application_events WHERE application_id = ?")
      .get(reviewAppId) as { previous_status: string; new_status: string };
    assert.equal(event.previous_status, "DISCOVERED");
    assert.equal(event.new_status, "REVIEW");

    const reviewStatus = db
      .prepare("SELECT review_status FROM jobs WHERE id = ?")
      .get(reviewJobId) as { review_status: string };
    assert.equal(reviewStatus.review_status, "NEW");
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
