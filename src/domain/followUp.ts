import type { Application } from "./application.js";

export const DEFAULT_FOLLOW_UP_DAYS = 7;

export interface FollowUpItem {
  application: Application;
  /** Whole days between submission and `now`. */
  daysWaiting: number;
}

export interface FollowUpOptions {
  /** ISO 8601 timestamp supplied by the caller so this module stays pure. */
  now: string;
  /** Minimum whole days since submission. 0 includes same-day submissions. */
  minDays: number;
}

const MS_PER_DAY = 86_400_000;

export function daysSince(fromIso: string, nowIso: string): number | null {
  const from = Date.parse(fromIso);
  const now = Date.parse(nowIso);
  if (Number.isNaN(from) || Number.isNaN(now)) {
    return null;
  }
  return Math.floor((now - from) / MS_PER_DAY);
}

/**
 * Select submitted applications that are due for a follow-up.
 *
 * A recorded response (interview, rejection, offer) moves an application out of
 * `SUBMITTED`, so a row that is still `SUBMITTED` means no outcome has been
 * recorded yet. Results are oldest-first so the most overdue surfaces first.
 *
 * Pure: performs no I/O and never changes state.
 */
export function selectFollowUps(
  applications: readonly Application[],
  options: FollowUpOptions,
): FollowUpItem[] {
  const items: FollowUpItem[] = [];

  for (const application of applications) {
    if (application.status !== "SUBMITTED" || application.submittedAt === null) {
      continue;
    }
    const daysWaiting = daysSince(application.submittedAt, options.now);
    if (daysWaiting === null || daysWaiting < options.minDays) {
      continue;
    }
    items.push({ application, daysWaiting });
  }

  return items.sort((left, right) => {
    if (left.daysWaiting !== right.daysWaiting) {
      return right.daysWaiting - left.daysWaiting;
    }
    return left.application.id - right.application.id;
  });
}
