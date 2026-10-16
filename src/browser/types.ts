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
}

export interface InspectOperationOptions {
  screenshot?: string | true;
  navigationTimeoutMs?: number;
  operationTimeoutMs?: number;
}

export interface BrowserServiceOptions {
  headless: boolean;
  navigationTimeoutMs: number;
  operationTimeoutMs: number;
}