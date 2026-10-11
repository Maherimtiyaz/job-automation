import { z } from "zod";
import { HttpUrlSchema } from "../domain/normalize.js";
import type { WorkplaceType } from "../domain/job.js";
import { stripHtmlToText } from "./html.js";
import type { FetchJson } from "./http.js";
import {
  SourceConfigError,
  SourceError,
  SourceListingSchema,
  type FetchListingsInput,
  type FetchListingsResult,
  type JobSourceAdapter,
  type SourceListing,
} from "./types.js";

const GREENHOUSE_JOBS_URL = "https://boards-api.greenhouse.io/v1/boards";

const GreenhouseJobSchema = z.object({
  id: z.number().int(),
  internal_job_id: z.number().int().nullish(),
  title: z.string().trim().min(1),
  location: z.object({ name: z.string().trim().min(1).nullish() }).nullish(),
  absolute_url: z.string().nullish(),
  content: z.string().nullish(),
  updated_at: z.string().nullish(),
  first_published: z.string().nullish(),
});

const GreenhouseJobsPayloadSchema = z.object({
  jobs: z.array(z.unknown()),
});

type GreenhouseJob = z.infer<typeof GreenhouseJobSchema>;

function inferWorkplaceType(locationName: string | null): WorkplaceType {
  if (!locationName) {
    return "unknown";
  }
  if (/hybrid/i.test(locationName)) {
    return "hybrid";
  }
  if (/remote/i.test(locationName)) {
    return "remote";
  }
  return "unknown";
}

function listingUrl(job: GreenhouseJob, boardToken: string): string {
  if (job.absolute_url && HttpUrlSchema.safeParse(job.absolute_url).success) {
    return job.absolute_url;
  }
  return `https://boards.greenhouse.io/${encodeURIComponent(boardToken)}/jobs/${job.id}`;
}

function toListing(job: GreenhouseJob, boardToken: string, companyName: string): SourceListing {
  const locationName = job.location?.name && job.location.name.length > 0
    ? stripHtmlToText(job.location.name)
    : null;
  const content = job.content ? stripHtmlToText(job.content) : "";
  const description = content.length > 0 ? content : null;

  return {
    id: String(job.id),
    title: job.title,
    url: listingUrl(job, boardToken),
    description,
    location: locationName,
    employmentType: null,
    workplaceType: inferWorkplaceType(locationName),
    companyName,
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
  };
}

export class GreenhouseAdapter implements JobSourceAdapter {
  readonly id = "greenhouse";
  readonly description = "Greenhouse public job board API (boards-api.greenhouse.io)";

  constructor(private readonly fetchJson: FetchJson) {}

  async fetchListings({ company, limit }: FetchListingsInput): Promise<FetchListingsResult> {
    const boardToken = company.boardToken;
    if (!boardToken) {
      throw new SourceConfigError(
        `Company "${company.name}" has no Greenhouse board token configured`,
      );
    }

    const url = new URL(`${GREENHOUSE_JOBS_URL}/${encodeURIComponent(boardToken)}/jobs`);
    url.searchParams.set("content", "true");

    const payload: unknown = await this.fetchJson(url.toString());
    const parsed = GreenhouseJobsPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      throw new SourceError(`Invalid Greenhouse payload for board "${boardToken}"`);
    }

    const jobs = parsed.data.jobs.slice(0, Math.max(0, limit));

    let invalid = 0;
    const listings: SourceListing[] = [];
    for (const raw of jobs) {
      const job = GreenhouseJobSchema.safeParse(raw);
      if (!job.success) {
        invalid += 1;
        continue;
      }
      const result = SourceListingSchema.safeParse(toListing(job.data, boardToken, company.name));
      if (result.success) {
        listings.push(result.data);
      } else {
        invalid += 1;
      }
    }

    return { listings, invalid, requestsMade: 1 };
  }
}