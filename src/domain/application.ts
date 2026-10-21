import { z } from "zod";
import type { ApplicationTargetSource } from "./applicationTarget.js";
import type { ApplicationEventType, ApplicationStatus } from "./status.js";

export const ApplicationCreateSchema = z.object({
  jobId: z.number().int().positive(),
  resumeVersion: z.string().trim().min(1).nullish(),
  notes: z.string().nullish(),
});

export type ApplicationCreateInput = z.infer<typeof ApplicationCreateSchema>;

export interface Application {
  id: number;
  jobId: number;
  status: ApplicationStatus;
  resumeVersion: string | null;
  startedAt: string | null;
  submittedAt: string | null;
  lastUpdatedAt: string;
  notes: string | null;
  createdAt: string;
  /** Resolved application target URL, or null when not prepared yet. */
  applicationUrl: string | null;
  /** How the target was found: the job URL itself or an Apply link. */
  applicationUrlSource: ApplicationTargetSource | null;
  /** Detected ATS platform for the target, or null when unknown. */
  applicationAts: string | null;
  /** When the target was last resolved (ISO 8601 UTC). */
  applicationResolvedAt: string | null;
}

export interface ApplicationEvent {
  id: number;
  applicationId: number;
  eventType: ApplicationEventType;
  previousStatus: ApplicationStatus | null;
  newStatus: ApplicationStatus | null;
  message: string | null;
  createdAt: string;
}

export interface TransitionOptions {
  message?: string | null;
  resumeVersion?: string | null;
}
