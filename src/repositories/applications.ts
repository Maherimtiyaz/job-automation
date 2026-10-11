import type { Db } from "../db/connection.js";
import type { Application, ApplicationEvent, TransitionOptions } from "../domain/application.js";
import { ApplicationCreateSchema } from "../domain/application.js";
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
        status: "DISCOVERED",
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
        newStatus: "DISCOVERED",
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
