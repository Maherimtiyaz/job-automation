# AGENTS.md

Durable conventions for the `job-automation` project. Keep this file updated when
architectural decisions change.

## Commands

- `npm run dev` — run the entry point with tsx
- `npm run typecheck` — typecheck `src` (build config) and `src` + `tests` (test config)
- `npm test` — Node.js built-in test runner via `tsx --test` (discovers `**/*.test.ts`)
- `npm run build` — emit `dist/` with `tsc`
- `npm start` — run the compiled `dist/index.js`
- `npm run test:smoke` — opt-in live network smoke test (`tests/sources/live-smoke.ts`); it is a
  script, not a `*.test.ts` file, so `npm test` never runs it. Set `LIVE_SMOKE=1` to execute it.

The compiled entry point is also the CLI:

- `node dist/index.js dashboard` — review queue + application pipeline at a glance
- `node dist/index.js status` (default) — database records + scored-job count + profile gaps
- `node dist/index.js score [--force]` — score jobs whose stored `score_version` is stale, or all with `--force`
- `node dist/index.js profile:init [--force]` — write a starter profile template to `PROFILE_PATH`
- `node dist/index.js companies:init [--force]` — write a starter company registry template to `COMPANIES_PATH`
- `node dist/index.js companies:add --name "Acme" --ats <greenhouse|lever|other> [--board TOKEN] [--website URL] [--careers URL] [--notes TEXT]`
- `node dist/index.js companies:list` / `companies:enable --name X` / `companies:disable --name X`
- `node dist/index.js jobs sources` — list sources and how many enabled companies target each
- `node dist/index.js jobs discover [--source <greenhouse|lever>] [--limit N] [--dry-run] [--company NAME]`
- `node dist/index.js jobs list [--limit N] [--min-score N] [--recommendation R] [--source S] [--company NAME] [--state S]`
- `node dist/index.js jobs show <id>` — job details + stored score breakdown + relevance verdict
- `node dist/index.js jobs review [--limit N] [--min-score N] [--state S] [--include-all]`
- `node dist/index.js jobs shortlist <id> [--reason TEXT]` / `jobs dismiss <id> [--reason TEXT]`
- `node dist/index.js jobs ready <id>` / `jobs reopen <id>` / `jobs review-history <id>`
- `node dist/index.js applications create <jobId> [--resume VERSION] [--notes TEXT]`
- `node dist/index.js applications list [--status S] [--limit N]`
- `node dist/index.js applications show <id>` / `applications status <id> <STATUS> [--message TEXT]`
- `node dist/index.js applications events <id>`
- `node dist/index.js browser inspect-job <jobId> [--headed] [--screenshot [PATH]] [--output PATH] [--timeout MS]`
  — open a job's URL in a read-only browser and report what is on it
- `node dist/index.js browser inspect-url <url> [--headed] [--screenshot [PATH]] [--output PATH] [--timeout MS]`
  — inspect an arbitrary URL with a read-only browser; nothing is filled or submitted

## Architecture

Layers, from outside in:

- `src/config.ts` — Zod-validated environment configuration (`NODE_ENV`, `DATABASE_PATH`,
  `PROFILE_PATH`, `COMPANIES_PATH`, `RELEVANCE_MIN_SCORE`, `RELEVANCE_MIN_ROLE_SCORE`).
- `src/cli.ts` — async command dispatch for the compiled CLI; never holds business logic.
- `src/db/` — SQLite connection, versioned migrations, diagnostics. No domain logic.
- `src/domain/` — pure domain types, Zod schemas, status policy, normalization,
  error classes, time helpers, and scoring types/constants. No SQL, no I/O, no `Date.now()`.
- `src/scoring/` — the deterministic scoring algorithm (`scoreJob.ts`) and the
  DB-backed orchestration (`scoreJobs.ts`). Depends on `src/domain/` types only.
- `src/sources/` — job source adapters. Each adapter talks to one public, documented,
  unauthenticated job feed, normalizes rows into validated `SourceListing` objects, and
  counts invalid rows. Real HTTP enters through `createFetchJson()` (`src/sources/http.ts`),
  which is injectable so tests never hit the network.
- `src/registry/` — the company registry JSON file: which companies to discover, their ATS
  platform, and the board token for that platform.
- `src/profile/` — reading/writing the candidate profile JSON file.
- `src/ingest/` — the ingestion pipeline: fetch listings per enabled company, dedupe,
  upsert, rescore when needed, and produce a summary.
- `src/repositories/` — data access. Accept `unknown` at the boundary, validate with
  the domain schemas, and translate SQLite errors into domain errors.
- `src/browser/` — Playwright-based, strictly read-only page inspection. `urlPolicy.ts`
  (URL validation + network classification, pure), `ats.ts` (ATS detection, pure),
  `inspector.ts` (DOM extraction + page classification), `browserService.ts`
  (`BrowserService` launch/lifecycle/timeouts/screenshots), `report.ts` (printing +
  sanitized JSON). DOM extraction runs inside the page and must remain self-contained
  (it is serialized by Playwright).
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

Statuses: `DRAFT`, `IN_PROGRESS`, `WAITING_FOR_HUMAN`, `APPROVED`, `SUBMITTED`,
`FAILED`, `WITHDRAWN`, `REJECTED`, `INTERVIEW`, `OFFER`, `REJECTED_AFTER_INTERVIEW`.

New applications start in `DRAFT`. Transitions are defined in `src/domain/status.ts`
and enforced by `ApplicationRepository.transitionStatus`. Every accepted transition
writes one `application_events` row in the same transaction; creating an application
writes a `CREATED` event. Rejected transitions write nothing.

Key rules:

- `SUBMITTED` is only reachable from `APPROVED`. Never set it because a form was
  opened or filled — it must represent a real submission.
- `FAILED` recovers back to `IN_PROGRESS`.
- `REJECTED` and `REJECTED_AFTER_INTERVIEW` are terminal.

## Job review / triage

Review state is separate from the application lifecycle. It lives on
`jobs.review_status` (default `NEW`) plus a `review_events` audit table, both added by
migration v3. `src/domain/review.ts` owns `REVIEW_STATUSES` (`NEW`, `SHORTLISTED`,
`DISMISSED`, `READY_TO_APPLY`) and the transition map; `src/repositories/jobReviews.ts`
(`JobReviewRepository`) enforces states and appends `STATUS_CHANGED` events atomically.

Transitions: `NEW` -> `SHORTLISTED` | `DISMISSED` | `READY_TO_APPLY`; `SHORTLISTED` ->
`READY_TO_APPLY` | `DISMISSED` | `NEW`; `DISMISSED` -> `NEW` | `SHORTLISTED`;
`READY_TO_APPLY` -> `SHORTLISTED` | `DISMISSED`. A repeated identical action is an
idempotent no-op and writes no event. Shortlisting a job does not create an
application; create one explicitly with `applications create <jobId>`.

## Migration v3 (`review_and_lifecycle`)

Append-only migration that adds `jobs.review_status`, creates `review_events`, and
rebuilds `applications`/`application_events` to make `applications.status`
lifecycle-only with `DEFAULT 'DRAFT'`:

- Old review-style application statuses are mapped to `DRAFT`:
  `DISCOVERED`/`MATCHED`/`REVIEW`/`READY_TO_APPLY` -> `DRAFT`. All other legacy
  lifecycle statuses are preserved as-is.
- Every legacy `application_events` row is copied verbatim (including old status
  strings like `DISCOVERED`), so history is never rewritten.
- Uses table renames (`applications_old` / `application_events_old`) inside the
  migration transaction; this is foreign-key safe with `PRAGMA foreign_keys = ON`.
- Tests build a v2 database, seed legacy rows, then apply `runMigrations` and assert
  the mapping and preserved history. The migration SQL constants are exported from
  `src/db/migrations.ts` for that test.

## Relevance filter

`src/scoring/relevance.ts` classifies a scored job deterministically:
`classifyRelevance()` returns `RELEVANT` | `POSSIBLE` | `UNLIKELY` | `UNSCORED` plus a
`nearestTargetRole` and human-readable reasons.

- Verdict logic: a `HIGHPRIORITY`/`GOODMATCH` recommendation is RELEVANT; otherwise
  both thresholds must clear for RELEVANT (`scoreTotal >= minScore` and `roleScore >=
  minRoleScore`), exactly one threshold clears for POSSIBLE, neither for UNLIKELY, and
  a job with no stored score is UNSCORED.
- The role score is read from the scored `role` component; the nearest target role is
  computed from the normalized title vs `TARGET_ROLES` via the same token/Jaccard
  matching as scoring. Titles are never dropped for failing a literal keyword — a
  "Senior Backend Engineer" title matches `Backend Engineer` despite lacking
  "Software".
- Policy defaults: `RELEVANCE_MIN_SCORE=55`, `RELEVANCE_MIN_ROLE_SCORE=25` (config,
  CLI `--min-score` overrides the total-score threshold per run). The filter only
  labels jobs; it never deletes or auto-applies.

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
  columns only when a scoring-relevant field actually changes (title, description, location,
  employment type, workplace type), so content changes trigger rescoring via
  `listNeedingScoring(version)`. Salary-only updates do not invalidate a stored score.
  `score_total` is the numeric score; `list({ minScore })` and `list({ recommendation })`
  filter on it.

## Candidate profile

Stored as a local JSON file at `PROFILE_PATH` (default `data/profile.json`), never committed.
Run `npm start -- profile:init` through the CLI (`node dist/index.js profile:init`) to write a
template from `createEmptyProfile()`. The template only fills the four known target roles
(`TARGET_ROLES`, priority 3) and leaves everything else empty — job-discovered data is never
invented here. `src/domain/profile.ts` owns the Zod schema; `src/profile/profileStore.ts`
owns file I/O and surfaces `ProfileNotFoundError` for missing files.

## Company registry

Stored as a local JSON file at `COMPANIES_PATH` (default `data/companies.json`), never
committed. Owned by `src/registry/companyStore.ts`; the file shape is
`{ "version": 1, "companies": [...] }`, validated by `CompanyRegistrySchema`.

Each entry has `name`, optional `website`/`careersUrl`/`notes`, `atsPlatform`
(`greenhouse` | `lever` | `other`), an optional `boardToken` (the Greenhouse board token or
Lever posting site), and `active` (default `true`). `boardToken` is required whenever
`atsPlatform` is not `other`. The registry is the source of truth for discovery; only
`active` companies on a supported platform are fetched. `companies:add` writes the entry
directly to this file. The registry is separate from the `companies` SQL table (which is the
FK target for jobs and holds only name/website/careers_url/ats_platform; board tokens stay
in the JSON file, never in the database).

## Job discovery sources

`src/sources/types.ts` owns `SourceId` (`greenhouse`, `lever`), `SourceListing` (the
normalized row that validation and ingestion depend on), and the `JobSourceAdapter`
interface. Adapters implement `fetchListings({ company, limit })` and return validated
listings plus an `invalid` count and `requestsMade`. They are layered over an injectable
`FetchJson` (`src/sources/http.ts`) that adds an abort timeout and maps network/HTTP/JSON
failures to `SourceHttpError`/`SourceError`; tests inject a fake `FetchJson` so no unit
test hits the network.

- Greenhouse: `GET https://boards-api.greenhouse.io/v1/boards/{boardToken}/jobs?content=true`
  (public, no auth). `content` is HTML (may be double-encoded) and is flattened with
  `stripHtmlToText()`. `workplaceType` is inferred from the location name (`remote` /
  `hybrid` / `unknown`). The feed does not expose an employment type, so it stays `null`.
  Listings dedupe on the Greenhouse job `id`. This endpoint is fetched once — pagination is
  not documented for it, so very large boards may be truncated by the API (known limitation).
- Lever: `GET https://api.lever.co/v0/postings/{site}?mode=json` (public, no auth), looped
  with `skip`/`limit` (page size 100, capped at 25 requests). `categories.commitment` maps
  to an employment type; `workplaceType` or `allLocations` drives the workplace type;
  `descriptionPlain` (fallback `descriptionBodyPlain`) becomes the description. Listings
  dedupe on the Lever posting `id`.

No adapter scrapes proprietary pages, bypasses CAPTCHAs, or sends candidate/personal data.
A company with `atsPlatform: "other"` is never fetched.

## Ingestion

`src/ingest/ingest.ts` runs the pipeline: for each requested source, for each enabled
company, fetch listings (sequential requests with `delayMs`, default 300), classify each
listing, upsert, and score. It never creates applications.

- Dedupe: the listing's external id (`ext:<source>:<externalJobId>`) plus an in-batch
  seen-set. A repeated key in one batch is a `duplicate`; otherwise `JobRepository.upsert`
  inserts or refreshes. In dry-run mode nothing is written (company existence is checked,
  companies are not created).
- Scoring: after an insert, or after an update whose scoring-relevant fields changed, the
  job is scored immediately with the injected profile; a scoring exception increments
  `scoringFailures` and keeps the job. Without a profile, ingestion proceeds unscored.
- Isolation: a failure fetching one company is caught, counted as a `sourceFailure`, and
  does not stop other companies or sources.

Summary invariants (report these in CLI output): `valid = inserted + updated + duplicates`
and `listingsFetched = valid + invalid`.

## Browser inspection

`browser inspect-job <id>` and `browser inspect-url <url>` launch a Playwright Chromium and
inspect a page **read-only**. They never fill fields, never click or submit forms, never
handle authentication, and never touch `applications`/`review_events`.

- URL policy (`src/browser/urlPolicy.ts`): only `http:`/`https:` URLs are accepted. Also
  rejected: malformed URLs, `javascript:`/`data:`/`file:`/`ftp:` schemes, and URLs with
  embedded credentials. Navigation to the final (possibly redirected) URL is re-validated;
  a redirect to a non-HTTP target is an `unsupported_protocol` problem.
- Network classification: `localhost` (loopback + `*.localhost`), `private` (RFC1918 IPv4,
  `fc00::/7`), `link_local` (`169.254/16`, `fe80::/10`, `*.local`), else `public`. Any
  non-public target produces a "only inspect pages you trust" warning; a public-to-private
  redirect is flagged as a possible DNS-rebinding.
- Privacy: field *values* are never read or logged. Password inputs, and inputs whose
  `autocomplete` is `current-password`/`new-password`/`one-time-code`/`cc-*`, are marked
  `sensitive: true` and still described structurally (name, label, required) without any
  data. Hidden inputs are counted (`hiddenFieldCount`) but not listed. Reports and
  screenshots never contain cookies, tokens, headers, or full-page HTML.
- Inspected fields: visible headings, links (with an `applyHint` derived from text/path),
  forms (action, method, submit buttons), and per-field kind/type/name/label/placeholder/
  autocomplete/required/readonly/disabled/sensitive/select-options. Field values are never
  read or reported.
- Page classification: `application_form` when fillable fields exist (reliability `observed`
  at >= 3 fields, otherwise `heuristic`), `job_detail` from apply links + headings, else
  `unknown`. ATS detection matches known hostnames (`greenhouse.io`, `lever.co`,
  `myworkdayjobs.com`, `icims`, `smartrecruiters`, `jazzhr`) and on-page text
  (e.g. "Powered by Greenhouse") and falls back to `UNKNOWN`/`low` when nothing matches.
- Inspection is a read-only side questionnaire: it never updates job scored fields,
  applications, or review events.
- Tests use a local `node:http` fixture server on `127.0.0.1` and a shared `BrowserService`;
  they never visit third-party sites. One test asserts that a full CLI `browser inspect-job`
  run leaves applications and review history unchanged.

## Testing

- Use `node:test` + `node:assert/strict` through `tsx`. Do not add Vitest/Jest.
- Use isolated `:memory:` or temporary-file databases. Never touch the real
  development database. Clean up temp files/directories and close connections.
- Cover validation, deduplication, status transitions, atomic audit events, and
  rollback behavior.
- Source adapters and ingestion are tested with injected stub `FetchJson`/adapter/score
  functions — never real HTTP. `tests/sources/live-smoke.ts` is the opt-in live check
  (run `npm run test:smoke` with `LIVE_SMOKE=1`); it fetches known public sample boards and
  must not require personal data.
