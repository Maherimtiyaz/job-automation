import assert from "node:assert/strict";
import { test } from "node:test";
import type { Db } from "../../src/db/connection.js";
import type { CandidateProfile } from "../../src/domain/profile.js";
import { createEmptyProfile } from "../../src/domain/profile.js";
import type { JobScore, ScorableJob } from "../../src/domain/scoring.js";
import { scoreJob } from "../../src/scoring/scoreJob.js";
import type { ScoreJobOptions } from "../../src/scoring/scoreJob.js";
import { ingestJobs } from "../../src/ingest/ingest.js";
import type { CompanyRegistry } from "../../src/registry/companyStore.js";
import type { CompanyRegistryEntry } from "../../src/registry/companyStore.js";
import { CompanyRepository } from "../../src/repositories/companies.js";
import { JobRepository } from "../../src/repositories/jobs.js";
import { SourceError, SourceListingSchema, type SourceListing } from "../../src/sources/types.js";
import type {
  FetchListingsInput,
  FetchListingsResult,
  JobSourceAdapter,
} from "../../src/sources/types.js";
import { createTestDatabase } from "../support/db.js";

type StubBehavior =
  | SourceListing[]
  | Error
  | ((companyName: string) => SourceListing[] | Error);

class StubAdapter implements JobSourceAdapter {
  readonly id = "greenhouse";
  readonly description = "stub";
  readonly fetched: string[] = [];

  constructor(private readonly behavior: StubBehavior) {}

  async fetchListings(input: FetchListingsInput): Promise<FetchListingsResult> {
    this.fetched.push(input.company.name);
    const outcome =
      typeof this.behavior === "function" ? this.behavior(input.company.name) : this.behavior;
    if (outcome instanceof Error) {
      throw outcome;
    }
    return { listings: outcome, invalid: 0, requestsMade: 1 };
  }
}

function listing(
  id: string,
  title: string,
  overrides: Partial<SourceListing> = {},
): SourceListing {
  return SourceListingSchema.parse({
    id,
    title,
    url: `https://acme.test/${id}`,
    description: null,
    location: null,
    employmentType: null,
    workplaceType: "unknown",
    companyName: "Acme",
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    ...overrides,
  });
}

function entry(name: string, platform: "greenhouse" | "lever" = "greenhouse"): CompanyRegistryEntry {
  return {
    name,
    website: null,
    careersUrl: null,
    atsPlatform: platform,
    boardToken: `${name.toLowerCase()}-token`,
    active: true,
    notes: null,
  };
}

function registry(companies: CompanyRegistryEntry[]): CompanyRegistry {
  return { version: 1, companies };
}

const greenhouseOnly = new Map<"greenhouse", JobSourceAdapter>();

function ingestWith(
  db: Db,
  overrides: Partial<Parameters<typeof ingestJobs>[1]> = {},
): ReturnType<typeof ingestJobs> {
  return ingestJobs(db, {
    registry: registry([]),
    profile: null,
    delayMs: 0,
    adapters: greenhouseOnly,
    ...overrides,
  });
}

test("inserts and immediately scores new listings", async () => {
  const { db, close } = createTestDatabase();
  try {
    const adapter = new StubAdapter([
      listing("1", "Backend Engineer Intern"),
      listing("2", "Platform Engineer"),
    ]);
    greenhouseOnly.set("greenhouse", adapter);

    const summary = await ingestWith(db, {
      registry: registry([entry("Acme")]),
      profile: createEmptyProfile(),
      sources: ["greenhouse"],
    });

    assert.deepEqual(summary, {
      companies: 1,
      listingsFetched: 2,
      invalid: 0,
      valid: 2,
      inserted: 2,
      updated: 0,
      duplicates: 0,
      scoringFailures: 0,
      sourceFailures: 0,
      requestsMade: 1,
    });

    const jobs = new JobRepository(db);
    assert.equal(jobs.count(), 2);
    assert.equal(jobs.countScored(), 2);

    const companies = new CompanyRepository(db);
    assert.equal(companies.count(), 1);
    assert.equal(companies.list()[0]?.atsPlatform, "greenhouse");
  } finally {
    close();
  }
});

test("scores nothing when no profile is provided", async () => {
  const { db, close } = createTestDatabase();
  try {
    const adapter = new StubAdapter([listing("1", "Backend Engineer Intern")]);
    greenhouseOnly.set("greenhouse", adapter);

    const summary = await ingestWith(db, {
      registry: registry([entry("Acme")]),
      sources: ["greenhouse"],
    });

    assert.equal(summary.inserted, 1);
    assert.equal(new JobRepository(db).countScored(), 0);
  } finally {
    close();
  }
});

test("rescores only when scoring-relevant fields actually change", async () => {
  const { db, close } = createTestDatabase();
  try {
    const base = listing("1", "Backend Engineer Intern", { location: "Remote" });
    const jobs = new JobRepository(db);

    let scoringCalls = 0;
    const spyScore = (
      job: ScorableJob,
      profile: CandidateProfile,
      options: ScoreJobOptions,
    ): JobScore => {
      scoringCalls += 1;
      return scoreJob(job, profile, options);
    };

    const run = (behavior: StubBehavior) =>
      ingestWith(db, {
        registry: registry([entry("Acme")]),
        profile: createEmptyProfile(),
        sources: ["greenhouse"],
        scoreJobFn: spyScore,
        adapters: new Map([["greenhouse", new StubAdapter(behavior)]]),
      });

    const first = await run([base]);
    assert.equal(first.inserted, 1);
    assert.equal(scoringCalls, 1);
    assert.equal(jobs.countScored(), 1);

    const second = await run([base]);
    assert.equal(second.updated, 1);
    assert.equal(scoringCalls, 1);

    const changed = run([listing("1", "Backend Engineer Intern", { location: "London" })]);
    const third = await changed;
    assert.equal(third.updated, 1);
    assert.equal(scoringCalls, 2);
  } finally {
    close();
  }
});

test("classifies a repeated listing within one batch as a duplicate", async () => {
  const { db, close } = createTestDatabase();
  try {
    const adapter = new StubAdapter([listing("1", "Role"), listing("1", "Role repeated")]);
    greenhouseOnly.set("greenhouse", adapter);

    const summary = await ingestWith(db, {
      registry: registry([entry("Acme")]),
      profile: createEmptyProfile(),
      sources: ["greenhouse"],
    });

    assert.equal(summary.inserted, 1);
    assert.equal(summary.duplicates, 1);
    assert.equal(summary.valid, 2);
    assert.equal(new JobRepository(db).count(), 1);
  } finally {
    close();
  }
});

test("a failing source does not abort other companies", async () => {
  const { db, close } = createTestDatabase();
  try {
    const adapter = new StubAdapter((companyName) => {
      if (companyName === "Broken") {
        throw new SourceError("board unavailable");
      }
      return [listing("1", "Role A"), listing("2", "Role B")];
    });
    greenhouseOnly.set("greenhouse", adapter);

    const summary = await ingestWith(db, {
      registry: registry([entry("Acme"), entry("Broken")]),
      profile: createEmptyProfile(),
      sources: ["greenhouse"],
    });

    assert.equal(summary.companies, 2);
    assert.equal(summary.sourceFailures, 1);
    assert.equal(summary.inserted, 2);
    assert.equal(new JobRepository(db).count(), 2);
  } finally {
    close();
  }
});

test("a missing adapter counts as a source failure without creating records", async () => {
  const { db, close } = createTestDatabase();
  try {
    const summary = await ingestWith(db, {
      registry: registry([entry("Acme")]),
      profile: createEmptyProfile(),
      sources: ["greenhouse"],
      adapters: new Map(),
    });

    assert.equal(summary.sourceFailures, 1);
    assert.equal(summary.companies, 0);
    assert.equal(new JobRepository(db).count(), 0);
  } finally {
    close();
  }
});

test("dry run reports what would change without writing anything", async () => {
  const { db, close } = createTestDatabase();
  try {
    const companies = new CompanyRepository(db);
    const jobs = new JobRepository(db);

    const company = companies.create({ name: "Acme" });
    jobs.create({
      companyId: company.id,
      title: "Stale title",
      url: "https://acme.test/1",
      source: "greenhouse",
      externalJobId: "1",
    });

    const adapter = new StubAdapter((companyName) =>
      companyName === "Acme"
        ? [listing("1", "Fresh title")]
        : [listing("9", "Brand new role")],
    );
    greenhouseOnly.set("greenhouse", adapter);

    const summary = await ingestWith(db, {
      registry: registry([entry("Acme"), entry("BrandNew")]),
      dryRun: true,
      sources: ["greenhouse"],
    });

    assert.equal(summary.companies, 2);
    assert.equal(summary.updated, 1);
    assert.equal(summary.inserted, 1);
    assert.equal(summary.valid, 2);

    assert.equal(companies.count(), 1);
    assert.equal(jobs.count(), 1);
    assert.equal(jobs.list()[0]?.title, "Stale title");
  } finally {
    close();
  }
});

test("a scoring failure keeps the job and is counted", async () => {
  const { db, close } = createTestDatabase();
  try {
    const adapter = new StubAdapter([listing("1", "Role")]);
    greenhouseOnly.set("greenhouse", adapter);

    const summary = await ingestWith(db, {
      registry: registry([entry("Acme")]),
      profile: createEmptyProfile(),
      sources: ["greenhouse"],
      scoreJobFn: () => {
        throw new Error("scoring blew up");
      },
    });

    assert.equal(summary.inserted, 1);
    assert.equal(summary.scoringFailures, 1);
    assert.equal(new JobRepository(db).count(), 1);
    assert.equal(new JobRepository(db).countScored(), 0);
  } finally {
    close();
  }
});

test("deduplicates across re-discovery by external id", async () => {
  const { db, close } = createTestDatabase();
  try {
    const firstRun = new StubAdapter([listing("1", "Role")]);
    greenhouseOnly.set("greenhouse", firstRun);

    const first = await ingestWith(db, {
      registry: registry([entry("Acme")]),
      profile: createEmptyProfile(),
      sources: ["greenhouse"],
    });

    const secondRun = new StubAdapter([listing("1", "Role")]);
    greenhouseOnly.set("greenhouse", secondRun);

    const second = await ingestWith(db, {
      registry: registry([entry("Acme")]),
      profile: createEmptyProfile(),
      sources: ["greenhouse"],
    });

    assert.equal(first.inserted, 1);
    assert.equal(second.inserted, 0);
    assert.equal(second.updated, 1);
    assert.deepEqual(secondRun.fetched, ["Acme"]);
  } finally {
    close();
  }
});