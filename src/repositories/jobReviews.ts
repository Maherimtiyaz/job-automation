import type { Db } from "../db/connection.js";
import { NotFoundError } from "../domain/errors.js";
import type { Job } from "../domain/job.js";
import type {
  ReviewEvent,
  ReviewStatus,
  ReviewTransitionOptions,
} from "../domain/review.js";
import { assertReviewTransition, REVIEW_STATUSES } from "../domain/review.js";
import { nowIso } from "../domain/time.js";
import { JobRepository } from "./jobs.js";

interface ReviewEventRow {
  id: number;
  job_id: number;
  event_type: string;
  previous_status: string | null;
  new_status: string;
  reason: string | null;
  created_at: string;
}

export interface ReviewStatusSummary {
  total: number;
  byStatus: Record<ReviewStatus, number>;
}

const UPDATE_REVIEW_STATUS = `
UPDATE jobs SET review_status = @reviewStatus, updated_at = @updatedAt
WHERE id = @id
`;

const INSERT_REVIEW_EVENT = `
INSERT INTO review_events (job_id, event_type, previous_status, new_status, reason, created_at)
VALUES (@jobId, 'STATUS_CHANGED', @previousStatus, @newStatus, @reason, @createdAt)
`;

function mapReviewEvent(row: ReviewEventRow): ReviewEvent {
  return {
    id: row.id,
    jobId: row.job_id,
    eventType: row.event_type as ReviewEvent["eventType"],
    previousStatus: row.previous_status as ReviewEvent["previousStatus"],
    newStatus: row.new_status as ReviewStatus,
    reason: row.reason,
    createdAt: row.created_at,
  };
}

export class JobReviewRepository {
  private readonly jobs: JobRepository;

  constructor(private readonly db: Db) {
    this.jobs = new JobRepository(db);
  }

  getStatus(jobId: number): ReviewStatus {
    return this.jobs.getById(jobId).reviewStatus;
  }

  transitionStatus(
    jobId: number,
    newStatus: ReviewStatus,
    options: ReviewTransitionOptions = {},
  ): Job {
    const current = this.jobs.getById(jobId);
    if (current.reviewStatus === newStatus) {
      return current;
    }
    assertReviewTransition(current.reviewStatus, newStatus);

    const timestamp = nowIso();
    const run = this.db.transaction(() => {
      this.db.prepare(UPDATE_REVIEW_STATUS).run({
        id: jobId,
        reviewStatus: newStatus,
        updatedAt: timestamp,
      });
      this.db.prepare(INSERT_REVIEW_EVENT).run({
        jobId,
        previousStatus: current.reviewStatus,
        newStatus,
        reason: options.reason ?? null,
        createdAt: timestamp,
      });
    });
    run();

    return this.jobs.getById(jobId);
  }

  getReviewHistory(jobId: number): ReviewEvent[] {
    this.jobs.getById(jobId);
    const rows = this.db
      .prepare("SELECT * FROM review_events WHERE job_id = ? ORDER BY id ASC")
      .all(jobId) as ReviewEventRow[];
    return rows.map(mapReviewEvent);
  }

  listByStatus(status: ReviewStatus): Job[] {
    return this.jobs.list({ reviewStatus: status });
  }

  summary(): ReviewStatusSummary {
    const rows = this.db
      .prepare("SELECT review_status AS status, COUNT(*) AS count FROM jobs GROUP BY review_status")
      .all() as { status: string; count: number }[];
    const byStatus = Object.fromEntries(
      REVIEW_STATUSES.map((status) => [status, 0]),
    ) as Record<ReviewStatus, number>;
    for (const row of rows) {
      if (row.status in byStatus) {
        byStatus[row.status as ReviewStatus] = row.count;
      }
    }
    const total = Object.values(byStatus).reduce((sum, count) => sum + count, 0);
    return { total, byStatus };
  }

  assertJobExists(jobId: number): void {
    if (this.jobs.findById(jobId) === null) {
      throw new NotFoundError("Job", jobId);
    }
  }
}