import { SourceError, SourceHttpError } from "./types.js";

export interface FetchJsonOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

export interface FetchJson {
  (url: string, options?: FetchJsonOptions): Promise<unknown>;
}

export const DEFAULT_TIMEOUT_MS = 15000;

export function createFetchJson(timeoutMs: number = DEFAULT_TIMEOUT_MS): FetchJson {
  return async (url, options) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options?.timeoutMs ?? timeoutMs);
    const incoming = options?.signal;
    const onIncomingAbort = (): void => controller.abort();

    if (incoming && incoming.aborted) {
      controller.abort();
    } else {
      incoming?.addEventListener("abort", onIncomingAbort, { once: true });
    }

    try {
      let response: Response;
      try {
        response = await fetch(url, {
          headers: { accept: "application/json", ...options?.headers },
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) {
          throw new SourceHttpError(0, url, "request was aborted or timed out");
        }
        throw new SourceHttpError(0, url, error instanceof Error ? error.message : String(error));
      }

      if (!response.ok) {
        throw new SourceHttpError(response.status, url);
      }

      try {
        return await response.json();
      } catch {
        throw new SourceError(`Invalid JSON from ${url}`);
      }
    } finally {
      clearTimeout(timer);
      incoming?.removeEventListener("abort", onIncomingAbort);
    }
  };
}