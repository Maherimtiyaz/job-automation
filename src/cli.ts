import type { AppConfig } from "./config.js";
import { ConfigError, loadConfig } from "./config.js";
import { BrowserService } from "./browser/browserService.js";
import { printInspectionReport, writeInspectionReport } from "./browser/report.js";
import type { InspectOperationOptions } from "./browser/types.js";
import { validateInspectUrl } from "./browser/urlPolicy.js";
import type { Db } from "./db/connection.js";
import { openDatabase } from "./db/connection.js";
import { getDatabaseStats } from "./db/diagnostics.js";
import { DomainError } from "./domain/errors.js";
import type { Job } from "./domain/job.js";
import { RECOMMENDATIONS } from "./domain/job.js";
import { normalizeCompanyName } from "./domain/normalize.js";
import { describeProfileGaps } from "./domain/profile.js";
import type { CandidateProfile } from "./domain/profile.js";
import { REVIEW_STATUSES, ReviewStatusSchema, type ReviewStatus } from "./domain/review.js";
import { APPLICATION_STATUSES, ApplicationStatusSchema } from "./domain/status.js";
import { ingestJobs } from "./ingest/ingest.js";
import {
  loadProfileFromFile,
  profileExists,
  writeProfileTemplate,
} from "./profile/profileStore.js";
import type { CompanyRegistry, CompanyRegistryEntry } from "./registry/companyStore.js";
import {
  ATS_PLATFORMS,
  addCompanyToRegistry,
  enabledCompaniesForSource,
  listCompanies,
  loadRegistry,
  RegistryNotFoundError,
  setCompanyActive,
  writeRegistryTemplate,
  type AtsPlatform,
} from "./registry/companyStore.js";
import { ApplicationRepository } from "./repositories/applications.js";
import { CompanyRepository } from "./repositories/companies.js";
import { JobRepository } from "./repositories/jobs.js";
import { JobReviewRepository } from "./repositories/jobReviews.js";
import { scoreJobs } from "./scoring/scoreJobs.js";
import { classifyRelevance, roleScoreFromBreakdown } from "./scoring/relevance.js";
import { createSourceRegistry } from "./sources/registry.js";
import { SOURCE_IDS, SourceIdSchema, type SourceId } from "./sources/types.js";

const HELP = `job-automation

Usage: job-automation [command] [options]

Commands:
  dashboard           Show a dashboard of review queue and application pipeline
  status              Show database and profile status (default)
  score [--force]     Score jobs that have not been scored (or all with --force)
  profile:init [--force]
                      Write a starter profile template to PROFILE_PATH
  companies:init [--force]
                      Write a starter company registry template to COMPANIES_PATH
  companies:list      List companies in the registry
  companies:add --name "Acme" --ats greenhouse|lever|other
                      [--board TOKEN] [--website URL] [--careers URL] [--notes TEXT]
                      Register a company for job discovery
  companies:enable --name "Acme"
  companies:disable --name "Acme"
  jobs sources        List supported job sources and enabled company counts
  jobs discover [--source greenhouse|lever] [--limit N] [--dry-run] [--company NAME]
                      Fetch and ingest job listings from registered companies
  jobs list [--limit N] [--min-score N] [--recommendation R] [--source S]
                      [--company NAME] [--state NEW|SHORTLISTED|DISMISSED|READY_TO_APPLY]
                      List jobs, highest score first
  jobs show <id>      Show a job, its score breakdown, and relevance
  jobs review [--limit N] [--min-score N] [--state S] [--include-all]
                      List jobs awaiting review (default review state NEW) with relevance
  jobs shortlist <id> [--reason TEXT]
  jobs dismiss <id> [--reason TEXT]
  jobs ready <id>     Mark a job READY_TO_APPLY
  jobs reopen <id>    Return a reviewed job to NEW
  jobs review-history <id>
                      Show the review/event history for a job
  applications create <jobId> [--resume VERSION] [--notes TEXT]
  applications list [--status S] [--limit N]
  applications show <id>
  applications status <id> <STATUS> [--message TEXT]
  applications events <id>
  browser inspect-job <jobId> [--headed] [--screenshot [PATH]] [--output PATH]
                      [--timeout MS]
                      Open a job's URL in a read-only browser and report what is on it
  browser inspect-url <url> [--headed] [--screenshot [PATH]] [--output PATH]
                      [--timeout MS]
                      Inspect an arbitrary URL with a read-only browser; nothing is filled or submitted
  help                Show this help

Options:
  --dry-run           Report what would be ingested without writing anything
  --force             Overwrite existing template files
  --headed            Show the browser window instead of running headless
  --screenshot        Save a screenshot (default: screenshots/inspect-<timestamp>.png)
  --output PATH       Write the inspection report as JSON to PATH
  --timeout MS        Navigation timeout in milliseconds (default: 15000)

Environment:
  DATABASE_PATH       SQLite database path (default: data/job-automation.db)
  PROFILE_PATH        Candidate profile JSON path (default: data/profile.json)
  COMPANIES_PATH      Company registry JSON path (default: data/companies.json)
  RELEVANCE_MIN_SCORE Min total score for a RELEVANT verdict (default: 55)
  RELEVANCE_MIN_ROLE_SCORE
                      Min role score for a RELEVANT verdict (default: 25)`;

interface ParsedArgs {
  flags: Record<string, string | true>;
  positionals: string[];
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags: Record<string, string | true> = {};
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg.startsWith("--")) {
      const equals = arg.indexOf("=");
      if (equals !== -1) {
        const name = arg.slice(2, equals);
        flags[name] = arg.slice(equals + 1);
        continue;
      }
      const name = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[name] = next;
        i += 1;
      } else {
        flags[name] = true;
      }
    } else {
      positionals.push(arg);
    }
  }

  return { flags, positionals };
}

function readFlag(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags[name];
  if (value === undefined || value === true) {
    return undefined;
  }
  return value;
}

function readIntFlag(parsed: ParsedArgs, name: string, minExclusive = 0): number | undefined {
  const raw = readFlag(parsed, name);
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= minExclusive) {
    throw new ConfigError(`--${name} must be an integer > ${minExclusive}`);
  }
  return value;
}

function printHelp(): void {
  console.log(HELP);
}

export async function runCli(argv: readonly string[]): Promise<number> {
  const [command = "status", ...rest] = argv;

  try {
    switch (command) {
      case "dashboard":
        return await runDashboard();
      case "status":
        return await runStatus();
      case "score":
        return await runScore(rest);
      case "profile:init":
        return await runProfileInit(rest);
      case "companies:init":
        return await runCompaniesInit(rest);
      case "companies:list":
        return await runCompaniesList();
      case "companies:add":
        return await runCompaniesAdd(rest);
      case "companies:enable":
        return await runCompaniesSetActive(rest, true);
      case "companies:disable":
        return await runCompaniesSetActive(rest, false);
      case "jobs":
        return await runJobs(rest);
      case "applications":
        return await runApplications(rest);
      case "browser":
        return await runBrowser(rest);
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

async function withDatabase<TResult>(
  fn: (db: Db, config: AppConfig) => TResult | Promise<TResult>,
): Promise<TResult> {
  const config = loadConfig();
  const db = openDatabase(config.DATABASE_PATH);
  try {
    return await fn(db, config);
  } finally {
    db.close();
  }
}

async function runStatus(): Promise<number> {
  return withDatabase((db, config) => {
    const stats = getDatabaseStats(db);
    const jobs = new JobRepository(db);
    const reviews = new JobReviewRepository(db);
    const reviewSummary = reviews.summary();
    const applications = new ApplicationRepository(db);

    console.log(`Database: ${config.DATABASE_PATH} (schema v${stats.schemaVersion})`);
    console.log(
      `Records: companies=${stats.companies} jobs=${stats.jobs} ` +
        `applications=${stats.applications} events=${stats.applicationEvents}`,
    );
    console.log(`Scored jobs: ${jobs.countScored()}/${stats.jobs}`);

    const reviewCounts = REVIEW_STATUSES.map((status) => `${status}=${reviewSummary.byStatus[status]}`);
    console.log(`Review queue: ${reviewCounts.join("  ")}`);

    const lifecycleCounts = applications.countByStatus();
    const lifecycleLine = APPLICATION_STATUSES.filter((status) => (lifecycleCounts[status] ?? 0) > 0)
      .map((status) => `${status}=${lifecycleCounts[status] ?? 0}`)
      .join("  ");
    console.log(`Applications: ${lifecycleLine === "" ? "none" : lifecycleLine}`);

    printProfileStatus(config.PROFILE_PATH);
    return 0;
  });
}

async function runDashboard(): Promise<number> {
  return withDatabase((db, config) => {
    const jobs = new JobRepository(db);
    const reviews = new JobReviewRepository(db);
    const applications = new ApplicationRepository(db);
    const companies = new CompanyRepository(db);
    const reviewSummary = reviews.summary();

    console.log(`Job automation dashboard (${config.DATABASE_PATH})\n`);

    console.log("Review queue:");
    for (const status of REVIEW_STATUSES) {
      const rows = status === "NEW" ? reviews.listByStatus(status) : [];
      const count = reviewSummary.byStatus[status];
      console.log(`  ${status}: ${count}`);
      if (status === "NEW") {
        for (const job of rows.slice(0, 5)) {
          const company = companies.findById(job.companyId);
          const score = job.scoreTotal === null ? "-" : String(job.scoreTotal);
          console.log(
            `    job ${job.id}: [${score}] ${company?.name ?? String(job.companyId)} (${job.source}) "${job.title}"`,
          );
        }
        if (rows.length > 5) {
          console.log(`    ... and ${rows.length - 5} more`);
        }
      }
    }

    console.log("");
    console.log("Application pipeline:");
    const lifecycleCounts = applications.countByStatus();
    for (const status of APPLICATION_STATUSES) {
      console.log(
        `  ${status}: ${lifecycleCounts[status] ?? 0}`,
      );
    }

    const needsAttention = applications
      .list()
      .filter((app) => app.status === "WAITING_FOR_HUMAN" || app.status === "SUBMITTED");
    console.log("");
    console.log("Needs attention:");
    if (needsAttention.length === 0) {
      console.log("  none");
    } else {
      for (const app of needsAttention.slice(0, 5)) {
        const job = jobs.findById(app.jobId);
        console.log(
          `  application ${app.id} [${app.status}]: ${job?.title ?? `job ${app.jobId}`}`,
        );
      }
    }

    console.log("");
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

async function runScore(argv: readonly string[]): Promise<number> {
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

async function runProfileInit(argv: readonly string[]): Promise<number> {
  const force = argv.includes("--force");
  const config = loadConfig();
  const path = writeProfileTemplate(config.PROFILE_PATH, { overwrite: force });
  console.log(`Wrote profile template to ${path}.`);
  return 0;
}

async function runCompaniesInit(argv: readonly string[]): Promise<number> {
  const force = argv.includes("--force");
  const config = loadConfig();
  const path = writeRegistryTemplate(config.COMPANIES_PATH, { overwrite: force });
  console.log(`Wrote company registry template to ${path}.`);
  return 0;
}

async function runCompaniesList(): Promise<number> {
  const config = loadConfig();

  let companies: CompanyRegistryEntry[];
  try {
    companies = listCompanies(config.COMPANIES_PATH);
  } catch (error) {
    if (error instanceof RegistryNotFoundError) {
      console.error(`Error: ${error.message}`);
      console.error('Run "companies:init" to create one, then "companies:add" to register companies.');
      return 1;
    }
    throw error;
  }

  if (companies.length === 0) {
    console.log(`No companies in registry (${config.COMPANIES_PATH}).`);
    return 0;
  }

  console.log(`Company registry: ${config.COMPANIES_PATH}`);
  for (const company of companies) {
    const state = company.active ? "active" : "disabled";
    const extra = company.boardToken ? ` board=${company.boardToken}` : "";
    const notes = company.notes ? ` (${company.notes})` : "";
    console.log(`  [${state}] ${company.atsPlatform.padEnd(10)} ${company.name}${extra}${notes}`);
  }
  return 0;
}

async function runCompaniesAdd(argv: readonly string[]): Promise<number> {
  const config = loadConfig();
  const parsed = parseArgs(argv);

  const name = readFlag(parsed, "name");
  if (!name) {
    console.error('Error: --name is required (e.g. --name "Acme").');
    return 1;
  }

  const ats = readFlag(parsed, "ats") ?? "other";
  if (!ATS_PLATFORMS.includes(ats as AtsPlatform)) {
    console.error(`Error: --ats must be one of: ${ATS_PLATFORMS.join(", ")}.`);
    return 1;
  }

  const boardToken = readFlag(parsed, "board");
  const website = readFlag(parsed, "website");
  const careersUrl = readFlag(parsed, "careers");
  const notes = readFlag(parsed, "notes");

  let entry: CompanyRegistryEntry;
  try {
    entry = addCompanyToRegistry(config.COMPANIES_PATH, {
      name,
      atsPlatform: ats as AtsPlatform,
      ...(boardToken !== undefined ? { boardToken } : {}),
      ...(website !== undefined ? { website } : {}),
      ...(careersUrl !== undefined ? { careersUrl } : {}),
      ...(notes !== undefined ? { notes } : {}),
    });
  } catch (error) {
    if (error instanceof RegistryNotFoundError) {
      console.error(`Error: ${error.message}`);
      console.error('Run "companies:init" to create one, then "companies:add" to register companies.');
      return 1;
    }
    throw error;
  }

  console.log(`Added ${entry.name} (${entry.atsPlatform}) to ${config.COMPANIES_PATH}.`);
  return 0;
}

async function runCompaniesSetActive(argv: readonly string[], active: boolean): Promise<number> {
  const config = loadConfig();
  const parsed = parseArgs(argv);

  const name = readFlag(parsed, "name");
  if (!name) {
    console.error("Error: --name is required.");
    return 1;
  }

  try {
    const entry = setCompanyActive(config.COMPANIES_PATH, name, active);
    console.log(`Company "${entry.name}" is now ${active ? "enabled" : "disabled"}.`);
    return 0;
  } catch (error) {
    if (error instanceof RegistryNotFoundError) {
      console.error(`Error: ${error.message}`);
      console.error('Run "companies:init" to create one, then "companies:add" to register companies.');
      return 1;
    }
    throw error;
  }
}

async function runJobs(argv: readonly string[]): Promise<number> {
  const [subcommand = "", ...rest] = argv;

  switch (subcommand) {
    case "sources":
      return await runJobsSources();
    case "discover":
      return await runJobsDiscover(rest);
    case "list":
      return await runJobsList(rest);
    case "show":
      return await runJobsShow(rest);
    case "review":
      return await runJobsReview(rest);
    case "shortlist":
      return await runJobsTransition(rest, "SHORTLISTED");
    case "dismiss":
      return await runJobsTransition(rest, "DISMISSED");
    case "ready":
      return await runJobsTransition(rest, "READY_TO_APPLY");
    case "reopen":
      return await runJobsTransition(rest, "NEW");
    case "review-history":
      return await runJobsReviewHistory(rest);
    default:
      if (subcommand === "") {
        console.error(
          "Error: missing jobs subcommand (sources | discover | list | show | review | shortlist | dismiss | ready | reopen | review-history).",
        );
        return 1;
      }
      console.error(`Unknown jobs subcommand: ${subcommand}`);
      return 1;
  }
}

async function runJobsSources(): Promise<number> {
  const config = loadConfig();
  const adapters = createSourceRegistry();

  let registry: CompanyRegistry | null = null;
  try {
    registry = loadRegistry(config.COMPANIES_PATH);
  } catch (error) {
    if (error instanceof RegistryNotFoundError) {
      registry = null;
    } else {
      throw error;
    }
  }

  console.log("Available job sources:");
  for (const [sourceId, adapter] of adapters) {
    const enabled = registry ? enabledCompaniesForSource(registry, sourceId).length : 0;
    console.log(`  ${sourceId.padEnd(12)} ${adapter.description} (${enabled} enabled)`);
  }
  return 0;
}

async function runJobsDiscover(argv: readonly string[]): Promise<number> {
  const config = loadConfig();
  const parsed = parseArgs(argv);

  const dryRun = parsed.flags["dry-run"] === true;
  const limit = readIntFlag(parsed, "limit", 0);
  const companyFilter = readFlag(parsed, "company");

  let sources: readonly SourceId[] = [...SOURCE_IDS];
  const sourceFlag = readFlag(parsed, "source");
  if (sourceFlag !== undefined) {
    const parsedSource = SourceIdSchema.safeParse(sourceFlag);
    if (!parsedSource.success) {
      console.error(`Error: unknown source "${sourceFlag}". Valid sources: ${SOURCE_IDS.join(", ")}`);
      return 1;
    }
    sources = [parsedSource.data];
  }

  let registry: CompanyRegistry;
  try {
    registry = loadRegistry(config.COMPANIES_PATH);
  } catch (error) {
    if (error instanceof RegistryNotFoundError) {
      console.error(`Error: ${error.message}`);
      console.error('Run "companies:init" to create one, then "companies:add" to register companies.');
      return 1;
    }
    throw error;
  }

  if (companyFilter !== undefined) {
    const normalized = normalizeCompanyName(companyFilter);
    const matched = registry.companies.filter(
      (company) => normalizeCompanyName(company.name) === normalized,
    );
    if (matched.length === 0) {
      console.error(`Error: company "${companyFilter}" is not in the registry.`);
      return 1;
    }
    registry = { version: 1, companies: matched };
  }

  const enabled = sources.flatMap((source) => enabledCompaniesForSource(registry, source));
  if (enabled.length === 0) {
    console.log("No enabled companies found for the requested source(s).");
    console.log(
      'Add companies with: companies:add --name "Acme" --ats greenhouse --board acme',
    );
    return 0;
  }

  const profile = profileExists(config.PROFILE_PATH)
    ? loadProfileFromFile(config.PROFILE_PATH)
    : null;
  if (profile === null) {
    console.log(
      'Note: no profile found; jobs are ingested without scoring. Run "profile:init" to create one.',
    );
  }

  console.log(
    `Discovering jobs across ${sources.length} source(s) and ${enabled.length} company/ies` +
      `${dryRun ? " (dry run)" : ""}:`,
  );

  const summary = await withDatabase((db) =>
    ingestJobs(db, {
      registry,
      profile,
      sources,
      ...(limit !== undefined ? { limit } : {}),
      dryRun,
      adapters: createSourceRegistry(),
      onRecord: (record) => {
        console.log(
          `  [${record.source}] ${record.companyName}: ${record.outcome} "${record.title}"`,
        );
      },
      onSourceError: (error, source, companyName) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`  [${source}] ${companyName}: source failed (${message})`);
      },
    }),
  );

  console.log(
    `Summary: fetched=${summary.listingsFetched} valid=${summary.valid} inserted=${summary.inserted} ` +
      `updated=${summary.updated} duplicates=${summary.duplicates} invalid=${summary.invalid}`,
  );
  console.log(
    `Requests: ${summary.requestsMade}  Source failures: ${summary.sourceFailures}  Scoring failures: ${summary.scoringFailures}`,
  );
  return 0;
}

function formatSalary(job: Job): string {
  const currency = job.salaryCurrency ? `${job.salaryCurrency} ` : "";
  if (job.salaryMin !== null && job.salaryMax !== null) {
    return `${currency}${job.salaryMin}-${job.salaryMax}`;
  }
  if (job.salaryMin !== null) {
    return `${currency}${job.salaryMin}+`;
  }
  if (job.salaryMax !== null) {
    return `<= ${currency}${job.salaryMax}`;
  }
  return "-";
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}

async function runJobsList(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv);
  const limit = readIntFlag(parsed, "limit", 0) ?? 25;
  const minScore = readIntFlag(parsed, "min-score");
  const recommendation = readFlag(parsed, "recommendation");
  const source = readFlag(parsed, "source");
  const state = readFlag(parsed, "state");
  const companyFilter = readFlag(parsed, "company");

  if (recommendation !== undefined) {
    if (!RECOMMENDATIONS.includes(recommendation as import("./domain/job.js").Recommendation)) {
      console.error(`Error: --recommendation must be one of: ${RECOMMENDATIONS.join(", ")}.`);
      return 1;
    }
  }
  if (state !== undefined && !ReviewStatusSchema.safeParse(state).success) {
    console.error(`Error: --state must be one of: ${REVIEW_STATUSES.join(", ")}.`);
    return 1;
  }

  return withDatabase((db) => {
    const jobs = new JobRepository(db);
    const companies = new CompanyRepository(db);

    const filter: import("./domain/job.js").JobFilter = {};
    if (minScore !== undefined) {
      filter.minScore = minScore;
    }
    if (recommendation !== undefined) {
      filter.recommendation = recommendation as import("./domain/job.js").Recommendation;
    }
    if (source !== undefined) {
      filter.source = source;
    }
    if (state !== undefined) {
      filter.reviewStatus = state as ReviewStatus;
    }
    if (companyFilter !== undefined) {
      const company = companies.findByNormalizedName(normalizeCompanyName(companyFilter));
      if (company === null) {
        console.error(`Error: no company named "${companyFilter}".`);
        return 1;
      }
      filter.companyId = company.id;
    }

    const all = jobs.list(filter);
    const sorted = [...all].sort((left, right) => {
      const leftScore = left.scoreTotal ?? -1;
      const rightScore = right.scoreTotal ?? -1;
      if (rightScore !== leftScore) {
        return rightScore - leftScore;
      }
      return right.discoveredAt.localeCompare(left.discoveredAt);
    });
    const items = sorted.slice(0, limit);

    if (items.length === 0) {
      console.log("No jobs found.");
      return 0;
    }

    const label = summarizeJobFilter(filter);
    console.log(`Found ${all.length} job(s)${label}, showing ${items.length}:`);
    for (const job of items) {
      const company = companies.findById(job.companyId);
      const score = job.scoreTotal === null ? "-" : String(job.scoreTotal);
      console.log(
        `  job ${job.id}: [${score}] ${company?.name ?? String(job.companyId)} (${job.source}) "${job.title}"` +
          ` [${job.reviewStatus}]`,
      );
    }
    return 0;
  });
}

function summarizeJobFilter(filter: import("./domain/job.js").JobFilter): string {
  const parts: string[] = [];
  if (filter.minScore !== undefined) {
    parts.push(`score >= ${filter.minScore}`);
  }
  if (filter.recommendation !== undefined) {
    parts.push(`recommendation ${filter.recommendation}`);
  }
  if (filter.source !== undefined) {
    parts.push(`source ${filter.source}`);
  }
  if (filter.reviewStatus !== undefined) {
    parts.push(`state ${filter.reviewStatus}`);
  }
  if (filter.companyId !== undefined) {
    parts.push(`company ${filter.companyId}`);
  }
  return parts.length === 0 ? "" : ` with ${parts.join(", ")}`;
}

async function runJobsReview(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv);
  const limit = readIntFlag(parsed, "limit", 0) ?? 20;
  const minScore = readIntFlag(parsed, "min-score");
  const includeAll = parsed.flags["include-all"] === true;
  const stateFlag = readFlag(parsed, "state");

  const state = stateFlag ?? (includeAll ? undefined : "NEW");
  if (state !== undefined && !ReviewStatusSchema.safeParse(state).success) {
    console.error(`Error: --state must be one of: ${REVIEW_STATUSES.join(", ")}.`);
    return 1;
  }

  return withDatabase((db, config) => {
    const jobs = new JobRepository(db);
    const companies = new CompanyRepository(db);
    const profile = profileExists(config.PROFILE_PATH)
      ? loadProfileFromFile(config.PROFILE_PATH)
      : null;
    const policy = relevancePolicy(config);

    const filter: import("./domain/job.js").JobFilter = {};
    if (minScore !== undefined) {
      filter.minScore = minScore;
    }
    if (state !== undefined) {
      filter.reviewStatus = state as ReviewStatus;
    }
    const sorted = [...jobs.list(filter)].sort((left, right) => {
      const leftScore = left.scoreTotal ?? -1;
      const rightScore = right.scoreTotal ?? -1;
      if (rightScore !== leftScore) {
        return rightScore - leftScore;
      }
      return right.discoveredAt.localeCompare(left.discoveredAt);
    });
    const relevanceEntries = sorted.map((job) => {
      const result = describeRelevance(jobs, job, profile, policy);
      const company = companies.findById(job.companyId);
      return `  job ${job.id}: [${result.score}] ${result.verdict.padEnd(8)} ` +
        `${company?.name ?? String(job.companyId)} (${job.source}) "${job.title}" [${job.reviewStatus}]`;
    });

    if (relevanceEntries.length === 0) {
      console.log(
        `No jobs awaiting review${minScore !== undefined ? ` with score >= ${minScore}` : ""}.`,
      );
      return 0;
    }

    const header = includeAll
      ? `Review overview (${sorted.length} job(s)):`
      : `Review queue (${sorted.length} awaiting review):`;
    console.log(header);
    for (const line of relevanceEntries.slice(0, limit)) {
      console.log(line);
    }
    if (relevanceEntries.length > limit) {
      console.log(`  ... and ${relevanceEntries.length - limit} more (use --limit N)`);
    }
    console.log("");
    console.log(
      "Use: jobs shortlist <id> [--reason TEXT], jobs dismiss <id> [--reason TEXT], jobs ready <id>.",
    );
    return 0;
  });
}

async function runJobsTransition(
  argv: readonly string[],
  target: ReviewStatus,
): Promise<number> {
  const parsed = parseArgs(argv);
  const id = Number(parsed.positionals[0]);
  if (!Number.isSafeInteger(id) || id <= 0) {
    console.error("Error: a positive job id is required (e.g. jobs shortlist 3).");
    return 1;
  }
  const reason = readFlag(parsed, "reason");

  return withDatabase((db) => {
    const reviews = new JobReviewRepository(db);
    const companies = new CompanyRepository(db);
    const jobs = new JobRepository(db);

    const before = jobs.getById(id);
    const after = reviews.transitionStatus(id, target, {
      ...(reason !== undefined ? { reason } : {}),
    });

    if (before.reviewStatus === after.reviewStatus) {
      console.log(`job ${id} is already ${after.reviewStatus} (no change).`);
      return 0;
    }

    const company = companies.findById(after.companyId);
    console.log(
      `job ${id}: ${before.reviewStatus} -> ${after.reviewStatus}` +
        ` (${company?.name ?? String(after.companyId)} "${after.title}")` +
        (reason !== undefined ? ` reason="${reason}"` : ""),
    );
    return 0;
  });
}

async function runJobsReviewHistory(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv);
  const id = Number(parsed.positionals[0]);
  if (!Number.isSafeInteger(id) || id <= 0) {
    console.error("Error: a positive job id is required (e.g. jobs review-history 3).");
    return 1;
  }

  return withDatabase((db) => {
    const reviews = new JobReviewRepository(db);
    const events = reviews.getReviewHistory(id);
    console.log(`Review history for job ${id} (${events.length} event(s)):`);
    if (events.length === 0) {
      console.log("  (none - job has not been reviewed yet)");
    }
    for (const event of events) {
      const from = event.previousStatus ?? "-";
      const reason = event.reason !== null ? ` (${event.reason})` : "";
      console.log(
        `  #${event.id} ${event.createdAt}: ${from} -> ${event.newStatus}${reason}`,
      );
    }
    return 0;
  });
}

async function runJobsShow(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv);
  const id = Number(parsed.positionals[0]);
  if (!Number.isSafeInteger(id) || id <= 0) {
    console.error("Error: jobs show requires a positive job id (e.g. jobs show 1).");
    return 1;
  }

  return withDatabase((db, config) => {
    const jobs = new JobRepository(db);
    const companies = new CompanyRepository(db);

    const job = jobs.getById(id);
    const company = companies.findById(job.companyId);
    const profile = profileExists(config.PROFILE_PATH)
      ? loadProfileFromFile(config.PROFILE_PATH)
      : null;
    const policy = relevancePolicy(config);
    const relevance = describeRelevance(jobs, job, profile, policy);

    console.log(`Job ${job.id}: ${job.title}`);
    console.log(`  Company:    ${company?.name ?? String(job.companyId)}`);
    console.log(`  URL:        ${job.canonicalUrl}`);
    console.log(
      `  Source:     ${job.source}${job.externalJobId ? ` (external id ${job.externalJobId})` : ""}`,
    );
    console.log(`  Location:   ${job.location ?? "-"}`);
    console.log(`  Type:       ${job.employmentType ?? "-"} (${job.workplaceType})`);
    console.log(`  Salary:     ${formatSalary(job)}`);
    console.log(`  Review:     ${job.reviewStatus}`);
    console.log(`  Relevance:  ${relevance.verdict}${relevance.nearestTargetRole ? ` (nearest ${relevance.nearestTargetRole})` : ""}`);
    for (const reason of relevance.reasons) {
      console.log(`              - ${reason}`);
    }
    console.log(`  Discovered: ${job.discoveredAt}`);
    console.log(`  Last seen:  ${job.lastSeenAt}`);
    console.log(
      `  Score:      ${job.scoreTotal ?? "-"} (${job.scoreRecommendation ?? "unscored"}, ` +
        `confidence ${job.scoreConfidence ?? "-"}, coverage ${job.scoreCoverage ?? "-"})`,
    );
    if (job.description) {
      console.log(`  Description: ${truncate(job.description, 400)}`);
    }

    const breakdown = jobs.getScoreBreakdown(id);
    if (breakdown) {
      console.log("  Breakdown:");
      for (const reason of breakdown.reasons) {
        console.log(`    ${reason.component.padEnd(14)} ${reason.message}`);
      }
    }
    return 0;
  });
}

function relevancePolicy(config: AppConfig): {
  minScore: number;
  minRoleScore: number;
} {
  return {
    minScore: config.RELEVANCE_MIN_SCORE,
    minRoleScore: config.RELEVANCE_MIN_ROLE_SCORE,
  };
}

function describeRelevance(
  jobs: JobRepository,
  job: Job,
  profile: CandidateProfile | null,
  policy: { minScore: number; minRoleScore: number },
): RelevanceDisplay {
  const breakdown = jobs.getScoreBreakdown(job.id);
  const roleScore = roleScoreFromBreakdown(breakdown);
  const targetRoles = profile !== null ? profile.targetRoles.map((entry) => entry.role) : [];
  const result = classifyRelevance(
    {
      title: job.title,
      scoreTotal: job.scoreTotal,
      roleScore,
      recommendation: job.scoreRecommendation,
      targetRoles,
    },
    policy,
  );
  const score = job.scoreTotal === null ? "-" : String(job.scoreTotal);
  return {
    score,
    verdict: result.verdict,
    nearestTargetRole: result.nearestTargetRole,
    reasons: result.reasons,
  };
}

interface RelevanceDisplay {
  score: string;
  verdict: string;
  nearestTargetRole: string | null;
  reasons: string[];
}

async function runApplications(argv: readonly string[]): Promise<number> {
  const [subcommand = "", ...rest] = argv;

  switch (subcommand) {
    case "create":
      return await runApplicationCreate(rest);
    case "list":
      return await runApplicationList(rest);
    case "show":
      return await runApplicationShow(rest);
    case "status":
      return await runApplicationStatus(rest);
    case "events":
      return await runApplicationEvents(rest);
    default:
      if (subcommand === "") {
        console.error(
          "Error: missing applications subcommand (create | list | show | status | events).",
        );
        return 1;
      }
      console.error(`Unknown applications subcommand: ${subcommand}`);
      return 1;
  }
}

async function runApplicationCreate(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv);
  const jobId = Number(parsed.positionals[0]);
  if (!Number.isSafeInteger(jobId) || jobId <= 0) {
    console.error("Error: applications create requires a positive job id (e.g. applications create 5).");
    return 1;
  }

  const resumeVersion = readFlag(parsed, "resume");
  const notes = readFlag(parsed, "notes");

  return withDatabase((db) => {
    const jobs = new JobRepository(db);
    const applications = new ApplicationRepository(db);
    const companies = new CompanyRepository(db);

    const job = jobs.getById(jobId);
    const application = applications.create({
      jobId,
      ...(resumeVersion !== undefined ? { resumeVersion } : {}),
      ...(notes !== undefined ? { notes } : {}),
    });
    const company = companies.findById(job.companyId);
    console.log(
      `Created application ${application.id} for job ${jobId} "${job.title}" ` +
        `(${company?.name ?? String(job.companyId)}) [status ${application.status}].`,
    );
    return 0;
  });
}

async function runApplicationList(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv);
  const limit = readIntFlag(parsed, "limit", 0) ?? 25;
  const statusFlag = readFlag(parsed, "status");

  if (statusFlag !== undefined && !ApplicationStatusSchema.safeParse(statusFlag).success) {
    console.error(`Error: --status must be one of: ${APPLICATION_STATUSES.join(", ")}.`);
    return 1;
  }

  return withDatabase((db) => {
    const applications = new ApplicationRepository(db);
    const jobs = new JobRepository(db);
    const companies = new CompanyRepository(db);

    const all = statusFlag !== undefined ? applications.listByStatus(statusFlag as import("./domain/status.js").ApplicationStatus) : applications.list();
    const sorted = [...all].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const items = sorted.slice(0, limit);

    if (items.length === 0) {
      console.log(
        `No applications found${statusFlag !== undefined ? ` with status ${statusFlag}` : ""}.`,
      );
      return 0;
    }

    console.log(
      `Found ${all.length} application(s)${statusFlag !== undefined ? ` with status ${statusFlag}` : ""}, ` +
        `showing ${items.length}:`,
    );
    for (const app of items) {
      const job = jobs.findById(app.jobId);
      const company = job !== null ? companies.findById(job.companyId) : undefined;
      const companyLabel = company?.name ?? (job ? String(job.companyId) : "?");
      console.log(
        `  application ${app.id}: [${app.status.padEnd(8)}] job ${app.jobId} ` +
          `${companyLabel} ${job?.title ?? ""}`.trim(),
      );
    }
    return 0;
  });
}

function printApplication(
  jobs: JobRepository,
  companies: CompanyRepository,
  app: import("./domain/application.js").Application,
): void {
  const job = jobs.findById(app.jobId);
  const company = job !== null ? companies.findById(job.companyId) : undefined;
  console.log(`Application ${app.id}:`);
  console.log(`  Job:      ${job?.title ?? `#${app.jobId}`} at ${company?.name ?? ""}`);
  console.log(`  Status:   ${app.status}`);
  console.log(`  Created:  ${app.createdAt}`);
  console.log(`  Updated:  ${app.lastUpdatedAt}`);
  console.log(`  Resume:   ${app.resumeVersion ?? "-"}`);
  console.log(`  Notes:    ${app.notes ?? "-"}`);
}

async function runApplicationShow(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv);
  const id = Number(parsed.positionals[0]);
  if (!Number.isSafeInteger(id) || id <= 0) {
    console.error("Error: applications show requires a positive application id (e.g. applications show 1).");
    return 1;
  }

  return withDatabase((db) => {
    const applications = new ApplicationRepository(db);
    const jobs = new JobRepository(db);
    const companies = new CompanyRepository(db);
    const app = applications.getById(id);
    printApplication(jobs, companies, app);
    return 0;
  });
}

async function runApplicationStatus(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv);
  const id = Number(parsed.positionals[0]);
  if (!Number.isSafeInteger(id) || id <= 0) {
    console.error("Error: applications status requires a positive application id (e.g. applications status 2 APPROVED).");
    return 1;
  }

  const status = parsed.positionals[1];
  const parsedStatus = ApplicationStatusSchema.safeParse(status);
  if (!parsedStatus.success) {
    console.error(`Error: status must be one of: ${APPLICATION_STATUSES.join(", ")}.`);
    return 1;
  }

  const message = readFlag(parsed, "message");

  return withDatabase((db) => {
    const applications = new ApplicationRepository(db);
    const app = applications.transitionStatus(id, parsedStatus.data, {
      ...(message !== undefined ? { message } : {}),
    });
    console.log(`application ${id}: -> ${app.status}`);
    return 0;
  });
}

async function runApplicationEvents(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv);
  const id = Number(parsed.positionals[0]);
  if (!Number.isSafeInteger(id) || id <= 0) {
    console.error("Error: applications events requires a positive application id (e.g. applications events 1).");
    return 1;
  }

  return withDatabase((db) => {
    const applications = new ApplicationRepository(db);
    const events = applications.getEventHistory(id);
    console.log(`Events for application ${id} (${events.length} event(s)):`);
    for (const event of events) {
      const from = event.previousStatus ?? "-";
      const message = event.message !== null ? ` (${event.message})` : "";
      console.log(
        `  #${event.id} ${event.createdAt}: ${event.eventType} ${from} -> ${event.newStatus}${message}`,
      );
    }
    return 0;
  });
}

async function runBrowser(argv: readonly string[]): Promise<number> {
  const [subcommand = "", ...rest] = argv;

  switch (subcommand) {
    case "inspect-job":
      return await runBrowserInspectJob(rest);
    case "inspect-url":
      return await runBrowserInspectUrl(rest);
    default:
      if (subcommand === "") {
        console.error("Error: missing browser subcommand (inspect-job | inspect-url).");
        return 1;
      }
      console.error(`Unknown browser subcommand: ${subcommand}`);
      return 1;
  }
}

async function runBrowserInspectJob(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv);
  const id = Number(parsed.positionals[0]);
  if (!Number.isSafeInteger(id) || id <= 0) {
    console.error("Error: browser inspect-job requires a positive job id (e.g. browser inspect-job 4).");
    return 1;
  }

  const url = await withDatabase((db) => new JobRepository(db).getById(id).canonicalUrl);
  return runBrowserInspection(url, parsed, `job ${id}`);
}

async function runBrowserInspectUrl(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv);
  const rawUrl = parsed.positionals[0];
  if (rawUrl === undefined) {
    console.error(
      "Error: browser inspect-url requires a URL (e.g. browser inspect-url https://boards.greenhouse.io/acme/jobs/123).",
    );
    return 1;
  }

  const url = validateInspectUrl(rawUrl).href;
  return runBrowserInspection(url, parsed, "inspect-url");
}

async function runBrowserInspection(
  url: string,
  parsed: ParsedArgs,
  label: string,
): Promise<number> {
  const headed = parsed.flags["headed"] === true;
  const screenshot = parsed.flags["screenshot"];
  const output = readFlag(parsed, "output");
  const timeout = readIntFlag(parsed, "timeout", 0);

  const service = new BrowserService({
    headless: !headed,
    ...(timeout !== undefined ? { navigationTimeoutMs: timeout } : {}),
  });

  const options: InspectOperationOptions = {};
  if (screenshot !== undefined) {
    options.screenshot = screenshot === true ? true : screenshot;
  }
  if (timeout !== undefined) {
    options.navigationTimeoutMs = timeout;
  }

  try {
    const report = await service.inspect(url, options);
    if (output !== undefined) {
      writeInspectionReport(output, report);
    }
    if (label !== "inspect-url") {
      console.log(`Inspecting ${label}: ${url}`);
    }
    printInspectionReport(report);
    if (output !== undefined) {
      console.log(`Wrote inspection report to ${output}.`);
    }
    return 0;
  } finally {
    await service.close();
  }
}