export type NetworkClassification = "localhost" | "private" | "link_local" | "public";

export type InspectionProblemKind =
  | "validation"
  | "navigation"
  | "timeout"
  | "unsupported_protocol"
  | "browser";

export interface InspectionProblem {
  kind: InspectionProblemKind;
  message: string;
}

export interface InspectionWarning {
  message: string;
}

export type AtsConfidence = "high" | "medium" | "low";

export interface AtsVerdict {
  platform: string;
  confidence: AtsConfidence;
  signals: readonly string[];
}

export type PageKind = "job_detail" | "application_form" | "unknown";

export type PageKindReliability = "observed" | "heuristic";

export type FieldKind = "input" | "textarea" | "select" | "button" | "other";

export interface InspectedField {
  id: string;
  kind: FieldKind;
  inputType: string | null;
  name: string | null;
  label: string | null;
  placeholder: string | null;
  autocomplete: string | null;
  required: boolean | null;
  readonly: boolean;
  disabled: boolean;
  sensitive: boolean;
  selectOptions: readonly string[] | null;
}

export interface InspectedForm {
  action: string | null;
  method: string | null;
  fields: readonly InspectedField[];
  submitButtons: readonly string[];
  note: string | null;
}

export interface InspectedLink {
  text: string;
  url: string;
  applyHint: boolean;
}

export interface RawDomField {
  kind: "input" | "textarea" | "select";
  inputType: string | null;
  name: string | null;
  label: string | null;
  placeholder: string | null;
  autocomplete: string | null;
  requiredAttr: boolean;
  ariaRequired: boolean;
  readonly: boolean;
  disabled: boolean;
  hidden: boolean;
  selectOptionTexts: readonly string[];
}

export interface RawDomForm {
  action: string | null;
  method: string | null;
  fields: readonly RawDomField[];
  submitButtons: readonly string[];
}

export interface RawDomInspection {
  title: string | null;
  headings: readonly string[];
  links: readonly { text: string; href: string }[];
  forms: readonly RawDomForm[];
  textSample: string;
  hiddenInputCountTotal: number;
}

export interface InspectedPageParts {
  headings: readonly string[];
  links: readonly InspectedLink[];
  applyLinks: readonly InspectedLink[];
  forms: readonly InspectedForm[];
  hiddenFieldCount: number;
  textSample: string;
}

export type FillTarget =
  | "fullName"
  | "firstName"
  | "lastName"
  | "email"
  | "phone"
  | "location"
  | "headline"
  | "linkedinUrl"
  | "githubUrl"
  | "websiteUrl"
  | "minimumSalary"
  | "resume"
  | "coverLetter";

export type FillDecision = "PROVIDE" | "NEEDS_INPUT" | "SKIP";

export type FillMatchConfidence = "autocomplete" | "inputType" | "name" | "label" | "placeholder";

export type FillDocumentKind = "resume" | "cover_letter";

export interface FillDocumentRef {
  id: string;
  label: string;
  kind: FillDocumentKind;
  fileName: string;
}

export interface FillPlanEntry {
  field: string;
  kind: FieldKind;
  inputType: string | null;
  name: string | null;
  label: string | null;
  required: boolean;
  sensitive: boolean;
  target: FillTarget | null;
  decision: FillDecision;
  value: string | null;
  valueHidden: boolean;
  confidence: FillMatchConfidence | null;
  document?: FillDocumentRef | null;
  reason: string;
}

export interface FillPlanSummary {
  forms: number;
  fields: number;
  provide: number;
  needsInput: number;
  skip: number;
  requiredNeedsInput: number;
}

export interface FillPlan {
  profileLoaded: boolean;
  pageKind: PageKind;
  hasApplicationForm: boolean | null;
  summary: FillPlanSummary;
  entries: readonly FillPlanEntry[];
  warnings: readonly InspectionWarning[];
}

export interface InspectionReport {
  status: "ok" | "failed";
  requestedUrl: string;
  finalUrl: string | null;
  httpStatus: number | null;
  title: string | null;
  loadDurationMs: number;
  network: NetworkClassification;
  ats: AtsVerdict;
  pageKind: PageKind;
  pageKindReliability: PageKindReliability;
  pageKindEvidence: readonly string[];
  headings: readonly string[];
  links: readonly InspectedLink[];
  applyLinks: readonly InspectedLink[];
  forms: readonly InspectedForm[];
  hasApplicationForm: boolean | null;
  screenshotPath: string | null;
  hiddenFieldCount: number;
  warnings: readonly InspectionWarning[];
  problems: readonly InspectionProblem[];
  fillPlan?: FillPlan | null;
}

export interface InspectOperationOptions {
  screenshot?: string | true;
  navigationTimeoutMs?: number;
  operationTimeoutMs?: number;
  settleTimeoutMs?: number;
}

export interface BrowserServiceOptions {
  headless: boolean;
  navigationTimeoutMs: number;
  operationTimeoutMs: number;
  /**
   * Upper bound on the post-navigation settle window. Client-rendered
   * application pages (Ashby, Workday, ...) fetch and mount their form after
   * `domcontentloaded`, so the DOM is inspected only after the page has
   * stopped loading for a moment or the window is exhausted.
   */
  settleTimeoutMs: number;
}