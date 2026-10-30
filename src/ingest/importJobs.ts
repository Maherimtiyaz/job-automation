import type { Db } from "../db/connection.js";
import { ImportedJobSchema } from "../domain/jobImport.js";
import { buildJobDedupeKey, canonicalizeUrl } from "../domain/normalize.js";
import type { CandidateProfile } from "../domain/profile.js";
import type { JobScore, ScorableJob } from "../domain/scoring.js";
import { SCORING_VERSION } from "../domain/scoring.js";
import { nowIso } from "../domain/time.js";
import { CompanyRepository } from "../repositories/companies.js";
import { JobRepository } from "../repositories/jobs.js";
import { scoreJob } from "../scoring/scoreJob.js";

export interface ImportJobsOptions {
  profile: CandidateProfile | null;
  /** Used when a row does not carry its own `source`. */
  defaultSource?: string;
  dryRun?: boolean;
  scoreJobFn?: typeof scoreJob;
}

export type ImportOutcome = "inserted" | "updated" | "duplicate" | "invalid";

export interface ImportRecord {
  index: number;
  outcome: ImportOutcome;
  company: string | null;
  title: string | null;
  message: string | null;
}

export interface ImportJobsSummary {
  rows: number;
  inserted: number;
  updated: number;
  duplicates: number;
  invalid: number;
  scoringFailures: number;
}

export interface ImportJobsResult {
  summary: ImportJobsSummary;
  records: ImportRecord[];
}

/**
 * Import externally discovered listings (a manual search, a CSV/JSON export,
 * or another agent's store) into the local database. Companies are created on
 * demand and jobs keep the same dedupe/scoring rules as source ingestion.
 *
 * This performs no network I/O. It never creates applications and never
 * submits anything.
 */
export function importJobs(
  db: Db,
  rows: readonly unknown[],
  options: ImportJobsOptions,
): ImportJobsResult {
  const jobs = new JobRepository(db);
  const companies = new CompanyRepository(db);
  const scoreJobFn = options.scoreJobFn ?? scoreJob;

  const summary: ImportJobsSummary = {
    rows: rows.length,
    inserted: 0,
    updated: 0,
    duplicates: 0,
    invalid: 0,
    scoringFailures: 0,
  };
  const records: ImportRecord[] = [];
  const seen = new Set<string>();

  rows.forEach((raw, index) => {
    const parsed = ImportedJobSchema.safeParse(raw);
    if (!parsed.success) {
      summary.invalid += 1;
      records.push({
        index,
        outcome: "invalid",
        company: null,
        title: null,
        message: parsed.error.issues.map((issue) => issue.message).join("; "),
      });
      return;
    }

    const row = parsed.data;
    const source = row.source ?? options.defaultSource ?? "import";
    const dedupeKey = buildJobDedupeKey({
      source,
      externalJobId: row.externalJobId ?? null,
      canonicalUrl: canonicalizeUrl(row.url),
    });

    if (seen.has(dedupeKey)) {
      summary.duplicates += 1;
      records.push({
        index,
        outcome: "duplicate",
        company: row.company,
        title: row.title,
        message: null,
      });
      return;
    }
    seen.add(dedupeKey);

    if (options.dryRun === true) {
      const outcome = jobs.findByDedupeKey(dedupeKey) !== null ? "updated" : "inserted";
      summary[outcome] += 1;
      records.push({
        index,
        outcome,
        company: row.company,
        title: row.title,
        message: "dry run - nothing written",
      });
      return;
    }

    const company = companies.getOrCreate({
      name: row.company,
      website: row.companyWebsite ?? null,
      atsPlatform: null,
    });
    const upsert = jobs.upsert({
      companyId: company.id,
      title: row.title,
      url: row.url,
      source,
      externalJobId: row.externalJobId ?? null,
      location: row.location ?? null,
      employmentType: row.employmentType ?? null,
      workplaceType: row.workplaceType,
      description: row.description ?? null,
      salaryMin: row.salaryMin ?? null,
      salaryMax: row.salaryMax ?? null,
      salaryCurrency: row.salaryCurrency ?? null,
    });

    const outcome = upsert.created ? "inserted" : "updated";
    summary[outcome] += 1;
    records.push({
      index,
      outcome,
      company: company.name,
      title: row.title,
      message: null,
    });

    if (options.profile !== null && upsert.job.scoreVersion !== SCORING_VERSION) {
      try {
        const scorable: ScorableJob = {
          id: upsert.job.id,
          title: upsert.job.title,
          description: upsert.job.description,
          location: upsert.job.location,
          workplaceType: upsert.job.workplaceType,
          employmentType: upsert.job.employmentType,
          companyName: company.name,
        };
        const score: JobScore = scoreJobFn(scorable, options.profile, { now: nowIso() });
        jobs.updateScore(upsert.job.id, score);
      } catch {
        summary.scoringFailures += 1;
      }
    }
  });

  return { summary, records };
}
