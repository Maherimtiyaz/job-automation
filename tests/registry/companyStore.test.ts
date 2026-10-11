import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ValidationError } from "../../src/domain/errors.js";
import {
  RegistryNotFoundError,
  addCompanyToRegistry,
  createEmptyRegistry,
  enabledCompaniesForSource,
  listCompanies,
  loadRegistry,
  registryExists,
  setCompanyActive,
  writeRegistryTemplate,
} from "../../src/registry/companyStore.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "jobauto-registry-"));
}

function cleanup(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

test("writes a starter registry template", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "companies.json");

    assert.equal(writeRegistryTemplate(path), path);
    assert.equal(registryExists(path), true);
    assert.deepEqual(loadRegistry(path), createEmptyRegistry());

    assert.throws(() => writeRegistryTemplate(path), /already exists/i);
    assert.equal(writeRegistryTemplate(path, { overwrite: true }), path);
  } finally {
    cleanup(dir);
  }
});

test("loadRegistry throws RegistryNotFoundError for a missing file", () => {
  const dir = tempDir();
  try {
    assert.throws(() => loadRegistry(join(dir, "missing.json")), RegistryNotFoundError);
  } finally {
    cleanup(dir);
  }
});

test("addCompanyToRegistry persists the entry", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "companies.json");
    writeRegistryTemplate(path);

    const added = addCompanyToRegistry(path, {
      name: "Acme",
      atsPlatform: "greenhouse",
      boardToken: "acmeboard",
      website: "https://acme.test",
    });

    assert.equal(added.name, "Acme");
    assert.equal(added.atsPlatform, "greenhouse");
    assert.equal(added.boardToken, "acmeboard");
    assert.equal(added.active, true);

    const loaded = loadRegistry(path);
    assert.equal(loaded.companies.length, 1);
    assert.equal(loaded.companies[0]?.website, "https://acme.test");
  } finally {
    cleanup(dir);
  }
});

test("rejects duplicate companies using normalized names", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "companies.json");
    writeRegistryTemplate(path);
    addCompanyToRegistry(path, { name: "Acme Corp" });

    assert.throws(
      () => addCompanyToRegistry(path, { name: "acme, Inc." }),
      /already in registry/i,
    );
  } finally {
    cleanup(dir);
  }
});

test("requires a board token for non-other ATS platforms", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "companies.json");
    writeRegistryTemplate(path);

    assert.throws(
      () => addCompanyToRegistry(path, { name: "Acme", atsPlatform: "greenhouse" }),
      ValidationError,
    );

    addCompanyToRegistry(path, { name: "Other Firm", atsPlatform: "other" });
    assert.equal(listCompanies(path)[0]?.boardToken, null);
  } finally {
    cleanup(dir);
  }
});

test("enable/disable toggles the active flag", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "companies.json");
    writeRegistryTemplate(path);
    addCompanyToRegistry(path, {
      name: "Acme",
      atsPlatform: "greenhouse",
      boardToken: "acme",
    });

    assert.equal(setCompanyActive(path, "Acme", false).active, false);
    assert.equal(listCompanies(path)[0]?.active, false);
    assert.equal(setCompanyActive(path, "acme", true).active, true);

    assert.throws(() => setCompanyActive(path, "Missing", true), /not found/i);
  } finally {
    cleanup(dir);
  }
});

test("enabledCompaniesForSource filters by platform and active flag", () => {
  const registry = {
    version: 1 as const,
    companies: [
      {
        name: "GH Enabled",
        website: null,
        careersUrl: null,
        atsPlatform: "greenhouse" as const,
        boardToken: "gh",
        active: true,
        notes: null,
      },
      {
        name: "GH Disabled",
        website: null,
        careersUrl: null,
        atsPlatform: "greenhouse" as const,
        boardToken: "gh2",
        active: false,
        notes: null,
      },
      {
        name: "Lever On",
        website: null,
        careersUrl: null,
        atsPlatform: "lever" as const,
        boardToken: "lv",
        active: true,
        notes: null,
      },
      {
        name: "Other",
        website: null,
        careersUrl: null,
        atsPlatform: "other" as const,
        boardToken: null,
        active: true,
        notes: null,
      },
    ],
  };

  const greenhouse = enabledCompaniesForSource(registry, "greenhouse");
  const lever = enabledCompaniesForSource(registry, "lever");

  assert.deepEqual(greenhouse.map((c) => c.name), ["GH Enabled"]);
  assert.deepEqual(lever.map((c) => c.name), ["Lever On"]);
});