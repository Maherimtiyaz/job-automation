import { ConfigError, loadConfig } from "./config.js";
import type { Db } from "./db/connection.js";
import { openDatabase } from "./db/connection.js";
import { getDatabaseStats } from "./db/diagnostics.js";
import { DomainError } from "./domain/errors.js";
import { describeProfileGaps } from "./domain/profile.js";
import {
  loadProfileFromFile,
  profileExists,
  writeProfileTemplate,
} from "./profile/profileStore.js";
import { JobRepository } from "./repositories/jobs.js";
import { scoreJobs } from "./scoring/scoreJobs.js";

const HELP = `job-automation

Usage: job-automation [command] [options]

Commands:
  status              Show database and profile status (default)
  score [--force]     Score jobs that have not been scored (or all with --force)
  profile:init [--force]
                      Write a starter profile template to PROFILE_PATH
  help                Show this help

Environment:
  DATABASE_PATH       SQLite database path (default: data/job-automation.db)
  PROFILE_PATH        Candidate profile JSON path (default: data/profile.json)`;

function printHelp(): void {
  console.log(HELP);
}

export function runCli(argv: readonly string[]): number {
  const [command = "status", ...rest] = argv;

  try {
    switch (command) {
      case "status":
        return runStatus();
      case "score":
        return runScore(rest);
      case "profile:init":
        return runProfileInit(rest);
      case "help":
      case "--help":
      case "-h":
        printHelp();
        return 0;
      default:
        console.error(`Unknown command: ${command}`);
        printHelp();
        return 1;
    }
  } catch (error) {
    if (error instanceof DomainError || error instanceof ConfigError) {
      console.error(`Error: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

function withDatabase<TResult>(fn: (db: Db, config: ReturnType<typeof loadConfig>) => TResult): TResult {
  const config = loadConfig();
  const db = openDatabase(config.DATABASE_PATH);
  try {
    return fn(db, config);
  } finally {
    db.close();
  }
}

function runStatus(): number {
  return withDatabase((db, config) => {
    const stats = getDatabaseStats(db);
    const jobs = new JobRepository(db);

    console.log(`Database: ${config.DATABASE_PATH} (schema v${stats.schemaVersion})`);
    console.log(
      `Records: companies=${stats.companies} jobs=${stats.jobs} ` +
        `applications=${stats.applications} events=${stats.applicationEvents}`,
    );
    console.log(`Scored jobs: ${jobs.countScored()}/${stats.jobs}`);
    printProfileStatus(config.PROFILE_PATH);
    return 0;
  });
}

function printProfileStatus(path: string): void {
  if (!profileExists(path)) {
    console.log(`Profile: not found at ${path} (run "profile:init" to create a template).`);
    return;
  }

  const profile = loadProfileFromFile(path);
  const gaps = describeProfileGaps(profile);
  console.log(
    `Profile: ${path} (${profile.targetRoles.length} target roles, ${profile.skills.length} skills)`,
  );
  if (gaps.length > 0) {
    console.log(`Profile gaps: ${gaps.map((gap) => gap.field).join(", ")}`);
  }
}

function runScore(argv: readonly string[]): number {
  const force = argv.includes("--force");

  return withDatabase((db, config) => {
    const profile = loadProfileFromFile(config.PROFILE_PATH);
    const result = scoreJobs(db, profile, {
      force,
      onScored: (score) => {
        console.log(
          `job ${score.jobId}: score=${score.total} recommendation=${score.recommendation} ` +
            `confidence=${score.confidence} coverage=${score.coverage}`,
        );
      },
    });
    console.log(`Scored ${result.scored}/${result.total} job(s)${force ? " (forced)" : ""}.`);
    return 0;
  });
}

function runProfileInit(argv: readonly string[]): number {
  const force = argv.includes("--force");
  const config = loadConfig();
  const path = writeProfileTemplate(config.PROFILE_PATH, { overwrite: force });
  console.log(`Wrote profile template to ${path}.`);
  return 0;
}
