import type { Application, ApplicationEvent } from "./application.js";
import { APPLICATION_STATUSES, type ApplicationStatus } from "./status.js";

export interface AnalysisApplication {
  application: Application;
  source: string | null;
  companyName: string | null;
  events: readonly ApplicationEvent[];
}

export const RESPONSE_STATUSES: ReadonlySet<ApplicationStatus> = new Set([
  "INTERVIEW",
  "OFFER",
  "REJECTED",
  "REJECTED_AFTER_INTERVIEW",
]);

export const PRE_SUBMISSION_STATUSES: ReadonlySet<ApplicationStatus> = new Set([
  "DRAFT",
  "IN_PROGRESS",
  "WAITING_FOR_HUMAN",
  "APPROVED",
]);

export interface RateMetric {
  numerator: number;
  denominator: number;
  percentage: number | undefined;
}

export interface HoursMetric {
  count: number;
  medianHours: number | null;
  averageHours: number | null;
}

export interface GroupBreakdown {
  key: string;
  applications: number;
  submitted: number;
  responded: number;
  offers: number;
}

export interface ApplicationAnalyticsReport {
  applications: number;
  everSubmitted: number;
  everInterviewed: number;
  everOffered: number;
  everRejected: number;
  responded: number;
  funnel: Partial<Record<ApplicationStatus, number>>;
  outcomes: {
    preSubmission: number;
    pendingResponse: number;
    responded: number;
    closed: number;
    offered: number;
    rejected: number;
    withdrawn: number;
    failed: number;
  };
  rates: {
    submission: RateMetric;
    response: RateMetric;
    interview: RateMetric;
    offer: RateMetric;
  };
  timeToSubmit: HoursMetric;
  bySource: GroupBreakdown[];
  byCompany: GroupBreakdown[];
}

function everReached(
  application: Application,
  events: readonly ApplicationEvent[],
  status: ApplicationStatus,
): boolean {
  return application.status === status || events.some((event) => event.newStatus === status);
}

function percentage(numerator: number, denominator: number): number | undefined {
  if (denominator <= 0) {
    return undefined;
  }
  return (numerator / denominator) * 100;
}

function rate(numerator: number, denominator: number): RateMetric {
  return {
    numerator,
    denominator,
    percentage: percentage(numerator, denominator),
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const pivot = sorted[middle];
  if (pivot === undefined) {
    return null;
  }
  if (sorted.length % 2 === 1) {
    return pivot;
  }
  const lower = sorted[middle - 1];
  return lower === undefined ? pivot : (pivot + lower) / 2;
}

function groupBreakdowns(
  rows: readonly AnalysisApplication[],
  keyOf: (row: AnalysisApplication) => string,
): GroupBreakdown[] {
  const groups = new Map<string, GroupBreakdown>();
  for (const row of rows) {
    const key = keyOf(row);
    let group = groups.get(key);
    if (group === undefined) {
      group = { key, applications: 0, submitted: 0, responded: 0, offers: 0 };
      groups.set(key, group);
    }
    group.applications += 1;
    if (everReached(row.application, row.events, "SUBMITTED")) {
      group.submitted += 1;
    }
    if (RESPONSE_STATUSES.has(row.application.status)) {
      group.responded += 1;
    }
    if (everReached(row.application, row.events, "OFFER")) {
      group.offers += 1;
    }
  }
  return [...groups.values()].sort(
    (a, b) => b.applications - a.applications || a.key.localeCompare(b.key),
  );
}

export function computeApplicationAnalytics(
  rows: readonly AnalysisApplication[],
): ApplicationAnalyticsReport {
  const funnel: Partial<Record<ApplicationStatus, number>> = {};
  for (const status of APPLICATION_STATUSES) {
    funnel[status] = 0;
  }

  const outcomes: ApplicationAnalyticsReport["outcomes"] = {
    preSubmission: 0,
    pendingResponse: 0,
    responded: 0,
    closed: 0,
    offered: 0,
    rejected: 0,
    withdrawn: 0,
    failed: 0,
  };

  let everSubmitted = 0;
  let everInterviewed = 0;
  let everOffered = 0;
  let everRejected = 0;
  let responded = 0;

  const durations: number[] = [];
  let durationSum = 0;

  for (const { application, events } of rows) {
    funnel[application.status] = (funnel[application.status] ?? 0) + 1;

    const submitted = everReached(application, events, "SUBMITTED");
    if (submitted) {
      everSubmitted += 1;
      if (application.submittedAt !== null) {
        const created = Date.parse(application.createdAt);
        const submittedAt = Date.parse(application.submittedAt);
        if (Number.isFinite(created) && Number.isFinite(submittedAt)) {
          const hours = (submittedAt - created) / 3_600_000;
          durations.push(hours);
          durationSum += hours;
        }
      }
    }
    if (everReached(application, events, "INTERVIEW")) {
      everInterviewed += 1;
    }
    if (everReached(application, events, "OFFER")) {
      everOffered += 1;
    }
    if (
      everReached(application, events, "REJECTED") ||
      everReached(application, events, "REJECTED_AFTER_INTERVIEW")
    ) {
      everRejected += 1;
    }
    if (RESPONSE_STATUSES.has(application.status)) {
      responded += 1;
    }

    switch (application.status) {
      case "DRAFT":
      case "IN_PROGRESS":
      case "WAITING_FOR_HUMAN":
      case "APPROVED":
        outcomes.preSubmission += 1;
        break;
      case "SUBMITTED":
        outcomes.pendingResponse += 1;
        break;
      case "INTERVIEW":
      case "OFFER":
      case "REJECTED":
      case "REJECTED_AFTER_INTERVIEW":
        outcomes.responded += 1;
        break;
      default:
        outcomes.closed += 1;
        break;
    }
    switch (application.status) {
      case "OFFER":
        outcomes.offered += 1;
        break;
      case "REJECTED":
      case "REJECTED_AFTER_INTERVIEW":
        outcomes.rejected += 1;
        break;
      case "WITHDRAWN":
        outcomes.withdrawn += 1;
        break;
      case "FAILED":
        outcomes.failed += 1;
        break;
    }
  }

  return {
    applications: rows.length,
    everSubmitted,
    everInterviewed,
    everOffered,
    everRejected,
    responded,
    funnel,
    outcomes,
    rates: {
      submission: rate(everSubmitted, rows.length),
      response: rate(responded, everSubmitted),
      interview: rate(everInterviewed, everSubmitted),
      offer: rate(everOffered, everSubmitted),
    },
    timeToSubmit: {
      count: durations.length,
      medianHours: median(durations),
      averageHours: durations.length > 0 ? durationSum / durations.length : null,
    },
    bySource: groupBreakdowns(rows, (row) => row.source ?? "unknown"),
    byCompany: groupBreakdowns(rows, (row) => row.companyName ?? "unknown"),
  };
}