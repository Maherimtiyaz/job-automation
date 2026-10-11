import type { Db } from "../db/connection.js";
import { buildJobDedupeKey, canonicalizeUrl } from "../domain/normalize.js";
import type { CandidateProfile } from "../domain/profile.js";
import type { JobScore, ScorableJob } from "../domain/scoring.js";
import { SCORING_VERSION } from "../domain/scoring.js";
import { nowIso } from "../domain/time.js";
import type { CompanyRegistry } from "../registry/companyStore.js";
import { enabledCompaniesForSource } from "../registry/companyStore.js";
import { CompanyRepository } from "../repositories/companies.js";
import { JobRepository } from "../repositories/jobs.js";
import { scoreJob } from "../scoring/scoreJob.js";
import type { SourceRegistry } from "../sources/registry.js";
import { createSourceRegistry } from "../sources/registry.js";
import { SOURCE_IDS, type SourceId } from "../sources/types.js";

export const DEFAULT_INGEST_LIMIT = 100;
export const DEFAULT_INGEST_DELAY_MS = 300;

type ScoreJobFunction = typeof scoreJob;

export interface IngestRecord {
  source: SourceId;
  companyName: string;
  listingId: string;
  title: string;
  outcome: "inserted" | "updated" | "duplicate";
}

export interface IngestOptions {
  registry: CompanyRegistry;
  profile: CandidateProfile | null;
  sources?: readonly SourceId[];
  limit?: number;
  dryRun?: boolean;
  delayMs?: number;
  adapters?: SourceRegistry;
  scoreJobFn?: ScoreJobFunction;
  onRecord?: (record: IngestRecord) => void;
  onSourceError?: (error: unknown, source: SourceId, companyName: string) => void;
}

export interface IngestSummary {
  companies: number;
  listingsFetched: number;
  invalid: number;
  valid: number;
  inserted: number;
  updated: number;
  duplicates: number;
  scoringFailures: number;
  sourceFailures: number;
  requestsMade: number;
}

function createEmptySummary(): IngestSummary {
  return {
    companies: 0,
    listingsFetched: 0,
    invalid: 0,
    valid: 0,
    inserted: 0,
    updated: 0,
    duplicates: 0,
    scoringFailures: 0,
    sourceFailures: 0,
    requestsMade: 0,
  };
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

export async function ingestJobs(db: Db, options: IngestOptions): Promise<IngestSummary> {
  const limit = Math.max(0, Math.floor(options.limit ?? DEFAULT_INGEST_LIMIT));
  const delayMs = Math.max(0, options.delayMs ?? DEFAULT_INGEST_DELAY_MS);
  const sources =
    options.sources && options.sources.length > 0 ? [...options.sources] : [...SOURCE_IDS];
  const adapters = options.adapters ?? createSourceRegistry();
  const scoreJobFn = options.scoreJobFn ?? scoreJob;

  const jobs = new JobRepository(db);
  const companies = new CompanyRepository(db);

  const summary = createEmptySummary();
  const emit = (record: IngestRecord): void => {
    options.onRecord?.(record);
  };

  let firstRequest = true;

  for (const source of sources) {
    const adapter = adapters.get(source);
    const entries = enabledCompaniesForSource(options.registry, source);

    if (!adapter) {
      if (entries.length > 0) {
        summary.sourceFailures += entries.length;
      }
      continue;
    }

    for (const company of entries) {
      summary.companies += 1;
      if (!firstRequest && delayMs > 0) {
        await delay(delayMs);
      }
      firstRequest = false;

      try {
        let dbCompany:
          | ReturnType<CompanyRepository["getOrCreate"]>
          | null = null;
        if (!options.dryRun) {
          dbCompany = companies.getOrCreate({
            name: company.name,
            website: company.website ?? null,
            careersUrl: company.careersUrl ?? null,
            atsPlatform: company.atsPlatform,
          });
        }

        const result = await adapter.fetchListings({ company, limit });
        summary.requestsMade += result.requestsMade;
        summary.listingsFetched += result.listings.length + result.invalid;
        summary.invalid += result.invalid;

        const seen = new Set<string>();
        for (const listing of result.listings) {
          const dedupeKey = buildJobDedupeKey({
            source,
            externalJobId: listing.id,
            canonicalUrl: canonicalizeUrl(listing.url),
          });

          if (seen.has(dedupeKey)) {
            const record: IngestRecord = {
              source,
              companyName: company.name,
              listingId: listing.id,
              title: listing.title,
              outcome: "duplicate",
            };
            summary.duplicates += 1;
            summary.valid += 1;
            emit(record);
            continue;
          }
          seen.add(dedupeKey);

          if (options.dryRun) {
            const existing = jobs.findByDedupeKey(dedupeKey);
            const outcome = existing ? "updated" : "inserted";
            summary[outcome] += 1;
            summary.valid += 1;
            emit({ source, companyName: company.name, listingId: listing.id, title: listing.title, outcome });
            continue;
          }

          const companyRecord = dbCompany;
          if (companyRecord === null) {
            continue;
          }

          const upsertResult = jobs.upsert({
            companyId: companyRecord.id,
            title: listing.title,
            url: listing.url,
            source,
            externalJobId: listing.id,
            location: listing.location ?? null,
            employmentType: listing.employmentType ?? null,
            workplaceType: listing.workplaceType,
            description: listing.description ?? null,
            salaryMin: listing.salaryMin ?? null,
            salaryMax: listing.salaryMax ?? null,
            salaryCurrency: listing.salaryCurrency ?? null,
          });

          const outcome = upsertResult.created ? "inserted" : "updated";
          summary[outcome] += 1;
          summary.valid += 1;
          emit({
            source,
            companyName: company.name,
            listingId: listing.id,
            title: listing.title,
            outcome,
          });

          if (options.profile !== null && upsertResult.job.scoreVersion !== SCORING_VERSION) {
            try {
              const scorable: ScorableJob = {
                id: upsertResult.job.id,
                title: upsertResult.job.title,
                description: upsertResult.job.description,
                location: upsertResult.job.location,
                workplaceType: upsertResult.job.workplaceType,
                employmentType: upsertResult.job.employmentType,
                companyName: company.name,
              };
              const score: JobScore = scoreJobFn(scorable, options.profile, { now: nowIso() });
              jobs.updateScore(upsertResult.job.id, score);
            } catch {
              summary.scoringFailures += 1;
            }
          }
        }
      } catch (error) {
        summary.sourceFailures += 1;
        options.onSourceError?.(error, source, company.name);
      }
    }
  }

  return summary;
}