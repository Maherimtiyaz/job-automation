import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import {
  ConflictError,
  DomainError,
  NotFoundError,
  ValidationError,
  validationErrorFromZod,
} from "../domain/errors.js";
import {
  createEmptyResumeRegistry,
  ResumeDocumentSchema,
  ResumeRegistrySchema,
  RESUME_FILE_EXTENSIONS,
  slugifyResumeLabel,
  type ResumeDocument,
  type ResumeKind,
  type ResumeRegistry,
} from "../domain/resume.js";
import { nowIso } from "../domain/time.js";

const ALLOWED_EXTENSIONS = new Set<string>(RESUME_FILE_EXTENSIONS);

export class ResumeRegistryNotFoundError extends DomainError {
  readonly path: string;

  constructor(path: string) {
    super(`Resume registry not found: ${path}`);
    this.name = "ResumeRegistryNotFoundError";
    this.path = path;
  }
}

export function resumeRegistryExists(path: string): boolean {
  return existsSync(resolve(path));
}

export function loadResumeRegistry(path: string): ResumeRegistry {
  const target = resolve(path);
  if (!existsSync(target)) {
    throw new ResumeRegistryNotFoundError(target);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(target, "utf8"));
  } catch {
    throw new DomainError(`Resume registry is not valid JSON: ${target}`);
  }

  const parsed = ResumeRegistrySchema.safeParse(raw);
  if (!parsed.success) {
    throw validationErrorFromZod("Invalid resume registry", parsed.error);
  }
  return parsed.data;
}

export function tryLoadResumeRegistry(path: string): ResumeRegistry | null {
  if (!existsSync(resolve(path))) {
    return null;
  }
  return loadResumeRegistry(path);
}

export interface WriteResumeRegistryOptions {
  overwrite?: boolean;
}

export function writeResumeRegistryTemplate(
  path: string,
  options: WriteResumeRegistryOptions = {},
): string {
  const target = resolve(path);
  if (existsSync(target) && options.overwrite !== true) {
    throw new ConflictError(`Resume registry already exists: ${target}`);
  }

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(createEmptyResumeRegistry(), null, 2)}\n`, "utf8");
  return target;
}

export interface AddResumeInput {
  filePath: string;
  label?: string;
  id?: string;
  kind?: ResumeKind;
  isDefault?: boolean;
  notes?: string;
}

function writeResumeRegistry(path: string, registry: ResumeRegistry): void {
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
}

function assertRegistryExists(path: string): ResumeRegistry {
  return loadResumeRegistry(path);
}

function validateResumeFile(filePath: string): string {
  const target = resolve(filePath);
  if (!existsSync(target)) {
    throw new ValidationError("Invalid resume file", [`file not found: ${target}`]);
  }
  if (!statSync(target).isFile()) {
    throw new ValidationError("Invalid resume file", [`not a file: ${target}`]);
  }
  const extension = extname(target).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw new ValidationError("Invalid resume file", [
      `unsupported extension "${extension || "(none)"}" (allowed: ${RESUME_FILE_EXTENSIONS.join(", ")})`,
    ]);
  }
  return target;
}

function uniqueResumeId(registry: ResumeRegistry, base: string): string {
  const taken = new Set(registry.resumes.map((resume) => resume.id.toLowerCase()));
  if (!taken.has(base.toLowerCase())) {
    return base;
  }
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`.toLowerCase())) {
    suffix += 1;
  }
  return `${base}-${suffix}`;
}

function labelFromFile(filePath: string): string {
  const name = basename(filePath, extname(filePath)).trim();
  return name.length > 0 ? name : "resume";
}

export function addResumeToRegistry(path: string, input: AddResumeInput): ResumeDocument {
  const registry = assertRegistryExists(path);
  const filePath = validateResumeFile(input.filePath);
  const kind: ResumeKind = input.kind ?? "resume";
  const label = input.label ?? labelFromFile(filePath);

  const explicitId = input.id?.trim();
  let id: string;
  if (explicitId !== undefined && explicitId.length > 0) {
    if (registry.resumes.some((resume) => resume.id.toLowerCase() === explicitId.toLowerCase())) {
      throw new ConflictError(`Resume already in registry: ${explicitId}`);
    }
    id = explicitId;
  } else {
    id = uniqueResumeId(registry, slugifyResumeLabel(label));
  }

  const entry: ResumeDocument = {
    id,
    label,
    kind,
    filePath,
    isDefault: input.isDefault === true,
    notes: input.notes ?? null,
    createdAt: nowIso(),
  };

  const parsed = ResumeDocumentSchema.safeParse(entry);
  if (!parsed.success) {
    throw validationErrorFromZod("Invalid resume entry", parsed.error);
  }

  const resumes =
    input.isDefault === true
      ? registry.resumes.map((resume) =>
          resume.kind === kind ? { ...resume, isDefault: false } : resume,
        )
      : registry.resumes;

  writeResumeRegistry(path, { ...registry, resumes: [...resumes, parsed.data] });
  return parsed.data;
}

export function removeResumeFromRegistry(path: string, id: string): ResumeDocument {
  const registry = assertRegistryExists(path);
  const normalized = id.trim().toLowerCase();
  const index = registry.resumes.findIndex((resume) => resume.id.toLowerCase() === normalized);
  if (index === -1) {
    throw new NotFoundError("Resume", id);
  }

  const [removed] = registry.resumes.splice(index, 1);
  if (removed === undefined) {
    throw new NotFoundError("Resume", id);
  }
  writeResumeRegistry(path, registry);
  return removed;
}

export function setDefaultResume(path: string, id: string): ResumeDocument {
  const registry = assertRegistryExists(path);
  const normalized = id.trim().toLowerCase();
  const target = registry.resumes.find((resume) => resume.id.toLowerCase() === normalized);
  if (target === undefined) {
    throw new NotFoundError("Resume", id);
  }

  const resumes = registry.resumes.map((resume) => {
    if (resume.kind !== target.kind) {
      return resume;
    }
    return { ...resume, isDefault: resume.id === target.id };
  });

  writeResumeRegistry(path, { ...registry, resumes });
  return { ...target, isDefault: true };
}

export function listResumes(path: string): ResumeDocument[] {
  return assertRegistryExists(path).resumes;
}
