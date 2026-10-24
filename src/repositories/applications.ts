import type { Db } from "../db/connection.js";
import type { Application, ApplicationEvent, TransitionOptions } from "../domain/application.js";
import { ApplicationCreateSchema } from "../domain/application.js";
import { ApplicationTargetSchema } from "../domain/applicationTarget.js";
import type { ApplicationTargetSource } from "../domain/applicationTarget.js";
import { ConflictError, NotFoundError, validationErrorFromZod } from "../domain/errors.js";
import type { ApplicationStatus } from "../domain/status.js";
import { assertTransition } from "../domain/status.js";
import { nowIso } from "../domain/time.js";
import { ApplicationEventRepository } from "./applicationEvents.js";

interface ApplicationRow {
  id: number;
  job_id: number;
  status: string;
  resume_version: string | null;
  started_at: string | null;
  submitted_at: string | null;
  last_updated_at: string;
  notes: string | null;
  created_at: string;
  application_url: string | null;
  application_url_source: string | null;
  application_ats: string | null;
  application_resolved_at: string | null;
}

const INSERT_APPLICATION = `
INSERT INTO applications (job_id, status, resume_version, started_at, submitted_at, last_updated_at, notes, created_at)
VALUES (@jobId, @status, @resumeVersion, NULL, NULL, @lastUpdatedAt, @notes, @createdAt)
`;

const UPDATE_APPLICATION_STATUS = `
UPDATE applications SET
  status = @status,
  resume_version = @resumeVersion,
  started_at = @startedAt,
  submitted_at = @submittedAt,
  last_updated_at = @lastUpdatedAt
WHERE id = @id
`;

const UPDATE_APPLICATION_TARGET = `
UPDATE applications SET
  application_url = @applicationUrl,
  application_url_source = @applicationUrlSource,
  application_ats = @applicationAts,
  application_resolved_at = @applicationResolvedAt,
  last_updated_at = @lastUpdatedAt
WHERE id = @id
`;

function mapApplication(row: ApplicationRow): Application {
  return {
    id: row.id,
    jobId: row.job_id,
    status: row.status as ApplicationStatus,
    resumeVersion: row.resume_version,
    startedAt: row.started_at,
    submittedAt: row.submitted_at,
    lastUpdatedAt: row.last_updated_at,
    notes: row.notes,
    createdAt: row.created_at,
    applicationUrl: row.application_url,
    applicationUrlSource: row.application_url_source as ApplicationTargetSource | null,
    applicationAts: row.application_ats,
    applicationResolvedAt: row.application_resolved_at,
  };
}

export class ApplicationRepository {
  private readonly events: ApplicationEventRepository;

  constructor(private readonly db: Db) {
    this.events = new ApplicationEventRepository(db);
  }

  create(input: unknown): Application {
    const parsed = ApplicationCreateSchema.safeParse(input);
    if (!parsed.success) {
      throw validationErrorFromZod("Invalid application", parsed.error);
    }

    const { jobId } = parsed.data;
    const jobRow = this.db.prepare("SELECT 1 AS present FROM jobs WHERE id = ?").get(jobId);
    if (jobRow === undefined) {
      throw new NotFoundError("Job", jobId);
    }
    if (this.findByJobId(jobId)) {
      throw new ConflictError(`An application already exists for job ${jobId}`);
    }

    const timestamp = nowIso();
    const insert = this.db.prepare(INSERT_APPLICATION);
    const run = this.db.transaction(() => {
      const result = insert.run({
        jobId,
        status: "DRAFT",
        resumeVersion: parsed.data.resumeVersion ?? null,
        lastUpdatedAt: timestamp,
        notes: parsed.data.notes ?? null,
        createdAt: timestamp,
      });
      const applicationId = Number(result.lastInsertRowid);
      this.events.append({
        applicationId,
        eventType: "CREATED",
        previousStatus: null,
        newStatus: "DRAFT",
        message: null,
      });
      return applicationId;
    });

    return this.getById(run());
  }

  transitionStatus(
    id: number,
    newStatus: ApplicationStatus,
    options: TransitionOptions = {},
  ): Application {
    const current = this.getById(id);
    assertTransition(current.status, newStatus);

    const timestamp = nowIso();
    const message = options.message ?? null;
    const requestedResumeVersion = options.resumeVersion ?? undefined;

    const update = this.db.prepare(UPDATE_APPLICATION_STATUS);
    const run = this.db.transaction(() => {
      const startedAt =
        newStatus === "IN_PROGRESS" && current.startedAt === null ? timestamp : current.startedAt;
      const submittedAt = newStatus === "SUBMITTED" ? timestamp : current.submittedAt;

      update.run({
        id,
        status: newStatus,
        resumeVersion: requestedResumeVersion ?? current.resumeVersion,
        startedAt,
        submittedAt,
        lastUpdatedAt: timestamp,
      });

      this.events.append({
        applicationId: id,
        eventType: "STATUS_CHANGED",
        previousStatus: current.status,
        newStatus,
        message,
      });
    });
    run();

    return this.getById(id);
  }

  /**
   * Persist the resolved application target. This is a data-only update: the
   * lifecycle audit stays on transitionStatus(), so preparation flows record
   * DRAFT -> IN_PROGRESS -> WAITING_FOR_HUMAN as their audit trail.
   */
  setApplicationTarget(id: number, input: unknown): Application {
    const parsed = ApplicationTargetSchema.safeParse(input);
    if (!parsed.success) {
      throw validationErrorFromZod("Invalid application target", parsed.error);
    }

    this.getById(id);
    const timestamp = nowIso();
    this.db.prepare(UPDATE_APPLICATION_TARGET).run({
      id,
      applicationUrl: parsed.data.url,
      applicationUrlSource: parsed.data.source,
      applicationAts: parsed.data.atsPlatform ?? null,
      applicationResolvedAt: timestamp,
      lastUpdatedAt: timestamp,
    });
    return this.getById(id);
  }

  getById(id: number): Application {
    const found = this.findById(id);
    if (!found) {
      throw new NotFoundError("Application", id);
    }
    return found;
  }

  findById(id: number): Application | null {
    const row = this.db.prepare("SELECT * FROM applications WHERE id = ?").get(id) as
      | ApplicationRow
      | undefined;
    return row ? mapApplication(row) : null;
  }

  findByJobId(jobId: number): Application | null {
    const row = this.db.prepare("SELECT * FROM applications WHERE job_id = ?").get(jobId) as
      | ApplicationRow
      | undefined;
    return row ? mapApplication(row) : null;
  }

  listByStatus(status: ApplicationStatus): Application[] {
    const rows = this.db
      .prepare("SELECT * FROM applications WHERE status = ? ORDER BY last_updated_at DESC, id DESC")
      .all(status) as ApplicationRow[];
    return rows.map(mapApplication);
  }

  /** Oldest-updated first, so the most stale human action surfaces at the top. */
  listByStatuses(statuses: readonly ApplicationStatus[]): Application[] {
    if (statuses.length === 0) {
      return [];
    }
    const placeholders = statuses.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT * FROM applications WHERE status IN (${placeholders}) ` +
          "ORDER BY last_updated_at ASC, id ASC",
      )
      .all(...statuses) as ApplicationRow[];
    return rows.map(mapApplication);
  }

  list(): Application[] {
    const rows = this.db
      .prepare("SELECT * FROM applications ORDER BY last_updated_at DESC, id DESC")
      .all() as ApplicationRow[];
    return rows.map(mapApplication);
  }

  countByStatus(): Partial<Record<ApplicationStatus, number>> {
    const rows = this.db
      .prepare("SELECT status, COUNT(*) AS count FROM applications GROUP BY status")
      .all() as { status: string; count: number }[];
    const counts: Partial<Record<ApplicationStatus, number>> = {};
    for (const row of rows) {
      counts[row.status as ApplicationStatus] = row.count;
    }
    return counts;
  }

  getEventHistory(applicationId: number): ApplicationEvent[] {
    this.getById(applicationId);
    return this.events.listForApplication(applicationId);
  }

  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM applications").get() as {
      count: number;
    };
    return row.count;
  }
}
