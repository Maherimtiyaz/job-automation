import type { InspectedLink } from "./types.js";

export interface ApplyTargetCandidate {
  url: string;
  text: string;
  crossOrigin: boolean;
}

export interface ApplyTargetResolution {
  url: string | null;
  text: string | null;
  candidates: readonly ApplyTargetCandidate[];
  reason: string;
}

function parseHttpUrl(raw: string): URL | null {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    if (url.username !== "" || url.password !== "") {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

/**
 * Deterministically choose the application target for a job page.
 *
 * `applyLinks` are the links the inspector already flagged as apply links; they
 * win. As a fallback, any link with an `applyHint` is considered. The page's own
 * URL, non-HTTP(S) URLs, credentialed URLs, and duplicates are ignored. The
 * first remaining candidate is selected.
 *
 * Pure: performs no I/O and reads no page values.
 */
export function resolveApplyTarget(input: {
  pageUrl: string;
  applyLinks: readonly InspectedLink[];
  links?: readonly InspectedLink[];
}): ApplyTargetResolution {
  const page = parseHttpUrl(input.pageUrl);
  const seen = new Set<string>();
  const candidates: ApplyTargetCandidate[] = [];

  const consider = (link: InspectedLink): void => {
    const parsed = parseHttpUrl(link.url);
    if (parsed === null) {
      return;
    }
    const href = parsed.href;
    if (page !== null && href === page.href) {
      return;
    }
    if (seen.has(href)) {
      return;
    }
    seen.add(href);
    candidates.push({
      url: href,
      text: link.text,
      crossOrigin: page !== null && parsed.hostname !== page.hostname,
    });
  };

  for (const link of input.applyLinks) {
    consider(link);
  }
  for (const link of input.links ?? []) {
    if (link.applyHint) {
      consider(link);
    }
  }

  const best = candidates[0];
  if (best === undefined) {
    return {
      url: null,
      text: null,
      candidates,
      reason: "No application link was found on the page.",
    };
  }

  const origin = best.crossOrigin ? "cross-origin " : "";
  return {
    url: best.url,
    text: best.text,
    candidates,
    reason: `Selected the first ${origin}application link ("${best.text}").`,
  };
}
