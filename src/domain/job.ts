import { z } from "zod";
import { HttpUrlSchema } from "./normalize.js";

export const EMPLOYMENT_TYPES = [
  "FULL_TIME",
  "PART_TIME",
  "CONTRACT",
  "INTERNSHIP",
  "TEMPORARY",
  "OTHER",
] as const;

export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

export const EmploymentTypeSchema = z.enum(EMPLOYMENT_TYPES);

export const WORKPLACE_TYPES = ["remote", "hybrid", "onsite", "unknown"] as const;

export type WorkplaceType = (typeof WORKPLACE_TYPES)[number];

export const WorkplaceTypeSchema = z.enum(WORKPLACE_TYPES);

export const SCORE_CONFIDENCES = ["low", "medium", "high"] as const;

export type ScoreConfidence = (typeof SCORE_CONFIDENCES)[number];

export const ScoreConfidenceSchema = z.enum(SCORE_CONFIDENCES);

export const RECOMMENDATIONS = ["HIGHPRIORITY", "GOODMATCH", "REVIEW", "LOW_MATCH"] as const;

export type Recommendation = (typeof RECOMMENDATIONS)[number];

export const RecommendationSchema = z.enum(RECOMMENDATIONS);

const SalaryCurrencySchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{3}$/, "salary currency must be a 3-letter ISO code")
  .transform((currency) => currency.toUpperCase());

export const JobCreateSchema = z
  .object({
    companyId: z.number().int().positive(),
    title: z.string().trim().min(1, "job title must not be empty"),
    url: HttpUrlSchema,
    source: z.string().trim().min(1, "source must not be empty"),
    externalJobId: z.string().trim().min(1).nullish(),
    location: z.string().trim().min(1).nullish(),
    employmentType: EmploymentTypeSchema.nullish(),
    workplaceType: WorkplaceTypeSchema.default("unknown"),
    description: z.string().nullish(),
    salaryMin: z.number().int().nonnegative().nullish(),
    salaryMax: z.number().int().nonnegative().nullish(),
    salaryCurrency: SalaryCurrencySchema.nullish(),
    matchScore: z.number().min(0).max(100).nullish(),
  })
  .superRefine((job, ctx) => {
    const min = job.salaryMin ?? null;
    const max = job.salaryMax ?? null;
    if (min !== null && max !== null && min > max) {
      ctx.addIssue({
        code: "custom",
        message: "salaryMin must be less than or equal to salaryMax",
        path: ["salaryMin"],
      });
    }
  });

export type JobCreateInput = z.infer<typeof JobCreateSchema>;

export interface Job {
  id: number;
  companyId: number;
  title: string;
  canonicalUrl: string;
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
  scoreVersion: number | null;
  scoreTotal: number | null;
  scoreCoverage: number | null;
  scoreConfidence: ScoreConfidence | null;
  scoreRecommendation: Recommendation | null;
  scoreBreakdown: string | null;
  scoredAt: string | null;
  discoveredAt: string;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface JobFilter {
  companyId?: number;
  source?: string;
  workplaceType?: WorkplaceType;
  employmentType?: EmploymentType;
  minMatchScore?: number;
  recommendation?: Recommendation;
  minScore?: number;
}
