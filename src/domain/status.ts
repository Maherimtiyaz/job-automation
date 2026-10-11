import { z } from "zod";
import { InvalidStatusTransitionError } from "./errors.js";

export const APPLICATION_STATUSES = [
  "DISCOVERED",
  "MATCHED",
  "REVIEW",
  "READY_TO_APPLY",
  "IN_PROGRESS",
  "WAITING_FOR_HUMAN",
  "APPROVED",
  "SUBMITTED",
  "FAILED",
  "WITHDRAWN",
  "REJECTED",
  "INTERVIEW",
  "OFFER",
  "REJECTED_AFTER_INTERVIEW",
] as const;

export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export const ApplicationStatusSchema = z.enum(APPLICATION_STATUSES);

export const APPLICATION_EVENT_TYPES = ["CREATED", "STATUS_CHANGED"] as const;

export type ApplicationEventType = (typeof APPLICATION_EVENT_TYPES)[number];

export const ApplicationEventTypeSchema = z.enum(APPLICATION_EVENT_TYPES);

const TRANSITIONS: Record<ApplicationStatus, readonly ApplicationStatus[]> = {
  DISCOVERED: ["MATCHED"],
  MATCHED: ["REVIEW", "WITHDRAWN"],
  REVIEW: ["READY_TO_APPLY", "WITHDRAWN"],
  READY_TO_APPLY: ["IN_PROGRESS", "WITHDRAWN"],
  IN_PROGRESS: ["WAITING_FOR_HUMAN", "APPROVED", "FAILED", "WITHDRAWN"],
  WAITING_FOR_HUMAN: ["IN_PROGRESS", "WITHDRAWN"],
  APPROVED: ["SUBMITTED", "IN_PROGRESS", "WITHDRAWN"],
  SUBMITTED: ["INTERVIEW", "REJECTED", "FAILED", "WITHDRAWN"],
  FAILED: ["IN_PROGRESS", "READY_TO_APPLY", "WITHDRAWN"],
  WITHDRAWN: ["REVIEW"],
  INTERVIEW: ["OFFER", "REJECTED", "REJECTED_AFTER_INTERVIEW", "WITHDRAWN"],
  OFFER: ["WITHDRAWN"],
  REJECTED: [],
  REJECTED_AFTER_INTERVIEW: [],
};

export function allowedTransitions(from: ApplicationStatus): readonly ApplicationStatus[] {
  return TRANSITIONS[from];
}

export function canTransition(from: ApplicationStatus, to: ApplicationStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: ApplicationStatus, to: ApplicationStatus): void {
  if (!canTransition(from, to)) {
    throw new InvalidStatusTransitionError(from, to);
  }
}
