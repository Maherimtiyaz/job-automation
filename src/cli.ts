import type { AppConfig } from "./config.js";
import { ConfigError, loadConfig } from "./config.js";
import type { Db } from "./db/connection.js";
import { openDatabase } from "./db/connection.js";
import { getDatabaseStats } from "./db/diagnostics.js";
import { DomainError } from "./domain/errors.js";
import type { Job } from "./domain/job.js";
import { normalizeCompanyName } from "./domain/normalize.js";
import { describeProfileGaps } from "./domain/profile.js";
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
import { CompanyRepository } from "./repositories/companies.js";
import { JobRepository } from "./repositories/jobs.js";
import { scoreJobs } from "./scoring/scoreJobs.js";
import { createSourceRegistry } from "./sources/registry.js";
import { SOURCE_IDS, SourceIdSchema, type SourceId } from "./sources/types.js";

const HELP = `job-automation

Usage: job-automation [command] [options]

Commands:
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
  jobs list [--limit N] [--min-score N]
                      List jobs, highest score first
  jobs show <id>      Show a job and its score breakdown
  help                Show this help

Options:
  --dry-run           Report what would be ingested without writing anything
  --force             Overwrite existing template files

Environment:
  DATABASE_PATH       SQLite database path (default: data/job-automation.db)
  PROFILE_PATH        Candidate profile JSON path (default: data/profile.json)
  COMPANIES_PATH      Company registry JSON path (default: data/companies.json)`;

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
    default:
      if (subcommand === "") {
        console.error("Error: missing jobs subcommand (sources | discover | list | show).");
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

  return withDatabase((db) => {
    const jobs = new JobRepository(db);
    const companies = new CompanyRepository(db);

    const all = minScore !== undefined ? jobs.list({ minScore }) : jobs.list();
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

    console.log(
      `Found ${all.length} job(s)${minScore !== undefined ? ` with score >= ${minScore}` : ""}, ` +
        `showing ${items.length}:`,
    );
    for (const job of items) {
      const company = companies.findById(job.companyId);
      const score = job.scoreTotal === null ? "-" : String(job.scoreTotal);
      console.log(
        `  job ${job.id}: [${score}] ${company?.name ?? String(job.companyId)} (${job.source}) "${job.title}"`,
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

  return withDatabase((db) => {
    const jobs = new JobRepository(db);
    const companies = new CompanyRepository(db);

    const job = jobs.getById(id);
    const company = companies.findById(job.companyId);

    console.log(`Job ${job.id}: ${job.title}`);
    console.log(`  Company:    ${company?.name ?? String(job.companyId)}`);
    console.log(`  URL:        ${job.canonicalUrl}`);
    console.log(
      `  Source:     ${job.source}${job.externalJobId ? ` (external id ${job.externalJobId})` : ""}`,
    );
    console.log(`  Location:   ${job.location ?? "-"}`);
    console.log(`  Type:       ${job.employmentType ?? "-"} (${job.workplaceType})`);
    console.log(`  Salary:     ${formatSalary(job)}`);
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