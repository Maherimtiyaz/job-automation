import { z } from "zod";
import { HttpUrlSchema } from "../domain/normalize.js";
import type { EmploymentType, WorkplaceType } from "../domain/job.js";
import { collapseWhitespace, stripHtmlToText } from "./html.js";
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

const LEVER_POSTINGS_URL = "https://api.lever.co/v0/postings";
const PAGE_SIZE = 100;
const MAX_REQUESTS = 25;

const LeverCategorySchema = z.object({
  location: z.string().trim().nullish(),
  commitment: z.string().trim().nullish(),
  department: z.string().trim().nullish(),
  team: z.string().trim().nullish(),
  allLocations: z.array(z.string().trim().nullish()).nullish(),
});

const LeverPostingSchema = z.object({
  id: z.string().trim().min(1),
  text: z.string().trim().min(1),
  categories: LeverCategorySchema.nullish(),
  workplaceType: z.string().trim().nullish(),
  hostedUrl: z.string().nullish(),
  applyUrl: z.string().nullish(),
  descriptionPlain: z.string().nullish(),
  descriptionBodyPlain: z.string().nullish(),
  country: z.string().trim().nullish(),
  additionalPlain: z.string().nullish(),
  createdAt: z.number().int().nullish(),
});

type LeverPosting = z.infer<typeof LeverPostingSchema>;

function mapEmploymentType(raw: string | null | undefined): EmploymentType | null {
  if (!raw) {
    return null;
  }
  const value = raw.toLowerCase().replace(/[^a-z]/g, "");
  if (value.includes("intern")) {
    return "INTERNSHIP";
  }
  if (value.includes("parttime")) {
    return "PART_TIME";
  }
  if (value.includes("contract") || value.includes("freelance")) {
    return "CONTRACT";
  }
  if (value.includes("temporary")) {
    return "TEMPORARY";
  }
  if (value.includes("fulltime")) {
    return "FULL_TIME";
  }
  return null;
}

function inferWorkplaceType(posting: LeverPosting): WorkplaceType {
  const raw = posting.workplaceType?.toLowerCase() ?? "";
  if (/hybrid/.test(raw)) {
    return "hybrid";
  }
  if (/remote/.test(raw)) {
    return "remote";
  }
  if (/onsite|office|-person/.test(raw)) {
    return "onsite";
  }
  const locations = (posting.categories?.allLocations ?? [])
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase();
  if (/hybrid/.test(locations)) {
    return "hybrid";
  }
  if (/remote/.test(locations)) {
    return "remote";
  }
  return "unknown";
}

function listingUrl(posting: LeverPosting, slug: string): string {
  if (posting.hostedUrl && HttpUrlSchema.safeParse(posting.hostedUrl).success) {
    return posting.hostedUrl;
  }
  return `https://jobs.lever.co/${encodeURIComponent(slug)}/${encodeURIComponent(posting.id)}`;
}

function toListing(
  posting: LeverPosting,
  slug: string,
  companyName: string,
): SourceListing {
  const location = posting.categories?.location
    ? stripHtmlToText(posting.categories.location)
    : "";
  const descriptionRaw = posting.descriptionPlain ?? posting.descriptionBodyPlain ?? "";
  const description = descriptionRaw.length > 0 ? collapseWhitespace(descriptionRaw) : null;

  return {
    id: posting.id,
    title: posting.text,
    url: listingUrl(posting, slug),
    description,
    location: location.length > 0 ? location : null,
    employmentType: mapEmploymentType(posting.categories?.commitment),
    workplaceType: inferWorkplaceType(posting),
    companyName,
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
  };
}

export class LeverAdapter implements JobSourceAdapter {
  readonly id = "lever";
  readonly description = "Lever public postings API (api.lever.co/v0/postings)";

  constructor(private readonly fetchJson: FetchJson) {}

  async fetchListings({ company, limit }: FetchListingsInput): Promise<FetchListingsResult> {
    const slug = company.boardToken;
    if (!slug) {
      throw new SourceConfigError(
        `Company "${company.name}" has no Lever posting site configured`,
      );
    }

    const requested = Math.max(0, Math.floor(limit));
    if (requested === 0) {
      return { listings: [], invalid: 0, requestsMade: 0 };
    }

    let skip = 0;
    let requestsMade = 0;
    let invalid = 0;
    const listings: SourceListing[] = [];

    while (listings.length < requested && requestsMade < MAX_REQUESTS) {
      const remaining = requested - listings.length;
      const pageSize = Math.min(PAGE_SIZE, remaining);

      const url = new URL(`${LEVER_POSTINGS_URL}/${encodeURIComponent(slug)}`);
      url.searchParams.set("mode", "json");
      url.searchParams.set("skip", String(skip));
      url.searchParams.set("limit", String(pageSize));

      const payload: unknown = await this.fetchJson(url.toString());
      requestsMade += 1;

      if (!Array.isArray(payload)) {
        throw new SourceError(`Invalid Lever postings payload for site "${slug}"`);
      }

      let pageCount = 0;
      for (const raw of payload) {
        pageCount += 1;
        const posting = LeverPostingSchema.safeParse(raw);
        if (!posting.success) {
          invalid += 1;
          continue;
        }
        const result = SourceListingSchema.safeParse(toListing(posting.data, slug, company.name));
        if (result.success) {
          listings.push(result.data);
        } else {
          invalid += 1;
        }
      }

      if (pageCount === 0 || pageCount < pageSize) {
        break;
      }
      skip += pageCount;
    }

    return { listings, invalid, requestsMade };
  }
}