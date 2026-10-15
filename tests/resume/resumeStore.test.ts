import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConflictError, DomainError, NotFoundError, ValidationError } from "../../src/domain/errors.js";
import {
  createEmptyResumeRegistry,
  defaultResumeForKind,
  findResume,
  ResumeRegistrySchema,
  slugifyResumeLabel,
} from "../../src/domain/resume.js";
import {
  addResumeToRegistry,
  listResumes,
  loadResumeRegistry,
  removeResumeFromRegistry,
  resumeRegistryExists,
  ResumeRegistryNotFoundError,
  setDefaultResume,
  tryLoadResumeRegistry,
  writeResumeRegistryTemplate,
} from "../../src/resume/resumeStore.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "jobauto-resume-"));
}

function cleanup(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

function resumeFile(dir: string, name = "Ada_Resume.pdf"): string {
  const path = join(dir, name);
  writeFileSync(path, "%PDF-1.4 fake resume bytes", "utf8");
  return path;
}

test("writes a starter resume registry template", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "resumes.json");

    assert.equal(writeResumeRegistryTemplate(path), path);
    assert.equal(resumeRegistryExists(path), true);
    assert.deepEqual(loadResumeRegistry(path), createEmptyResumeRegistry());

    assert.throws(() => writeResumeRegistryTemplate(path), /already exists/i);
    assert.equal(writeResumeRegistryTemplate(path, { overwrite: true }), path);
  } finally {
    cleanup(dir);
  }
});

test("loadResumeRegistry reports missing and malformed files", () => {
  const dir = tempDir();
  try {
    const missing = join(dir, "missing.json");
    assert.throws(() => loadResumeRegistry(missing), ResumeRegistryNotFoundError);
    assert.equal(tryLoadResumeRegistry(missing), null);

    const malformed = join(dir, "malformed.json");
    writeFileSync(malformed, "{ not json", "utf8");
    assert.throws(() => loadResumeRegistry(malformed), DomainError);
    assert.throws(() => tryLoadResumeRegistry(malformed), DomainError);
  } finally {
    cleanup(dir);
  }
});

test("addResumeToRegistry derives an id and label from the file", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "resumes.json");
    writeResumeRegistryTemplate(path);

    const added = addResumeToRegistry(path, { filePath: resumeFile(dir) });

    assert.equal(added.id, "ada-resume");
    assert.equal(added.label, "Ada_Resume");
    assert.equal(added.kind, "resume");
    assert.equal(added.isDefault, false);
    assert.ok(added.filePath.endsWith("Ada_Resume.pdf"));
    assert.ok(added.createdAt.length > 0);

    assert.deepEqual(listResumes(path), [added]);
  } finally {
    cleanup(dir);
  }
});

test("addResumeToRegistry rejects missing files and unsupported extensions", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "resumes.json");
    writeResumeRegistryTemplate(path);

    assert.throws(
      () => addResumeToRegistry(path, { filePath: join(dir, "nope.pdf") }),
      ValidationError,
    );

    const exe = join(dir, "resume.exe");
    writeFileSync(exe, "binary", "utf8");
    assert.throws(() => addResumeToRegistry(path, { filePath: exe }), ValidationError);
  } finally {
    cleanup(dir);
  }
});

test("derived ids stay unique", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "resumes.json");
    writeResumeRegistryTemplate(path);

    const first = addResumeToRegistry(path, { filePath: resumeFile(dir), label: "Resume" });
    const second = addResumeToRegistry(path, { filePath: resumeFile(dir, "resume2.pdf"), label: "Resume" });

    assert.equal(first.id, "resume");
    assert.equal(second.id, "resume-2");
  } finally {
    cleanup(dir);
  }
});

test("explicit ids must be unique", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "resumes.json");
    writeResumeRegistryTemplate(path);

    addResumeToRegistry(path, { filePath: resumeFile(dir), id: "primary" });
    assert.throws(
      () => addResumeToRegistry(path, { filePath: resumeFile(dir, "other.pdf"), id: "primary" }),
      ConflictError,
    );
  } finally {
    cleanup(dir);
  }
});

test("marking a default clears the previous default for the same kind only", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "resumes.json");
    writeResumeRegistryTemplate(path);

    addResumeToRegistry(path, { filePath: resumeFile(dir, "a.pdf"), id: "resume-a", isDefault: true });
    addResumeToRegistry(path, { filePath: resumeFile(dir, "b.pdf"), id: "resume-b", isDefault: true });
    addResumeToRegistry(path, { filePath: resumeFile(dir, "cover.pdf"), id: "cover-a", kind: "cover_letter", isDefault: true });

    const resumes = listResumes(path);
    assert.equal(resumes.find((r) => r.id === "resume-a")?.isDefault, false);
    assert.equal(resumes.find((r) => r.id === "resume-b")?.isDefault, true);
    assert.equal(resumes.find((r) => r.id === "cover-a")?.isDefault, true);

    const registry = loadResumeRegistry(path);
    assert.equal(defaultResumeForKind(registry, "resume")?.id, "resume-b");
    assert.equal(defaultResumeForKind(registry, "cover_letter")?.id, "cover-a");
  } finally {
    cleanup(dir);
  }
});

test("setDefaultResume switches the default within a kind", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "resumes.json");
    writeResumeRegistryTemplate(path);

    addResumeToRegistry(path, { filePath: resumeFile(dir, "a.pdf"), id: "resume-a" });
    addResumeToRegistry(path, { filePath: resumeFile(dir, "b.pdf"), id: "resume-b" });

    const updated = setDefaultResume(path, "resume-b");
    assert.equal(updated.isDefault, true);
    assert.equal(defaultResumeForKind(loadResumeRegistry(path), "resume")?.id, "resume-b");

    assert.equal(setDefaultResume(path, "resume-a").id, "resume-a");
    assert.equal(listResumes(path).find((r) => r.id === "resume-b")?.isDefault, false);

    assert.throws(() => setDefaultResume(path, "missing"), NotFoundError);
  } finally {
    cleanup(dir);
  }
});

test("removeResumeFromRegistry removes by id and reports missing ids", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "resumes.json");
    writeResumeRegistryTemplate(path);

    addResumeToRegistry(path, { filePath: resumeFile(dir), id: "primary" });
    const removed = removeResumeFromRegistry(path, "PRIMARY");
    assert.equal(removed.id, "primary");
    assert.equal(listResumes(path).length, 0);

    assert.throws(() => removeResumeFromRegistry(path, "primary"), NotFoundError);
  } finally {
    cleanup(dir);
  }
});

test("registers resume entries that validate against the schema", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "resumes.json");
    writeResumeRegistryTemplate(path);
    addResumeToRegistry(path, { filePath: resumeFile(dir), isDefault: true, notes: "primary" });

    const parsed = ResumeRegistrySchema.safeParse(JSON.parse(JSON.stringify(loadResumeRegistry(path))));
    assert.equal(parsed.success, true);
  } finally {
    cleanup(dir);
  }
});

test("pure resume helpers resolve by id and default", () => {
  const registry = ResumeRegistrySchema.parse({
    version: 1,
    resumes: [
      { id: "a", label: "A", kind: "resume", filePath: "/a.pdf", isDefault: false, createdAt: "t" },
      { id: "b", label: "B", kind: "resume", filePath: "/b.pdf", isDefault: true, createdAt: "t" },
      { id: "c", label: "C", kind: "cover_letter", filePath: "/c.pdf", isDefault: true, createdAt: "t" },
    ],
  });

  assert.equal(findResume(registry, "A")?.id, "a");
  assert.equal(findResume(registry, "missing"), null);
  assert.equal(defaultResumeForKind(registry, "resume")?.id, "b");
  assert.equal(defaultResumeForKind(registry, "cover_letter")?.id, "c");
  assert.equal(slugifyResumeLabel("  My Résumé (2026)  "), "my-resume-2026");
  assert.equal(slugifyResumeLabel("***"), "resume");
  assert.equal(findResume(createEmptyResumeRegistry(), "a"), null);
});
