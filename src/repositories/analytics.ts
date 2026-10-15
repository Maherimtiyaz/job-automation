import type { Db } from "../db/connection.js";
import type { Application, ApplicationEvent } from "../domain/application.js";
import type { AnalysisApplication } from "../domain/analytics.js";
import type { ApplicationEventType, ApplicationStatus } from "../domain/status.js";

interface ApplicationAnalyticsRow {
  id: number;
  job_id: number;
  status: string;
  resume_version: string | null;
  started_at: string | null;
  submitted_at: string | null;
  last_updated_at: string;
  notes: string | null;
  created_at: string;
  job_source: string | null;
  company_name: string | null;
}

interface ApplicationEventRow {
  application_id: number;
  id: number;
  event_type: string;
  previous_status: string | null;
  new_status: string | null;
  message: string | null;
  created_at: string;
}

export class AnalyticsRepository {
  constructor(private readonly db: Db) {}

  applicationRows(): AnalysisApplication[] {
    const rows = this.db
      .prepare(
        `SELECT a.*, j.source AS job_source, c.name AS company_name
         FROM applications a
         JOIN jobs j ON j.id = a.job_id
         LEFT JOIN companies c ON c.id = j.company_id
         ORDER BY a.id ASC`,
      )
      .all() as ApplicationAnalyticsRow[];

    const eventRows = this.db
      .prepare(
        `SELECT application_id, id, event_type, previous_status, new_status, message, created_at
         FROM application_events
         ORDER BY application_id ASC, id ASC`,
      )
      .all() as ApplicationEventRow[];

    const eventsByApplication = new Map<number, ApplicationEvent[]>();
    for (const row of eventRows) {
      const list = eventsByApplication.get(row.application_id) ?? [];
      list.push({
        id: row.id,
        applicationId: row.application_id,
        eventType: row.event_type as ApplicationEventType,
        previousStatus: row.previous_status as ApplicationStatus | null,
        newStatus: row.new_status as ApplicationStatus | null,
        message: row.message,
        createdAt: row.created_at,
      });
      eventsByApplication.set(row.application_id, list);
    }

    return rows.map((row) => {
      const application: Application = {
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
      return {
        application,
        source: row.job_source,
        companyName: row.company_name,
        events: eventsByApplication.get(row.id) ?? [],
      };
    });
  }
}