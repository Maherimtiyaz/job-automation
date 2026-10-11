import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ConflictError, DomainError, validationErrorFromZod } from "../domain/errors.js";
import type { CandidateProfile } from "../domain/profile.js";
import { CandidateProfileSchema, createEmptyProfile } from "../domain/profile.js";

export class ProfileNotFoundError extends DomainError {
  readonly path: string;

  constructor(path: string) {
    super(`Profile not found: ${path}`);
    this.name = "ProfileNotFoundError";
    this.path = path;
  }
}

export function profileExists(path: string): boolean {
  return existsSync(resolve(path));
}

export function loadProfileFromFile(path: string): CandidateProfile {
  const target = resolve(path);
  if (!existsSync(target)) {
    throw new ProfileNotFoundError(target);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(target, "utf8"));
  } catch {
    throw new DomainError(`Profile file is not valid JSON: ${target}`);
  }

  const parsed = CandidateProfileSchema.safeParse(raw);
  if (!parsed.success) {
    throw validationErrorFromZod("Invalid profile", parsed.error);
  }
  return parsed.data;
}

export interface WriteProfileOptions {
  overwrite?: boolean;
}

export function writeProfileTemplate(path: string, options: WriteProfileOptions = {}): string {
  const target = resolve(path);
  if (existsSync(target) && options.overwrite !== true) {
    throw new ConflictError(`Profile already exists: ${target}`);
  }

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(createEmptyProfile(), null, 2)}\n`, "utf8");
  return target;
}
