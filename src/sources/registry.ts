import type { SourceId } from "./types.js";
import type { JobSourceAdapter } from "./types.js";
import type { FetchJson } from "./http.js";
import { createFetchJson } from "./http.js";
import { GreenhouseAdapter } from "./greenhouse.js";
import { LeverAdapter } from "./lever.js";

export interface SourceRegistryOptions {
  fetchJson?: FetchJson;
}

export type SourceRegistry = ReadonlyMap<SourceId, JobSourceAdapter>;

export function createSourceRegistry(options: SourceRegistryOptions = {}): SourceRegistry {
  const fetchJson = options.fetchJson ?? createFetchJson();
  const registry = new Map<SourceId, JobSourceAdapter>();
  registry.set("greenhouse", new GreenhouseAdapter(fetchJson));
  registry.set("lever", new LeverAdapter(fetchJson));
  return registry;
}