import type { Db } from "../db/connection.js";
import type { CandidateProfile } from "../domain/profile.js";
import type { JobScore, ScorableJob } from "../domain/scoring.js";
import { SCORING_VERSION } from "../domain/scoring.js";
import { nowIso } from "../domain/time.js";
import { CompanyRepository } from "../repositories/companies.js";
import { JobRepository } from "../repositories/jobs.js";
import { scoreJob } from "./scoreJob.js";

export interface ScoreJobsOptions {
  force?: boolean;
  onScored?: (score: JobScore) => void;
}

export interface ScoreJobsResult {
  scored: number;
  total: number;
}

export function scoreJobs(
  db: Db,
  profile: CandidateProfile,
  options: ScoreJobsOptions = {},
): ScoreJobsResult {
  const jobs = new JobRepository(db);
  const companies = new CompanyRepository(db);

  const candidates = options.force ? jobs.list() : jobs.listNeedingScoring(SCORING_VERSION);
  const timestamp = nowIso();

  let scored = 0;
  for (const job of candidates) {
    const company = companies.findById(job.companyId);
    const scorable: ScorableJob = {
      id: job.id,
      title: job.title,
      description: job.description,
      location: job.location,
      workplaceType: job.workplaceType,
      employmentType: job.employmentType,
      companyName: company?.name ?? null,
    };
    const score = scoreJob(scorable, profile, { now: timestamp });
    jobs.updateScore(job.id, score);
    scored += 1;
    options.onScored?.(score);
  }

  return { scored, total: candidates.length };
}
