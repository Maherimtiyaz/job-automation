import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import {
  ConflictError,
  DomainError,
  NotFoundError,
  validationErrorFromZod,
} from "../domain/errors.js";
import { HttpUrlSchema, normalizeCompanyName } from "../domain/normalize.js";
import { SOURCE_IDS, type SourceId } from "../sources/types.js";

export const ATS_PLATFORMS = [...SOURCE_IDS, "other"] as const;

export type AtsPlatform = (typeof ATS_PLATFORMS)[number];

export const CompanyRegistryEntrySchema = z
  .object({
    name: z.string().trim().min(1, "company name must not be empty"),
    website: HttpUrlSchema.nullish(),
    careersUrl: HttpUrlSchema.nullish(),
    atsPlatform: z.enum(ATS_PLATFORMS).default("other"),
    boardToken: z.string().trim().min(1).nullish(),
    active: z.boolean().default(true),
    notes: z.string().nullish(),
  })
  .superRefine((entry, ctx) => {
    if (entry.atsPlatform !== "other" && !entry.boardToken) {
      ctx.addIssue({
        code: "custom",
        path: ["boardToken"],
        message: `A board token is required for ATS platform "${entry.atsPlatform}"`,
      });
    }
  });

export type CompanyRegistryEntry = z.infer<typeof CompanyRegistryEntrySchema>;

export const CompanyRegistrySchema = z.object({
  version: z.literal(1),
  companies: z.array(CompanyRegistryEntrySchema).default([]),
});

export type CompanyRegistry = z.infer<typeof CompanyRegistrySchema>;

export function createEmptyRegistry(): CompanyRegistry {
  return CompanyRegistrySchema.parse({ version: 1, companies: [] });
}

export class RegistryNotFoundError extends DomainError {
  readonly path: string;

  constructor(path: string) {
    super(`Company registry not found: ${path}`);
    this.name = "RegistryNotFoundError";
    this.path = path;
  }
}

export function registryExists(path: string): boolean {
  return existsSync(resolve(path));
}

export function loadRegistry(path: string): CompanyRegistry {
  const target = resolve(path);
  if (!existsSync(target)) {
    throw new RegistryNotFoundError(target);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(target, "utf8"));
  } catch {
    throw new DomainError(`Company registry is not valid JSON: ${target}`);
  }

  const parsed = CompanyRegistrySchema.safeParse(raw);
  if (!parsed.success) {
    throw validationErrorFromZod("Invalid company registry", parsed.error);
  }
  return parsed.data;
}

export interface WriteRegistryOptions {
  overwrite?: boolean;
}

export function writeRegistryTemplate(
  path: string,
  options: WriteRegistryOptions = {},
): string {
  const target = resolve(path);
  if (existsSync(target) && options.overwrite !== true) {
    throw new ConflictError(`Company registry already exists: ${target}`);
  }

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(createEmptyRegistry(), null, 2)}\n`, "utf8");
  return target;
}

export interface AddCompanyInput {
  name: string;
  website?: string;
  careersUrl?: string;
  atsPlatform?: AtsPlatform;
  boardToken?: string;
  active?: boolean;
  notes?: string;
}

function buildEntry(input: AddCompanyInput): CompanyRegistryEntry {
  const raw = {
    name: input.name,
    website: input.website ?? null,
    careersUrl: input.careersUrl ?? null,
    atsPlatform: input.atsPlatform ?? "other",
    boardToken: input.boardToken ?? null,
    active: input.active ?? true,
    notes: input.notes ?? null,
  };
  const parsed = CompanyRegistryEntrySchema.safeParse(raw);
  if (!parsed.success) {
    throw validationErrorFromZod("Invalid company registry entry", parsed.error);
  }
  return parsed.data;
}

function writeRegistry(path: string, registry: CompanyRegistry): void {
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
}

function assertRegistryExists(path: string): CompanyRegistry {
  return loadRegistry(path);
}

export function addCompanyToRegistry(
  path: string,
  input: AddCompanyInput,
): CompanyRegistryEntry {
  const registry = assertRegistryExists(path);
  const entry = buildEntry(input);
  const normalized = normalizeCompanyName(entry.name);

  if (
    registry.companies.some(
      (existing) => normalizeCompanyName(existing.name) === normalized,
    )
  ) {
    throw new ConflictError(`Company already in registry: ${entry.name}`);
  }

  const updated: CompanyRegistry = {
    ...registry,
    companies: [...registry.companies, entry],
  };
  writeRegistry(path, updated);
  return entry;
}

export function setCompanyActive(
  path: string,
  name: string,
  active: boolean,
): CompanyRegistryEntry {
  const registry = assertRegistryExists(path);
  const normalized = normalizeCompanyName(name);

  const index = registry.companies.findIndex(
    (existing) => normalizeCompanyName(existing.name) === normalized,
  );
  if (index === -1) {
    throw new NotFoundError("Company registry entry", name);
  }

  const current = registry.companies[index];
  if (current === undefined) {
    throw new NotFoundError("Company registry entry", name);
  }

  const updatedEntry: CompanyRegistryEntry = { ...current, active };
  const companies = [...registry.companies];
  companies[index] = updatedEntry;

  writeRegistry(path, { ...registry, companies });
  return updatedEntry;
}

export function listCompanies(path: string): CompanyRegistryEntry[] {
  return assertRegistryExists(path).companies;
}

export function enabledCompaniesForSource(
  registry: CompanyRegistry,
  source: SourceId,
): CompanyRegistryEntry[] {
  return registry.companies.filter(
    (company) => company.active && company.atsPlatform === source,
  );
}