import type { Db } from "../db/connection.js";
import { isUniqueConstraintError } from "../db/connection.js";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  validationErrorFromZod,
} from "../domain/errors.js";
import type {
  EmploymentType,
  Job,
  JobFilter,
  Recommendation,
  ScoreConfidence,
  WorkplaceType,
} from "../domain/job.js";
import { JobCreateSchema } from "../domain/job.js";
import {
  buildJobDedupeKey,
  canonicalizeUrl,
  normalizeExternalJobId,
  normalizeSource,
} from "../domain/normalize.js";
import type { JobScore, StoredScoreBreakdown } from "../domain/scoring.js";
import { StoredScoreBreakdownSchema } from "../domain/scoring.js";
import { nowIso } from "../domain/time.js";

interface JobRow {
  id: number;
  company_id: number;
  title: string;
  canonical_url: string;
  source: string;
  external_job_id: string | null;
  location: string | null;
  employment_type: string | null;
  workplace_type: string;
  description: string | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  match_score: number | null;
  score_version: number | null;
  score_total: number | null;
  score_coverage: number | null;
  score_confidence: string | null;
  score_recommendation: string | null;
  score_breakdown: string | null;
  scored_at: string | null;
  discovered_at: string;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
}

interface NormalizedJobInput {
  companyId: number;
  title: string;
  canonicalUrl: string;
  dedupeKey: string;
  source: string;
  externalJobId: string | null;
  location: string | null;
  employmentType: EmploymentType | null;
  workplaceType: WorkplaceType;
  description: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  matchScore: number | null;
}

export interface UpsertJobResult {
  job: Job;
  created: boolean;
}

const INSERT_JOB = `
INSERT INTO jobs (
  company_id, title, canonical_url, dedupe_key, source, external_job_id,
  location, employment_type, workplace_type, description,
  salary_min, salary_max, salary_currency, match_score,
  discovered_at, last_seen_at, created_at, updated_at
) VALUES (
  @companyId, @title, @canonicalUrl, @dedupeKey, @source, @externalJobId,
  @location, @employmentType, @workplaceType, @description,
  @salaryMin, @salaryMax, @salaryCurrency, @matchScore,
  @discoveredAt, @lastSeenAt, @createdAt, @updatedAt
)
`;

const UPDATE_JOB_MUTABLE = `
UPDATE jobs SET
  title = @title,
  location = @location,
  employment_type = @employmentType,
  workplace_type = @workplaceType,
  description = @description,
  salary_min = @salaryMin,
  salary_max = @salaryMax,
  salary_currency = @salaryCurrency,
  match_score = @matchScore,
  score_version = NULL,
  score_total = NULL,
  score_coverage = NULL,
  score_confidence = NULL,
  score_recommendation = NULL,
  score_breakdown = NULL,
  scored_at = NULL,
  last_seen_at = @lastSeenAt,
  updated_at = @updatedAt
WHERE id = @id
`;

const UPDATE_JOB_SCORE = `
UPDATE jobs SET
  score_version = @scoreVersion,
  score_total = @scoreTotal,
  score_coverage = @scoreCoverage,
  score_confidence = @scoreConfidence,
  score_recommendation = @scoreRecommendation,
  score_breakdown = @scoreBreakdown,
  scored_at = @scoredAt
WHERE id = @id
`;

function mapJob(row: JobRow): Job {
  return {
    id: row.id,
    companyId: row.company_id,
    title: row.title,
    canonicalUrl: row.canonical_url,
    source: row.source,
    externalJobId: row.external_job_id,
    location: row.location,
    employmentType: row.employment_type as EmploymentType | null,
    workplaceType: row.workplace_type as WorkplaceType,
    description: row.description,
    salaryMin: row.salary_min,
    salaryMax: row.salary_max,
    salaryCurrency: row.salary_currency,
    matchScore: row.match_score,
    scoreVersion: row.score_version,
    scoreTotal: row.score_total,
    scoreCoverage: row.score_coverage,
    scoreConfidence: row.score_confidence as ScoreConfidence | null,
    scoreRecommendation: row.score_recommendation as Recommendation | null,
    scoreBreakdown: row.score_breakdown,
    scoredAt: row.scored_at,
    discoveredAt: row.discovered_at,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseJobInput(input: unknown): NormalizedJobInput {
  const parsed = JobCreateSchema.safeParse(input);
  if (!parsed.success) {
    throw validationErrorFromZod("Invalid job", parsed.error);
  }

  const data = parsed.data;
  const canonicalUrl = canonicalizeUrl(data.url);
  const source = normalizeSource(data.source);
  const externalJobId = data.externalJobId ? normalizeExternalJobId(data.externalJobId) : null;

  return {
    companyId: data.companyId,
    title: data.title,
    canonicalUrl,
    dedupeKey: buildJobDedupeKey({ source, externalJobId, canonicalUrl }),
    source,
    externalJobId,
    location: data.location ?? null,
    employmentType: data.employmentType ?? null,
    workplaceType: data.workplaceType,
    description: data.description ?? null,
    salaryMin: data.salaryMin ?? null,
    salaryMax: data.salaryMax ?? null,
    salaryCurrency: data.salaryCurrency ?? null,
    matchScore: data.matchScore ?? null,
  };
}

export class JobRepository {
  constructor(private readonly db: Db) {}

  create(input: unknown): Job {
    const data = parseJobInput(input);
    this.assertCompanyExists(data.companyId);

    const timestamp = nowIso();
    try {
      const result = this.db.prepare(INSERT_JOB).run({
        companyId: data.companyId,
        title: data.title,
        canonicalUrl: data.canonicalUrl,
        dedupeKey: data.dedupeKey,
        source: data.source,
        externalJobId: data.externalJobId,
        location: data.location,
        employmentType: data.employmentType,
        workplaceType: data.workplaceType,
        description: data.description,
        salaryMin: data.salaryMin,
        salaryMax: data.salaryMax,
        salaryCurrency: data.salaryCurrency,
        matchScore: data.matchScore,
        discoveredAt: timestamp,
        lastSeenAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      return this.getById(Number(result.lastInsertRowid));
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictError(`Job already exists (dedupe key: ${data.dedupeKey})`);
      }
      throw error;
    }
  }

  upsert(input: unknown): UpsertJobResult {
    const data = parseJobInput(input);
    this.assertCompanyExists(data.companyId);

    const existing = this.findByDedupeKey(data.dedupeKey);
    if (existing) {
      return { job: this.refreshMutableFields(existing.id, data), created: false };
    }

    try {
      return { job: this.create(input), created: true };
    } catch (error) {
      if (error instanceof ConflictError) {
        const concurrent = this.findByDedupeKey(data.dedupeKey);
        if (concurrent) {
          return { job: this.refreshMutableFields(concurrent.id, data), created: false };
        }
      }
      throw error;
    }
  }

  private refreshMutableFields(id: number, data: NormalizedJobInput): Job {
    const timestamp = nowIso();
    this.db.prepare(UPDATE_JOB_MUTABLE).run({
      id,
      title: data.title,
      location: data.location,
      employmentType: data.employmentType,
      workplaceType: data.workplaceType,
      description: data.description,
      salaryMin: data.salaryMin,
      salaryMax: data.salaryMax,
      salaryCurrency: data.salaryCurrency,
      matchScore: data.matchScore,
      lastSeenAt: timestamp,
      updatedAt: timestamp,
    });
    return this.getById(id);
  }

  private assertCompanyExists(companyId: number): void {
    const row = this.db.prepare("SELECT 1 AS present FROM companies WHERE id = ?").get(companyId);
    if (row === undefined) {
      throw new NotFoundError("Company", companyId);
    }
  }

  getById(id: number): Job {
    const found = this.findById(id);
    if (!found) {
      throw new NotFoundError("Job", id);
    }
    return found;
  }

  findById(id: number): Job | null {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
    return row ? mapJob(row) : null;
  }

  findByCanonicalUrl(url: string): Job | null {
    return this.findByDedupeKey(`url:${canonicalizeUrl(url)}`);
  }

  findByDedupeKey(dedupeKey: string): Job | null {
    const row = this.db.prepare("SELECT * FROM jobs WHERE dedupe_key = ?").get(dedupeKey) as
      | JobRow
      | undefined;
    return row ? mapJob(row) : null;
  }

  list(filter: JobFilter = {}): Job[] {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filter.companyId !== undefined) {
      clauses.push("company_id = ?");
      params.push(filter.companyId);
    }
    if (filter.source !== undefined) {
      clauses.push("source = ?");
      params.push(normalizeSource(filter.source));
    }
    if (filter.workplaceType !== undefined) {
      clauses.push("workplace_type = ?");
      params.push(filter.workplaceType);
    }
    if (filter.employmentType !== undefined) {
      clauses.push("employment_type = ?");
      params.push(filter.employmentType);
    }
    if (filter.minMatchScore !== undefined) {
      clauses.push("match_score IS NOT NULL AND match_score >= ?");
      params.push(filter.minMatchScore);
    }
    if (filter.recommendation !== undefined) {
      clauses.push("score_recommendation = ?");
      params.push(filter.recommendation);
    }
    if (filter.minScore !== undefined) {
      clauses.push("score_total IS NOT NULL AND score_total >= ?");
      params.push(filter.minScore);
    }

    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM jobs${where} ORDER BY discovered_at DESC, id DESC`)
      .all(...params) as JobRow[];
    return rows.map(mapJob);
  }

  updateScore(jobId: number, score: JobScore): void {
    const breakdown: StoredScoreBreakdown = {
      components: score.components,
      reasons: score.reasons,
    };
    const result = this.db.prepare(UPDATE_JOB_SCORE).run({
      id: jobId,
      scoreVersion: score.version,
      scoreTotal: score.total,
      scoreCoverage: score.coverage,
      scoreConfidence: score.confidence,
      scoreRecommendation: score.recommendation,
      scoreBreakdown: JSON.stringify(breakdown),
      scoredAt: score.scoredAt,
    });
    if (result.changes === 0) {
      throw new NotFoundError("Job", jobId);
    }
  }

  listNeedingScoring(version: number): Job[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM jobs
         WHERE score_version IS NULL OR score_version <> ?
         ORDER BY discovered_at DESC, id DESC`,
      )
      .all(version) as JobRow[];
    return rows.map(mapJob);
  }

  getScoreBreakdown(jobId: number): StoredScoreBreakdown | null {
    const row = this.db.prepare("SELECT score_breakdown FROM jobs WHERE id = ?").get(jobId) as
      | { score_breakdown: string | null }
      | undefined;
    if (row === undefined) {
      throw new NotFoundError("Job", jobId);
    }
    if (row.score_breakdown === null) {
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(row.score_breakdown);
    } catch {
      throw new ValidationError("Stored score breakdown", ["value is not valid JSON"]);
    }

    const result = StoredScoreBreakdownSchema.safeParse(parsed);
    if (!result.success) {
      throw validationErrorFromZod("Stored score breakdown", result.error);
    }
    return result.data;
  }

  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM jobs").get() as { count: number };
    return row.count;
  }

  countScored(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM jobs WHERE score_total IS NOT NULL")
      .get() as { count: number };
    return row.count;
  }
}
