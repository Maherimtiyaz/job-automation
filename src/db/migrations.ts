import type { Db } from "./connection.js";
import { nowIso } from "../domain/time.js";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly up: (db: Db) => void;
}

export const INITIAL_SCHEMA = `
CREATE TABLE companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  website TEXT,
  careers_url TEXT,
  ats_platform TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CONSTRAINT companies_normalized_name_unique UNIQUE (normalized_name)
);

CREATE TABLE jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  source TEXT NOT NULL,
  external_job_id TEXT,
  location TEXT,
  employment_type TEXT,
  workplace_type TEXT NOT NULL DEFAULT 'unknown',
  description TEXT,
  salary_min INTEGER,
  salary_max INTEGER,
  salary_currency TEXT,
  match_score REAL,
  discovered_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CONSTRAINT jobs_dedupe_key_unique UNIQUE (dedupe_key),
  CONSTRAINT jobs_salary_nonnegative CHECK (
    (salary_min IS NULL OR salary_min >= 0) AND (salary_max IS NULL OR salary_max >= 0)
  ),
  CONSTRAINT jobs_salary_range CHECK (
    salary_min IS NULL OR salary_max IS NULL OR salary_min <= salary_max
  ),
  CONSTRAINT jobs_match_score_range CHECK (
    match_score IS NULL OR (match_score >= 0 AND match_score <= 100)
  ),
  CONSTRAINT jobs_workplace_type_valid CHECK (
    workplace_type IN ('remote', 'hybrid', 'onsite', 'unknown')
  ),
  CONSTRAINT jobs_employment_type_valid CHECK (
    employment_type IS NULL OR employment_type IN
      ('FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERNSHIP', 'TEMPORARY', 'OTHER')
  )
);

CREATE TABLE applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  resume_version TEXT,
  started_at TEXT,
  submitted_at TEXT,
  last_updated_at TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL,
  CONSTRAINT applications_job_id_unique UNIQUE (job_id),
  CONSTRAINT applications_status_valid CHECK (
    status IN (
      'DISCOVERED', 'MATCHED', 'REVIEW', 'READY_TO_APPLY', 'IN_PROGRESS',
      'WAITING_FOR_HUMAN', 'APPROVED', 'SUBMITTED', 'FAILED', 'WITHDRAWN',
      'REJECTED', 'INTERVIEW', 'OFFER', 'REJECTED_AFTER_INTERVIEW'
    )
  )
);

CREATE TABLE application_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  previous_status TEXT,
  new_status TEXT,
  message TEXT,
  created_at TEXT NOT NULL,
  CONSTRAINT application_events_type_valid CHECK (
    event_type IN ('CREATED', 'STATUS_CHANGED')
  )
);

CREATE INDEX idx_jobs_company_id ON jobs (company_id);
CREATE INDEX idx_jobs_source ON jobs (source);
CREATE INDEX idx_jobs_match_score ON jobs (match_score);
CREATE INDEX idx_jobs_discovered_at ON jobs (discovered_at);
CREATE INDEX idx_jobs_workplace_type ON jobs (workplace_type);
CREATE UNIQUE INDEX idx_jobs_source_external_id ON jobs (source, external_job_id)
  WHERE external_job_id IS NOT NULL;
CREATE INDEX idx_applications_status ON applications (status);
CREATE INDEX idx_application_events_application_id ON application_events (application_id);
`;

export const REVIEW_AND_LIFECYCLE = `
ALTER TABLE jobs ADD COLUMN review_status TEXT NOT NULL DEFAULT 'NEW'
  CHECK (review_status IN ('NEW', 'SHORTLISTED', 'DISMISSED', 'READY_TO_APPLY'));

CREATE TABLE review_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  previous_status TEXT,
  new_status TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL,
  CONSTRAINT review_events_type_valid CHECK (
    event_type IN ('STATUS_CHANGED')
  )
);

CREATE INDEX idx_jobs_review_status ON jobs (review_status);
CREATE INDEX idx_review_events_job_id ON review_events (job_id);

ALTER TABLE applications RENAME TO applications_old;
ALTER TABLE application_events RENAME TO application_events_old;

CREATE TABLE applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  resume_version TEXT,
  started_at TEXT,
  submitted_at TEXT,
  last_updated_at TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL,
  CONSTRAINT applications_job_id_unique UNIQUE (job_id),
  CONSTRAINT applications_status_valid CHECK (
    status IN (
      'DRAFT', 'IN_PROGRESS', 'WAITING_FOR_HUMAN', 'APPROVED', 'SUBMITTED',
      'FAILED', 'WITHDRAWN', 'REJECTED', 'INTERVIEW', 'OFFER',
      'REJECTED_AFTER_INTERVIEW'
    )
  )
);

INSERT INTO applications (id, job_id, status, resume_version, started_at, submitted_at, last_updated_at, notes, created_at)
SELECT
  id,
  job_id,
  CASE
    WHEN status IN ('DISCOVERED', 'MATCHED', 'REVIEW', 'READY_TO_APPLY') THEN 'DRAFT'
    ELSE status
  END,
  resume_version,
  started_at,
  submitted_at,
  last_updated_at,
  notes,
  created_at
FROM applications_old;

CREATE TABLE application_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  previous_status TEXT,
  new_status TEXT,
  message TEXT,
  created_at TEXT NOT NULL,
  CONSTRAINT application_events_type_valid CHECK (
    event_type IN ('CREATED', 'STATUS_CHANGED')
  )
);

INSERT INTO application_events (id, application_id, event_type, previous_status, new_status, message, created_at)
SELECT id, application_id, event_type, previous_status, new_status, message, created_at
FROM application_events_old;

DROP TABLE application_events_old;
DROP TABLE applications_old;

CREATE INDEX idx_applications_status ON applications (status);
CREATE INDEX idx_application_events_application_id ON application_events (application_id);
`;

export const SCORING_COLUMNS = `
ALTER TABLE jobs ADD COLUMN score_version INTEGER;
ALTER TABLE jobs ADD COLUMN score_total REAL
  CHECK (score_total IS NULL OR (score_total >= 0 AND score_total <= 100));
ALTER TABLE jobs ADD COLUMN score_coverage REAL
  CHECK (score_coverage IS NULL OR (score_coverage >= 0 AND score_coverage <= 1));
ALTER TABLE jobs ADD COLUMN score_confidence TEXT
  CHECK (score_confidence IS NULL OR score_confidence IN ('low', 'medium', 'high'));
ALTER TABLE jobs ADD COLUMN score_recommendation TEXT
  CHECK (
    score_recommendation IS NULL OR score_recommendation IN
      ('HIGHPRIORITY', 'GOODMATCH', 'REVIEW', 'LOW_MATCH')
  );
ALTER TABLE jobs ADD COLUMN score_breakdown TEXT;
ALTER TABLE jobs ADD COLUMN scored_at TEXT;

CREATE INDEX idx_jobs_score_total ON jobs (score_total);
CREATE INDEX idx_jobs_score_recommendation ON jobs (score_recommendation);
`;

export const APPLICATION_TARGET = `
ALTER TABLE applications ADD COLUMN application_url TEXT;
ALTER TABLE applications ADD COLUMN application_url_source TEXT
  CHECK (application_url_source IS NULL OR application_url_source IN ('job_url', 'apply_link'));
ALTER TABLE applications ADD COLUMN application_ats TEXT;
ALTER TABLE applications ADD COLUMN application_resolved_at TEXT;

CREATE INDEX idx_applications_application_url ON applications (application_url);
`;

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "initial_schema",
    up: (db) => {
      db.exec(INITIAL_SCHEMA);
    },
  },
  {
    version: 2,
    name: "job_scoring",
    up: (db) => {
      db.exec(SCORING_COLUMNS);
    },
  },
  {
    version: 3,
    name: "review_and_lifecycle",
    up: (db) => {
      db.exec(REVIEW_AND_LIFECYCLE);
    },
  },
  {
    version: 4,
    name: "application_target",
    up: (db) => {
      db.exec(APPLICATION_TARGET);
    },
  },
];

export const SCHEMA_MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
`;

export function runMigrations(db: Db): readonly number[] {
  db.exec(SCHEMA_MIGRATIONS_TABLE);

  const appliedRows = db
    .prepare("SELECT version FROM schema_migrations")
    .all() as { version: number }[];
  const applied = new Set(appliedRows.map((row) => row.version));

  const ordered = [...MIGRATIONS].sort((left, right) => left.version - right.version);

  const applyMigration = db.transaction((migration: Migration) => {
    migration.up(db);
    db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
      migration.version,
      migration.name,
      nowIso(),
    );
  });

  const newlyApplied: number[] = [];
  for (const migration of ordered) {
    if (applied.has(migration.version)) {
      continue;
    }
    applyMigration(migration);
    newlyApplied.push(migration.version);
  }

  return newlyApplied;
}

export function getLatestSchemaVersion(db: Db): number {
  const row = db
    .prepare("SELECT MAX(version) AS version FROM schema_migrations")
    .get() as { version: number | null } | undefined;
  return row?.version ?? 0;
}
