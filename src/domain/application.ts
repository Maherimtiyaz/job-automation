import { z } from "zod";
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
