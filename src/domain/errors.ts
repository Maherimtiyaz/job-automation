import type { ZodError } from "zod";

export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainError";
  }
}

export class ValidationError extends DomainError {
  readonly issues: readonly string[];

  constructor(context: string, issues: readonly string[]) {
    super(`${context}: ${issues.join("; ")}`);
    this.name = "ValidationError";
    this.issues = issues;
  }
}

export function validationErrorFromZod(context: string, error: ZodError): ValidationError {
  const issues = error.issues.map(
    (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
  );
  return new ValidationError(context, issues);
}

export class NotFoundError extends DomainError {
  constructor(entity: string, id: number | string) {
    super(`${entity} not found: ${id}`);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends DomainError {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

export class InvalidStatusTransitionError extends DomainError {
  readonly from: string;
  readonly to: string;

  constructor(from: string, to: string) {
    super(`Invalid status transition: ${from} -> ${to}`);
    this.name = "InvalidStatusTransitionError";
    this.from = from;
    this.to = to;
  }
}
