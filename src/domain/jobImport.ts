import { z } from "zod";
import { EMPLOYMENT_TYPES, WORKPLACE_TYPES } from "./job.js";
import { HttpUrlSchema } from "./normalize.js";

const ImportedCurrencySchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{3}$/, "salary currency must be a 3-letter ISO code")
  .transform((currency) => currency.toUpperCase());

/**
 * One externally discovered listing. The shape mirrors the fields the
 * Greenhouse/Lever adapters produce so imported jobs score and display the
 * same way.
 */
export const ImportedJobSchema = z
  .object({
    company: z.string().trim().min(1, "company must not be empty"),
    companyWebsite: HttpUrlSchema.nullish(),
    title: z.string().trim().min(1, "title must not be empty"),
    url: HttpUrlSchema,
    source: z.string().trim().min(1).optional(),
    externalJobId: z.string().trim().min(1).nullish(),
    location: z.string().trim().min(1).nullish(),
    description: z.string().nullish(),
    employmentType: z.enum(EMPLOYMENT_TYPES).nullish(),
    workplaceType: z.enum(WORKPLACE_TYPES).default("unknown"),
    salaryMin: z.number().int().nonnegative().nullish(),
    salaryMax: z.number().int().nonnegative().nullish(),
    salaryCurrency: ImportedCurrencySchema.nullish(),
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

export type ImportedJob = z.infer<typeof ImportedJobSchema>;

/**
 * The on-disk import format:
 *
 * ```json
 * { "version": 1, "jobs": [ { "company": "Acme", "title": "...", "url": "..." } ] }
 * ```
 *
 * `jobs` is intentionally `unknown[]` so the importer can report per-row
 * validation failures instead of rejecting the whole file.
 */
export const JobImportFileSchema = z.object({
  version: z.literal(1).optional(),
  jobs: z.array(z.unknown()).min(1, "import file must contain at least one job"),
});

export type JobImportFile = z.infer<typeof JobImportFileSchema>;
