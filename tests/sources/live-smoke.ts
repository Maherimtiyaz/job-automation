import { enabledCompaniesForSource } from "../../src/registry/companyStore.js";
import type { CompanyRegistry } from "../../src/registry/companyStore.js";
import { createSourceRegistry } from "../../src/sources/registry.js";
import { SourceListingSchema } from "../../src/sources/types.js";

const registry: CompanyRegistry = {
  version: 1,
  companies: [
    {
      name: "Airtable",
      website: null,
      careersUrl: null,
      atsPlatform: "greenhouse",
      boardToken: "airtable",
      active: true,
      notes: null,
    },
    {
      name: "Lever Demo",
      website: null,
      careersUrl: null,
      atsPlatform: "lever",
      boardToken: "leverdemo",
      active: true,
      notes: null,
    },
  ],
};

async function main(): Promise<void> {
  if (process.env.LIVE_SMOKE !== "1") {
    console.log(
      "Skipped: this smoke test hits public job boards. Set LIVE_SMOKE=1 to run it.",
    );
    return;
  }

  const adapters = createSourceRegistry();
  const failures: string[] = [];
  let pairs = 0;

  for (const [sourceId, adapter] of adapters) {
    for (const company of enabledCompaniesForSource(registry, sourceId)) {
      pairs += 1;
      try {
        const result = await adapter.fetchListings({ company, limit: 5 });
        for (const listing of result.listings) {
          if (!SourceListingSchema.safeParse(listing).success) {
            throw new Error("produced an invalid source listing");
          }
        }
        console.log(
          `[ok] ${sourceId} ${company.name}: ${result.listings.length} listing(s), ` +
            `${result.invalid} invalid, ${result.requestsMade} request(s)`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[FAIL] ${sourceId} ${company.name}: ${message}`);
        failures.push(`${sourceId}/${company.name}: ${message}`);
      }
    }
  }

  if (failures.length > 0) {
    console.error(`Smoke test failed (${failures.length}): ${failures.join("; ")}`);
    process.exit(1);
  }
  console.log(`Smoke test passed for ${pairs} source/company pair(s).`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});