import { z } from "zod";
import { InvalidStatusTransitionError } from "./errors.js";

export const REVIEW_STATUSES = [
  "NEW",
  "SHORTLISTED",
  "DISMISSED",
  "READY_TO_APPLY",
] as const;

export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const ReviewStatusSchema = z.enum(REVIEW_STATUSES);

export const REVIEW_EVENT_TYPES = ["STATUS_CHANGED"] as const;

export type ReviewEventType = (typeof REVIEW_EVENT_TYPES)[number];

export const ReviewEventTypeSchema = z.enum(REVIEW_EVENT_TYPES);

const REVIEW_TRANSITIONS: Record<ReviewStatus, readonly ReviewStatus[]> = {
  NEW: ["SHORTLISTED", "DISMISSED", "READY_TO_APPLY"],
  SHORTLISTED: ["READY_TO_APPLY", "DISMISSED", "NEW"],
  DISMISSED: ["NEW", "SHORTLISTED"],
  READY_TO_APPLY: ["SHORTLISTED", "DISMISSED"],
};

export function allowedReviewTransitions(from: ReviewStatus): readonly ReviewStatus[] {
  return REVIEW_TRANSITIONS[from];
}

export function canReviewTransition(from: ReviewStatus, to: ReviewStatus): boolean {
  return REVIEW_TRANSITIONS[from].includes(to);
}

export function assertReviewTransition(from: ReviewStatus, to: ReviewStatus): void {
  if (!canReviewTransition(from, to)) {
    throw new InvalidStatusTransitionError(from, to);
  }
}

export interface ReviewEvent {
  id: number;
  jobId: number;
  eventType: ReviewEventType;
  previousStatus: ReviewStatus | null;
  newStatus: ReviewStatus;
  reason: string | null;
  createdAt: string;
}

export interface ReviewTransitionOptions {
  reason?: string | null;
}