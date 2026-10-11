import { z } from "zod";
import type { CompanyRegistryEntry } from "../registry/companyStore.js";
import { HttpUrlSchema } from "../domain/normalize.js";
import { EMPLOYMENT_TYPES, WORKPLACE_TYPES } from "../domain/job.js";

export const SOURCE_IDS = ["greenhouse", "lever"] as const;

export type SourceId = (typeof SOURCE_IDS)[number];

export const SourceIdSchema = z.enum(SOURCE_IDS);

export const SourceListingSchema = z
  .object({
    id: z.string().trim().min(1, "listing id must not be empty"),
    title: z.string().trim().min(1, "listing title must not be empty"),
    url: HttpUrlSchema,
    description: z.string().nullish(),
    location: z.string().trim().min(1).nullish(),
    employmentType: z.enum(EMPLOYMENT_TYPES).nullish(),
    workplaceType: z.enum(WORKPLACE_TYPES).default("unknown"),
    companyName: z.string().trim().min(1, "company name must not be empty"),
    salaryMin: z.number().int().nonnegative().nullish(),
    salaryMax: z.number().int().nonnegative().nullish(),
    salaryCurrency: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{3}$/, "salary currency must be a 3-letter ISO code")
      .transform((currency) => currency.toUpperCase())
      .nullish(),
  })
  .superRefine((listing, ctx) => {
    const min = listing.salaryMin ?? null;
    const max = listing.salaryMax ?? null;
    if (min !== null && max !== null && min > max) {
      ctx.addIssue({
        code: "custom",
        message: "salaryMin must be less than or equal to salaryMax",
        path: ["salaryMin"],
      });
    }
  });

export type SourceListing = z.infer<typeof SourceListingSchema>;

export interface FetchListingsInput {
  company: CompanyRegistryEntry;
  limit: number;
}

export interface FetchListingsResult {
  listings: SourceListing[];
  invalid: number;
  requestsMade: number;
}

export interface JobSourceAdapter {
  readonly id: SourceId;
  readonly description: string;
  fetchListings(input: FetchListingsInput): Promise<FetchListingsResult>;
}

export class SourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceError";
  }
}

export class SourceConfigError extends SourceError {
  constructor(message: string) {
    super(message);
    this.name = "SourceConfigError";
  }
}

export class SourceHttpError extends SourceError {
  readonly status: number;

  constructor(status: number, url: string, detail?: string) {
    super(status === 0 ? `Source request failed: ${url}${detail ? ` (${detail})` : ""}` :
      `Source returned HTTP ${status} for ${url}`);
    this.name = "SourceHttpError";
    this.status = status;
  }
}