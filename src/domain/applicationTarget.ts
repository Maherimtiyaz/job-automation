import { z } from "zod";
import { HttpUrlSchema } from "./normalize.js";

/**
 * Where an application target URL came from.
 *
 * - `job_url`: the job posting itself is the application form.
 * - `apply_link`: the target was resolved by following an Apply link.
 */
export const APPLICATION_TARGET_SOURCES = ["job_url", "apply_link"] as const;

export type ApplicationTargetSource = (typeof APPLICATION_TARGET_SOURCES)[number];

export const ApplicationTargetSourceSchema = z.enum(APPLICATION_TARGET_SOURCES);

/**
 * A resolved application target. `atsPlatform` is the detected ATS name, or
 * `null` when no known ATS was identified.
 */
export const ApplicationTargetSchema = z.object({
  url: HttpUrlSchema,
  source: ApplicationTargetSourceSchema,
  atsPlatform: z.string().trim().min(1).nullish(),
});

export type ApplicationTargetInput = z.infer<typeof ApplicationTargetSchema>;
