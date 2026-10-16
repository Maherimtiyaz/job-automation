import type { NetworkClassification } from "./types.js";
import { BrowserUrlError } from "./errors.js";

export function validateInspectUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new BrowserUrlError(`Invalid URL: ${rawUrl}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BrowserUrlError(`Unsupported URL protocol: ${url.protocol}`);
  }

  if (url.username !== "" || url.password !== "") {
    throw new BrowserUrlError("URLs with embedded credentials are not allowed");
  }

  return url;
}

const LINK_LOCAL_IPV6 = /^fe[89ab]/i;
const UNIQUE_LOCAL_IPV6 = /^f[cd]/i;

export function classifyNetwork(hostnameOrUrl: string | URL): NetworkClassification {
  const rawHost = typeof hostnameOrUrl === "string" ? hostnameOrUrl : hostnameOrUrl.hostname;
  const host = rawHost.toLowerCase().replace(/\.$/, "");

  if (host === "localhost" || host.endsWith(".localhost") || host === "0.0.0.0") {
    return "localhost";
  }
  if (host.endsWith(".local")) {
    return "link_local";
  }

  if (host.includes(":")) {
    const ipv6 = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
    if (ipv6 === "::1") {
      return "localhost";
    }
    if (LINK_LOCAL_IPV6.test(ipv6)) {
      return "link_local";
    }
    if (UNIQUE_LOCAL_IPV6.test(ipv6)) {
      return "private";
    }
    return "public";
  }

  const octets = host.split(".").map((part) => Number(part));
  if (octets.length === 4 && octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)) {
    const first = octets[0];
    const second = octets[1];
    if (first === undefined) {
      return "public";
    }
    if (first === 127) {
      return "localhost";
    }
    if (first === 10) {
      return "private";
    }
    if (first === 172 && second !== undefined && second >= 16 && second <= 31) {
      return "private";
    }
    if (first === 192 && second === 168) {
      return "private";
    }
    if (first === 169 && second === 254) {
      return "link_local";
    }
  }

  return "public";
}

export function isPublicNetwork(network: NetworkClassification): boolean {
  return network === "public";
}