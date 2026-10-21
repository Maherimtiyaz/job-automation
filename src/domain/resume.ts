import { z } from "zod";

export const RESUME_KINDS = ["resume", "cover_letter"] as const;

export type ResumeKind = (typeof RESUME_KINDS)[number];

export const ResumeKindSchema = z.enum(RESUME_KINDS);

export const RESUME_FILE_EXTENSIONS = [".pdf", ".doc", ".docx", ".txt", ".md", ".rtf", ".odt"] as const;

export const ResumeDocumentSchema = z.object({
  id: z
    .string()
    .trim()
    .min(1, "resume id must not be empty")
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "resume id may contain letters, digits, dot, dash, underscore"),
  label: z.string().trim().min(1, "resume label must not be empty"),
  kind: ResumeKindSchema.default("resume"),
  filePath: z.string().trim().min(1, "resume file path must not be empty"),
  isDefault: z.boolean().default(false),
  notes: z.string().nullish(),
  createdAt: z.string().trim().min(1),
});

export type ResumeDocument = z.infer<typeof ResumeDocumentSchema>;

export const ResumeRegistrySchema = z.object({
  version: z.literal(1),
  resumes: z.array(ResumeDocumentSchema).default([]),
});

export type ResumeRegistry = z.infer<typeof ResumeRegistrySchema>;

export function createEmptyResumeRegistry(): ResumeRegistry {
  return ResumeRegistrySchema.parse({ version: 1, resumes: [] });
}

export function slugifyResumeLabel(label: string): string {
  const slug = label
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return slug.length > 0 ? slug : "resume";
}

export function findResume(registry: ResumeRegistry, id: string): ResumeDocument | null {
  const normalized = id.trim().toLowerCase();
  return (
    registry.resumes.find((resume) => resume.id.toLowerCase() === normalized) ?? null
  );
}

export function defaultResumeForKind(
  registry: ResumeRegistry,
  kind: ResumeKind,
): ResumeDocument | null {
  return (
    registry.resumes.find((resume) => resume.kind === kind && resume.isDefault) ?? null
  );
}
