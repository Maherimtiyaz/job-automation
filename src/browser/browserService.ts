import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { chromium, type Browser, type Response } from "playwright";
import { detectAts } from "./ats.js";
import { BrowserLaunchError } from "./errors.js";
import { analyzePage, classifyPage, emptyPageParts, extractDomSource } from "./inspector.js";
import type {
  BrowserServiceOptions,
  InspectOperationOptions,
  InspectedPageParts,
  InspectionProblem,
  InspectionReport,
  InspectionWarning,
  NetworkClassification,
  RawDomInspection,
} from "./types.js";
import { classifyNetwork, validateInspectUrl } from "./urlPolicy.js";

const DEFAULT_OPTIONS: BrowserServiceOptions = {
  headless: true,
  navigationTimeoutMs: 15_000,
  operationTimeoutMs: 8_000,
};

const FATAL_KINDS = new Set(["navigation", "timeout", "unsupported_protocol", "browser"]);

interface PageWorkInput {
  browser: Browser;
  requested: URL;
  network: NetworkClassification;
  warnings: InspectionWarning[];
  problems: InspectionProblem[];
  navigationTimeoutMs: number;
  screenshot: string | true | undefined;
}

interface PageWorkResult {
  response: Response | null;
  finalUrl: string | null;
  raw: RawDomInspection | null;
  screenshotPath: string | null;
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

function hostnameOf(url: string | null, fallback: string): string {
  if (url === null) {
    return fallback;
  }
  try {
    return new URL(url).hostname;
  } catch {
    return fallback;
  }
}

function defaultScreenshotPath(): string {
  return join("screenshots", `inspect-${Date.now()}.png`);
}

interface DeadlineOutcome<T> {
  state: "done" | "failed" | "timeout";
  value?: T;
  error?: unknown;
}

class OperationTimeoutError extends Error {
  constructor() {
    super("Inspection operation timed out.");
    this.name = "OperationTimeoutError";
  }
}

async function runWithDeadline<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> {
  const op = operation();
  op.catch(() => {
    // Handle late rejections (e.g. from closing the context mid-navigation) so they
    // never surface as unhandled promise rejections after the deadline fires.
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race<DeadlineOutcome<T>>([
      op.then(
        (value) => ({ state: "done", value }) as const,
        (error: unknown) => ({ state: "failed", error }) as const,
      ),
      new Promise<DeadlineOutcome<T>>((resolve) => {
        timer = setTimeout(() => resolve({ state: "timeout" }), timeoutMs);
      }),
    ]);

    if (outcome.state === "timeout") {
      throw new OperationTimeoutError();
    }
    if (outcome.state === "failed") {
      throw outcome.error;
    }
    return outcome.value as T;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export class BrowserService {
  private readonly options: BrowserServiceOptions;
  private browser: Browser | null = null;

  constructor(options: Partial<BrowserServiceOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  async close(): Promise<void> {
    if (this.browser !== null) {
      await this.browser.close();
      this.browser = null;
    }
  }

  async inspect(urlInput: string, options: InspectOperationOptions = {}): Promise<InspectionReport> {
    const requested = validateInspectUrl(urlInput);
    const warnings: InspectionWarning[] = [];
    const problems: InspectionProblem[] = [];

    const network = classifyNetwork(requested.hostname);
    if (network !== "public") {
      warnings.push({
        message: `Target is on the "${network}" network (${requested.hostname}). Only inspect pages you trust.`,
      });
    }

    const browser = await this.launchOrGet();

    const navigationTimeoutMs = options.navigationTimeoutMs ?? this.options.navigationTimeoutMs;
    const operationTimeoutMs = options.operationTimeoutMs ?? this.options.operationTimeoutMs;
    const startedAt = performance.now();

    let work: PageWorkResult;
    try {
      work = await runWithDeadline(
        () =>
          this.performPageWork({
            browser,
            requested,
            network,
            warnings,
            problems,
            navigationTimeoutMs,
            screenshot: options.screenshot,
          }),
        operationTimeoutMs,
      );
    } catch (error) {
      if (error instanceof OperationTimeoutError) {
        problems.push({
          kind: "timeout",
          message: `Inspection operation exceeded ${operationTimeoutMs}ms and was aborted.`,
        });
        work = { response: null, finalUrl: null, raw: null, screenshotPath: null };
      } else {
        throw error;
      }
    }

    const loadDurationMs = Math.round(performance.now() - startedAt);
    const finalHostname = hostnameOf(work.finalUrl, requested.hostname);
    const parts: InspectedPageParts = work.raw !== null ? analyzePage(work.raw) : emptyPageParts();
    const ats = detectAts({ hostname: finalHostname, textSample: parts.textSample });
    const pageKind = classifyPage({ parts, ats });
    const hasApplicationForm: boolean | null =
      work.raw === null ? null : parts.forms.some((form) => form.fields.length > 0);

    const status = problems.some((problem) => FATAL_KINDS.has(problem.kind)) ? "failed" : "ok";

    return {
      status,
      requestedUrl: requested.href,
      finalUrl: work.finalUrl,
      httpStatus: work.response?.status() ?? null,
      title: work.raw?.title ?? null,
      loadDurationMs,
      network: classifyNetwork(finalHostname),
      ats,
      pageKind: pageKind.kind,
      pageKindReliability: pageKind.reliability,
      pageKindEvidence: pageKind.evidence,
      headings: parts.headings,
      links: parts.links,
      applyLinks: parts.applyLinks,
      forms: parts.forms,
      hasApplicationForm,
      screenshotPath: work.screenshotPath,
      hiddenFieldCount: parts.hiddenFieldCount,
      warnings,
      problems,
    };
  }

  private async performPageWork(input: PageWorkInput): Promise<PageWorkResult> {
    const context = await input.browser.newContext();
    const page = await context.newPage();
    try {
      let response: Response | null = null;
      let finalUrl: string | null = null;

      try {
        response = await page.goto(input.requested.href, {
          waitUntil: "domcontentloaded",
          timeout: input.navigationTimeoutMs,
        });
        finalUrl = page.url();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isTimeoutError(error)) {
          input.problems.push({
            kind: "timeout",
            message: `Navigation timed out after ${input.navigationTimeoutMs}ms: ${message}`,
          });
        } else {
          input.problems.push({ kind: "navigation", message: `Could not navigate: ${message}` });
        }
      }

      if (page.url() !== "about:blank") {
        finalUrl = page.url();
      }
      if (finalUrl !== null && finalUrl !== input.requested.href) {
        input.warnings.push({ message: `Redirected to ${finalUrl}.` });
        const finalSafety = inspectFinalUrl(finalUrl);
        if (finalSafety.problem !== null) {
          input.problems.push(finalSafety.problem);
        } else if (input.network === "public" && !finalSafety.isPublic) {
          input.warnings.push({
            message: `Redirected from a public address to the "${finalSafety.network}" network (${finalSafety.hostname}). Possible DNS rebinding.`,
          });
        }
      }

      if (response !== null) {
        const status = response.status();
        if (status === 404 || status === 410) {
          input.warnings.push({ message: `HTTP ${status}: the page may no longer exist.` });
        } else if (status >= 500) {
          input.warnings.push({ message: `HTTP ${status}: the server reported an error.` });
        }
      }

      let raw: RawDomInspection | null = null;
      try {
        raw = (await page.evaluate<RawDomInspection>(extractDomSource)) as RawDomInspection;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        input.problems.push({ kind: "browser", message: `Page contents could not be read: ${message}` });
      }

      let screenshotPath: string | null = null;
      if (input.screenshot !== undefined) {
        try {
          const target = input.screenshot === true ? defaultScreenshotPath() : input.screenshot;
          mkdirSync(dirname(target), { recursive: true });
          await page.screenshot({ path: target });
          screenshotPath = target;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          input.problems.push({ kind: "browser", message: `Screenshot failed: ${message}` });
        }
      }

      return { response, finalUrl, raw, screenshotPath };
    } finally {
      await context.close();
    }
  }

  private async launchOrGet(): Promise<Browser> {
    if (this.browser !== null) {
      return this.browser;
    }
    try {
      this.browser = await chromium.launch({ headless: this.options.headless });
      return this.browser;
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      throw new BrowserLaunchError(
        `Could not launch Chromium (headless: ${this.options.headless}). ` +
          `Install it with "npx playwright install chromium". Details: ${details}`,
      );
    }
  }
}

function inspectFinalUrl(url: string): {
  problem: InspectionProblem | null;
  network: string;
  hostname: string;
  isPublic: boolean;
} {
  try {
    const parsed = new URL(url);
    const protocol = parsed.protocol;
    if (protocol !== "http:" && protocol !== "https:") {
      return {
        problem: { kind: "unsupported_protocol", message: `Redirected to an unsupported protocol: ${url}` },
        network: "unsupported",
        hostname: parsed.hostname,
        isPublic: false,
      };
    }
    const network = classifyNetwork(parsed.hostname);
    return {
      problem: null,
      network,
      hostname: parsed.hostname,
      isPublic: network === "public",
    };
  } catch {
    return {
      problem: { kind: "unsupported_protocol", message: `Redirected to a URL that could not be parsed: ${url}` },
      network: "unsupported",
      hostname: "",
      isPublic: false,
    };
  }
}

let sharedInstance: BrowserService | null = null;

export function sharedBrowserService(): BrowserService {
  if (sharedInstance === null) {
    sharedInstance = new BrowserService();
  }
  return sharedInstance;
}

export async function closeSharedBrowserService(): Promise<void> {
  if (sharedInstance !== null) {
    await sharedInstance.close();
    sharedInstance = null;
  }
}