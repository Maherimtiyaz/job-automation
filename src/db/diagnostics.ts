import type { Db } from "./connection.js";
import { getLatestSchemaVersion } from "./migrations.js";

export interface DatabaseStats {
  schemaVersion: number;
  companies: number;
  jobs: number;
  applications: number;
  applicationEvents: number;
}

export function getDatabaseStats(db: Db): DatabaseStats {
  const countRows = (table: string): number => {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
    return row.count;
  };

  return {
    schemaVersion: getLatestSchemaVersion(db),
    companies: countRows("companies"),
    jobs: countRows("jobs"),
    applications: countRows("applications"),
    applicationEvents: countRows("application_events"),
  };
}
