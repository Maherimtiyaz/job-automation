# AGENTS.md

Durable conventions for the `job-automation` project. Keep this file updated when
architectural decisions change.

## Commands

- `npm run dev` — run the entry point with tsx
- `npm run typecheck` — typecheck `src` (build config) and `src` + `tests` (test config)
- `npm test` — Node.js built-in test runner via `tsx --test` (discovers `**/*.test.ts`)
- `npm run build` — emit `dist/` with `tsc`
- `npm start` — run the compiled `dist/index.js`

The compiled entry point is also the CLI:

- `node dist/index.js status` (default) — database records + scored-job count + profile gaps
- `node dist/index.js score [--force]` — score jobs whose stored `score_version` is stale, or all with `--force`
- `node dist/index.js profile:init [--force]` — write a starter profile template to `PROFILE_PATH`

## Architecture

Layers, from outside in:

- `src/config.ts` — Zod-validated environment configuration (`NODE_ENV`, `DATABASE_PATH`, `PROFILE_PATH`).
- `src/cli.ts` — command dispatch for the compiled CLI; never holds business logic.
- `src/db/` — SQLite connection, versioned migrations, diagnostics. No domain logic.
- `src/domain/` — pure domain types, Zod schemas, status policy, normalization,
  error classes, time helpers, and scoring types/constants. No SQL, no I/O, no `Date.now()`.
- `src/scoring/` — the deterministic scoring algorithm (`scoreJob.ts`) and the
  DB-backed orchestration (`scoreJobs.ts`). Depends on `src/domain/` types only.
- `src/profile/` — reading/writing the candidate profile JSON file.
- `src/repositories/` — data access. Accept `unknown` at the boundary, validate with
  the domain schemas, and translate SQLite errors into domain errors.
- `src/index.ts` — entry point; delegates to `runCli`. Diagnostic only.

Rules:

- Repositories never leak SQL rows to callers; they map rows to domain records.
- Domain code never imports `better-sqlite3`.
- `unknown` is used for untrusted input, never `any`.
- Scoring input timestamps (`referenceDate`) are passed in; `scoreJob` is a pure,
  deterministic function. `scoreJobs` supplies `nowIso()` at call time.

## Database conventions

- Engine: `better-sqlite3`, synchronous, single connection per process.
- `src/db/connection.ts#openDatabase` creates parent directories, enables
  `PRAGMA foreign_keys = ON`, uses WAL for file databases, and runs migrations.
- All timestamps are ISO 8601 UTC strings from `nowIso()` (`Date#toISOString`).
- Foreign keys use `ON DELETE CASCADE` from `companies` -> `jobs` -> `applications`
  -> `application_events`.
- Never store resume PDFs, credentials, or secrets in SQLite.
- Do not commit database files (see `.gitignore`).

## Migration strategy

- Migrations are append-only, ordered by `version`, and tracked in the
  `schema_migrations` table. Do not rely on `CREATE TABLE IF NOT EXISTS` for
  schema evolution.
- Never edit an applied migration. Add a new `Migration` entry to
  `src/db/migrations.ts` with the next version and run it in a transaction.
- Tests open fresh in-memory/temp databases, so all migrations must apply cleanly
  from scratch.

## Application lifecycle

Statuses: `DISCOVERED`, `MATCHED`, `REVIEW`, `READY_TO_APPLY`, `IN_PROGRESS`,
`WAITING_FOR_HUMAN`, `APPROVED`, `SUBMITTED`, `FAILED`, `WITHDRAWN`, `REJECTED`,
`INTERVIEW`, `OFFER`, `REJECTED_AFTER_INTERVIEW`.

Transitions are defined in `src/domain/status.ts` and enforced by
`ApplicationRepository.transitionStatus`. Every accepted transition writes one
`application_events` row in the same transaction; creating an application writes a
`CREATED` event. Rejected transitions write nothing.

Key rules:

- `SUBMITTED` is only reachable from `APPROVED`. Never set it because a form was
  opened or filled — it must represent a real submission.
- `FAILED` has recovery paths back to `IN_PROGRESS` / `READY_TO_APPLY`.
- `REJECTED` and `REJECTED_AFTER_INTERVIEW` are terminal.

## One application per job

`applications.job_id` is `UNIQUE`. A job may only have a single application record
so duplicate or accidental applications cannot be created. Re-applications after a
terminal state are not supported yet; when needed, add a migration that replaces the
uniqueness with a partial index and an active/attempt model rather than editing the
existing constraint.

## Deduplication

`src/domain/normalize.ts` is the single source of truth:

- Company names are lowercased, NFKD-normalized, stripped of punctuation, and
  trimmed of common legal suffixes (`inc`, `llc`, `gmbh`, ...).
- Job URLs are canonicalized: scheme/host lowercased, fragment removed, tracking
  params (`utm_*`, `gclid`, ...) removed, remaining query params sorted, trailing
  slash trimmed.
- A job's identity is `dedupe_key`: `ext:<source>:<externalJobId>` when an external
  id exists, otherwise `url:<canonicalUrl>`. `dedupe_key` is `UNIQUE` and backs
  `JobRepository.upsert`, which refreshes mutable fields instead of inserting
  duplicates.

Limitations: URL deduplication cannot detect the same role posted under multiple
URLs without an external id, and matching titles alone is intentionally never used.
`www.` is not stripped, so `www.` and apex hosts are treated as distinct.

## Scoring

Deterministic, explainable, versioned scoring, defined in `src/domain/scoring.ts`
(types + `SCORING_VERSION`, `SCORE_COMPONENT_WEIGHTS`, `NEUTRAL_COMPONENT_SCORE`) and
implemented in `src/scoring/scoreJob.ts`.

- Components and weights: role `.30`, skills `.30`, experience `.15`, location `.10`,
  employmentType `.10`, other `.05` (posting completeness). Weights sum to 1.0.
- A non-applicable component contributes `NEUTRAL_COMPONENT_SCORE` (50) — there is no
  silent renormalization. `coverage` equals the sum of applicable weights.
- `confidence` derives from coverage: low `< 0.45`, medium `< 0.75`, else high.
- `recommendation` gates: `HIGHPRIORITY` (`>= 80` and coverage `>= 0.6`),
  `GOODMATCH` (`>= 65` and coverage `>= 0.45`), `REVIEW` (`>= 45`), else `LOW_MATCH`.
- Component rules:
  - role: normalized title tokens (developer→engineer, swe→software/engineer,
    seniority stopwords dropped) compared with target-role tokens via Jaccard,
    scaled by target-role priority (1.0/0.9/0.8/0.7/0.6 normalized to the best role present).
  - skills: each profile skill present in title+description scores 34 points, capped at 100.
    Not applicable when the profile has no skills, or when the job has no description and nothing matched.
  - experience: extracted required years vs. total profile years (open-ended roles use the
    supplied reference date). Not applicable when the profile has no work experience or the
    description states no explicit years.
  - location: 100 for remote; otherwise token overlap ratio on the smaller token set.
  - employmentType: 100 when the job type is in `preferredEmploymentTypes`.
  - other: posting completeness (description, location, employment type, company).
- Every component records a human-readable reason with impact
  `positive`/`negative`/`neutral`/`missing`; it is always stored alongside the score.
- Scores persist on `jobs` (v2): `score_version`, `score_total`, `score_coverage`,
  `score_confidence`, `score_recommendation`, `score_breakdown` (JSON of components +
  reasons), `scored_at`. `JobRepository.upsert`/`refreshMutableFields` invalidates these
  columns so content changes trigger rescoring via `listNeedingScoring(version)`.
  `score_total` is the numeric score; `list({ minScore })` and `list({ recommendation })`
  filter on it.

## Candidate profile

Stored as a local JSON file at `PROFILE_PATH` (default `data/profile.json`), never committed.
Run `npm start -- profile:init` through the CLI (`node dist/index.js profile:init`) to write a
template from `createEmptyProfile()`. The template only fills the four known target roles
(`TARGET_ROLES`, priority 3) and leaves everything else empty — job-discovered data is never
invented here. `src/domain/profile.ts` owns the Zod schema; `src/profile/profileStore.ts`
owns file I/O and surfaces `ProfileNotFoundError` for missing files.

## Testing

- Use `node:test` + `node:assert/strict` through `tsx`. Do not add Vitest/Jest.
- Use isolated `:memory:` or temporary-file databases. Never touch the real
  development database. Clean up temp files/directories and close connections.
- Cover validation, deduplication, status transitions, atomic audit events, and
  rollback behavior.
