import { z } from "zod";
import { DomainError } from "./errors.js";

export const HttpUrlSchema = z.httpUrl();

const COMPANY_SUFFIXES = new Set([
  "inc",
  "llc",
  "ltd",
  "limited",
  "corp",
  "corporation",
  "co",
  "gmbh",
  "ag",
  "sa",
  "srl",
  "bv",
  "plc",
  "pte",
  "pty",
]);

const TRACKING_QUERY_PARAMS = new Set(["gclid", "fbclid", "msclkid", "yclid", "mc_cid", "mc_eid"]);

export function normalizeCompanyName(name: string): string {
  const lowered = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  const words = lowered
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);

  while (words.length > 1) {
    const last = words[words.length - 1];
    if (last === undefined || !COMPANY_SUFFIXES.has(last)) {
      break;
    }
    words.pop();
  }

  const normalized = words.join(" ");
  if (normalized.length === 0) {
    throw new DomainError(`Company name "${name}" normalizes to an empty string`);
  }
  return normalized;
}

export function normalizeSource(source: string): string {
  return source.trim().toLowerCase();
}

export function normalizeExternalJobId(externalJobId: string): string {
  return externalJobId.trim();
}

function isTrackingParam(key: string): boolean {
  const normalized = key.toLowerCase();
  return normalized.startsWith("utm_") || TRACKING_QUERY_PARAMS.has(normalized);
}

export function canonicalizeUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new DomainError(`Invalid URL: ${rawUrl}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new DomainError(`Unsupported URL protocol: ${url.protocol}`);
  }

  url.hostname = url.hostname.toLowerCase();
  url.hash = "";

  const retained = [...url.searchParams.entries()]
    .filter(([key]) => !isTrackingParam(key))
    .sort(([left], [right]) => left.localeCompare(right));

  url.search = "";
  for (const [key, value] of retained) {
    url.searchParams.append(key, value);
  }

  url.pathname = url.pathname.replace(/\/+$/, "") || "/";

  return url.toString();
}

export interface JobIdentity {
  source: string;
  externalJobId: string | null;
  canonicalUrl: string;
}

export function buildJobDedupeKey(identity: JobIdentity): string {
  const externalJobId = identity.externalJobId?.trim() ?? "";
  if (externalJobId.length > 0) {
    return `ext:${normalizeSource(identity.source)}:${externalJobId}`;
  }
  return `url:${identity.canonicalUrl}`;
}
