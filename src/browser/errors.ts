import { DomainError } from "../domain/errors.js";

export class BrowserUrlError extends DomainError {
  constructor(message: string) {
    super(message);
    this.name = "BrowserUrlError";
  }
}

export class BrowserLaunchError extends DomainError {
  constructor(message: string) {
    super(message);
    this.name = "BrowserLaunchError";
  }
}