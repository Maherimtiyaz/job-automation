import assert from "node:assert/strict";
import { test } from "node:test";
import type { CompanyRegistryEntry } from "../../src/registry/companyStore.js";
import { LeverAdapter } from "../../src/sources/lever.js";
import { SourceConfigError, SourceError } from "../../src/sources/types.js";

function company(slug: string | null): CompanyRegistryEntry {
  return {
    name: "Acme",
    website: null,
    careersUrl: null,
    atsPlatform: "lever",
    boardToken: slug,
    active: true,
    notes: null,
  };
}

function leverPosting(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    text: `Job ${id}`,
    categories: { location: "Remote", commitment: "Full-time" },
    hostedUrl: `https://jobs.lever.co/demo/jobs/${id}`,
    ...overrides,
  };
}

test("maps Lever postings into validated listings", async () => {
  const payload = [
    leverPosting("a1", {
      text: "Backend Engineer",
      categories: { location: "Remote, US", commitment: "Full-time" },
      workplaceType: "Remote",
      hostedUrl: "https://jobs.lever.co/demo/jobs/a1",
      descriptionPlain: "  We build\n  things  ",
    }),
    leverPosting("a2", {
      categories: {
        location: "San Francisco, CA",
        commitment: "Part-time",
        allLocations: ["San Francisco, CA", "Hybrid"],
      },
      workplaceType: null,
      hostedUrl: null,
      descriptionBodyPlain: "Body only\nline two",
    }),
    leverPosting("a3", {
      categories: { location: null, commitment: "Intern" },
      workplaceType: "Onsite",
    }),
  ];

  const adapter = new LeverAdapter(async () => payload);
  const result = await adapter.fetchListings({ company: company("demo"), limit: 10 });

  assert.equal(result.invalid, 0);
  assert.equal(result.requestsMade, 1);
  assert.equal(result.listings.length, 3);

  const [first, second, third] = result.listings;
  assert.equal(first?.title, "Backend Engineer");
  assert.equal(first?.location, "Remote, US");
  assert.equal(first?.employmentType, "FULL_TIME");
  assert.equal(first?.workplaceType, "remote");
  assert.equal(first?.description, "We build things");
  assert.equal(first?.companyName, "Acme");

  assert.equal(second?.url, "https://jobs.lever.co/demo/a2");
  assert.equal(second?.employmentType, "PART_TIME");
  assert.equal(second?.workplaceType, "hybrid");
  assert.equal(second?.description, "Body only line two");

  assert.equal(third?.employmentType, "INTERNSHIP");
  assert.equal(third?.workplaceType, "onsite");
  assert.equal(third?.location, null);
});

test("maps contract and temporary commitments", async () => {
  const adapter = new LeverAdapter(async () => [
    leverPosting("c1", { categories: { commitment: "Contract" } }),
    leverPosting("c2", { categories: { commitment: "Temporary" } }),
    leverPosting("c3", { categories: { commitment: "Weird label" } }),
  ]);

  const result = await adapter.fetchListings({ company: company("demo"), limit: 10 });

  assert.equal(result.listings[0]?.employmentType, "CONTRACT");
  assert.equal(result.listings[1]?.employmentType, "TEMPORARY");
  assert.equal(result.listings[2]?.employmentType, null);
});

test("paginates with skip/limit until the limit is reached", async () => {
  const pages = [100, 100, 50];
  let page = 0;
  const adapter = new LeverAdapter(async (url) => {
    const skip = Number(new URL(url).searchParams.get("skip"));
    const count = pages[Math.min(page, pages.length - 1)] ?? 0;
    page += 1;
    return Array.from({ length: count }, (_, i) => leverPosting(`p${skip + i}`));
  });

  const result = await adapter.fetchListings({ company: company("demo"), limit: 250 });

  assert.equal(result.requestsMade, 3);
  assert.equal(result.listings.length, 250);
  assert.equal(result.invalid, 0);
});

test("stops pagination when the source returns fewer rows than requested", async () => {
  let calls = 0;
  const adapter = new LeverAdapter(async () => {
    calls += 1;
    if (calls === 1) {
      return [leverPosting("only")];
    }
    return [];
  });

  const result = await adapter.fetchListings({ company: company("demo"), limit: 5 });

  assert.equal(result.requestsMade, 1);
  assert.equal(result.listings.length, 1);
});

test("counts invalid rows", async () => {
  const adapter = new LeverAdapter(async () => [
    leverPosting("ok"),
    leverPosting("bad", { text: "   " }),
    "not-an-object",
  ]);

  const result = await adapter.fetchListings({ company: company("demo"), limit: 10 });

  assert.equal(result.listings.length, 1);
  assert.equal(result.invalid, 2);
});

test("throws SourceConfigError when the posting site is missing", async () => {
  const adapter = new LeverAdapter(async () => []);
  await assert.rejects(
    () => adapter.fetchListings({ company: company(null), limit: 10 }),
    SourceConfigError,
  );
});

test("throws SourceError on a non-array payload", async () => {
  const adapter = new LeverAdapter(async () => ({ data: [] }));
  await assert.rejects(
    () => adapter.fetchListings({ company: company("demo"), limit: 10 }),
    SourceError,
  );
});