import type {
  InspectedField,
  InspectedForm,
  InspectedLink,
  InspectedPageParts,
  PageKind,
  PageKindReliability,
  RawDomField,
  RawDomInspection,
  AtsVerdict,
} from "./types.js";

const MAX_HEADINGS = 20;
const MAX_LINKS = 80;
const MAX_APPLY_LINKS = 20;
const MAX_FORMS = 10;
const MAX_FIELDS_PER_FORM = 50;
const MAX_SUBMIT_BUTTONS = 10;
const TEXT_SAMPLE_LIMIT = 40_000;

export const extractDomSource: string = `
(function () {
  const win = globalThis;
  const doc = win.document;
  if (doc === undefined) {
    return { title: null, headings: [], links: [], forms: [], textSample: "", hiddenInputCountTotal: 0 };
  }

  const cleanText = function (raw) {
    return (raw === null || raw === undefined ? "" : String(raw)).replace(/\\s+/g, " ").trim();
  };

  const resolveUrl = function (raw, base) {
    if (raw === null || raw.trim() === "") {
      return null;
    }
    const abs = raw.trim();
    try {
      if (/^[a-z][a-z0-9+.-]*:/i.test(abs)) {
        return abs;
      }
      return new URL(abs, base).href;
    } catch (e) {
      return raw.trim();
    }
  };

  const title = cleanText(doc.title) || null;

  const headings = [];
  const headingNodes = doc.querySelectorAll("h1,h2,h3,h4,h5,h6");
  for (let i = 0; i < headingNodes.length; i += 1) {
    const node = headingNodes[i];
    if (node === undefined || node === null) continue;
    const text = cleanText(node.textContent);
    if (text.length > 0) {
      headings.push(text.length > 200 ? text.slice(0, 197) + "..." : text);
    }
  }

  const links = [];
  const linkNodes = doc.querySelectorAll("a[href]");
  for (let i = 0; i < linkNodes.length; i += 1) {
    const node = linkNodes[i];
    if (node === undefined || node === null) continue;
    const href = node.getAttribute("href");
    if (href === null || href.trim() === "") continue;
    const absolute = resolveUrl(href, doc.baseURI);
    const text = cleanText(node.textContent);
    if (text === "") continue;
    links.push({ text: text.length > 100 ? text.slice(0, 97) + "..." : text, href: absolute });
  }

  const labelTextFor = function (field) {
    const ariaLabel = field.getAttribute("aria-label");
    if (ariaLabel !== null && ariaLabel.trim() !== "") {
      return cleanText(ariaLabel);
    }
    const fieldId = field.getAttribute("id");
    if (fieldId !== null && fieldId.trim() !== "") {
      const labels = doc.querySelectorAll("label");
      for (let i = 0; i < labels.length; i += 1) {
        const label = labels[i];
        if (label === undefined || label === null) continue;
        if (label.getAttribute("for") === fieldId) {
          return cleanText(label.textContent);
        }
      }
    }
    const parentLabel = field.closest("label");
    if (parentLabel !== null && parentLabel !== undefined) {
      return cleanText(parentLabel.textContent);
    }
    return null;
  };

  const forms = [];
  const formNodes = doc.querySelectorAll("form");
  for (let i = 0; i < formNodes.length; i += 1) {
    const form = formNodes[i];
    if (form === undefined || form === null) continue;

    const fields = [];
    const fieldNodes = form.querySelectorAll("input, textarea, select");
    for (let j = 0; j < fieldNodes.length; j += 1) {
      const field = fieldNodes[j];
      if (field === undefined || field === null) continue;

      const tag = field.tagName.toLowerCase();
      const rawType = (field.getAttribute("type") || "").toLowerCase();
      if (tag === "input" && (rawType === "hidden" || rawType === "submit" || rawType === "button" || rawType === "reset")) {
        continue;
      }

      const fieldKind = tag === "textarea" ? "textarea" : tag === "select" ? "select" : "input";
      const inputType = fieldKind === "input" ? (rawType === "" ? "text" : rawType) : null;

      const selectOptionTexts = [];
      if (fieldKind === "select") {
        const options = field.options || [];
        for (let k = 0; k < options.length; k += 1) {
          const option = options[k];
          if (option === undefined || option === null) continue;
          const optionText = cleanText(option.text);
          if (optionText !== "") {
            selectOptionTexts.push(optionText.length > 60 ? optionText.slice(0, 57) + "..." : optionText);
          }
        }
      }

      fields.push({
        kind: fieldKind,
        inputType: inputType,
        name: field.getAttribute("name"),
        label: labelTextFor(field),
        placeholder: field.getAttribute("placeholder"),
        autocomplete: field.getAttribute("autocomplete"),
        requiredAttr: field.getAttribute("required") !== null,
        ariaRequired: field.getAttribute("aria-required") === "true",
        readonly: field.readOnly === true,
        disabled: field.disabled === true,
        hidden: false,
        selectOptionTexts: selectOptionTexts,
      });
    }

    const submitButtons = [];
    const buttonNodes = form.querySelectorAll("button, input[type=submit], input[type=button]");
    for (let j = 0; j < buttonNodes.length; j += 1) {
      const button = buttonNodes[j];
      if (button === undefined || button === null) continue;
      const text = cleanText(button.textContent) || cleanText(button.getAttribute("value"));
      if (text !== "") {
        submitButtons.push(text.length > 80 ? text.slice(0, 77) + "..." : text);
      }
    }

    const rawAction = form.getAttribute("action");
    forms.push({
      action: resolveUrl(rawAction, doc.baseURI) || rawAction,
      method: (form.getAttribute("method") || "get").toLowerCase(),
      fields: fields,
      submitButtons: submitButtons,
    });
  }

  const hiddenInputCountTotal = doc.querySelectorAll('input[type="hidden"]').length;
  const bodyText = (doc.body && doc.body.innerText) || doc.textContent || "";
  const textSample = cleanText(bodyText).slice(0, 40000);

  return {
    title: title,
    headings: headings,
    links: links,
    forms: forms,
    textSample: textSample,
    hiddenInputCountTotal: hiddenInputCountTotal,
  };
})();
`;

const SENSITIVE_AUTOCOMPLETE = new Set([
  "current-password",
  "new-password",
  "one-time-code",
  "cc-number",
  "cc-cvc",
  "cc-exp",
  "cc-exp-month",
  "cc-exp-year",
  "cc-name",
]);

function isSensitiveField(field: RawDomField): boolean {
  if (field.inputType === "password") {
    return true;
  }
  if (field.autocomplete !== null && SENSITIVE_AUTOCOMPLETE.has(field.autocomplete.toLowerCase())) {
    return true;
  }
  return false;
}

function toInspectedField(field: RawDomField, id: string): InspectedField {
  return {
    id,
    kind: field.kind,
    inputType: field.inputType,
    name: field.name,
    label: field.label,
    placeholder: field.placeholder,
    autocomplete: field.autocomplete,
    required: field.requiredAttr || field.ariaRequired,
    readonly: field.readonly,
    disabled: field.disabled,
    sensitive: isSensitiveField(field),
    selectOptions: field.kind === "select" ? field.selectOptionTexts.slice(0, 8) : null,
  };
}

function isApplyLink(text: string, url: string): boolean {
  const lowerText = text.toLowerCase();
  if (/(\bapply\b|application)/.test(lowerText)) {
    return true;
  }
  try {
    const parsed = new URL(url);
    return /\/apply($|\/)/i.test(parsed.pathname) || /\/application($|\/)/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

export function analyzePage(raw: RawDomInspection): InspectedPageParts {
  const headings = raw.headings.slice(0, MAX_HEADINGS);

  const links: InspectedLink[] = [];
  for (const link of raw.links.slice(0, MAX_LINKS)) {
    links.push({ text: link.text, url: link.href, applyHint: isApplyLink(link.text, link.href) });
  }
  const applyLinks = links.filter((link) => link.applyHint).slice(0, MAX_APPLY_LINKS);

  const forms: InspectedForm[] = [];
  for (const form of raw.forms.slice(0, MAX_FORMS)) {
    const fields: InspectedField[] = [];
    for (let i = 0; i < form.fields.length && fields.length < MAX_FIELDS_PER_FORM; i += 1) {
      const field = form.fields[i];
      if (field === undefined) {
        continue;
      }
      fields.push(toInspectedField(field, `${forms.length}-${i}`));
    }

    const submitButtons = form.submitButtons.slice(0, MAX_SUBMIT_BUTTONS);
    const hint = `${form.action ?? ""} ${submitButtons.join(" ")}`;
    const note = /\b(apply|applications?|careers?)\b/i.test(hint) ? "action or submit text suggests an application form" : null;

    forms.push({
      action: form.action,
      method: form.method,
      fields,
      submitButtons,
      note,
    });
  }

  return {
    headings,
    links,
    applyLinks,
    forms,
    hiddenFieldCount: raw.hiddenInputCountTotal,
    textSample: raw.textSample.slice(0, TEXT_SAMPLE_LIMIT),
  };
}

export function emptyPageParts(): InspectedPageParts {
  return { headings: [], links: [], applyLinks: [], forms: [], hiddenFieldCount: 0, textSample: "" };
}

export interface PageClassification {
  kind: PageKind;
  reliability: PageKindReliability;
  evidence: readonly string[];
}

export function classifyPage(input: { parts: InspectedPageParts; ats: AtsVerdict }): PageClassification {
  const { parts, ats } = input;

  let fillableFields = 0;
  for (const form of parts.forms) {
    fillableFields += form.fields.length;
  }

  if (fillableFields > 0) {
    return {
      kind: "application_form",
      reliability: fillableFields >= 3 ? "observed" : "heuristic",
      evidence: [`${fillableFields} fillable field(s) across ${parts.forms.length} form(s)`],
    };
  }

  if (parts.applyLinks.length > 0 && parts.headings.length > 0) {
    return {
      kind: "job_detail",
      reliability: "heuristic",
      evidence: [`${parts.applyLinks.length} apply link(s)`, `${parts.headings.length} heading(s)`],
    };
  }

  if (parts.forms.length > 0) {
    return {
      kind: "application_form",
      reliability: "heuristic",
      evidence: ["form(s) present without fillable fields"],
    };
  }

  if (ats.platform !== "UNKNOWN" && parts.headings.length > 0) {
    return {
      kind: "job_detail",
      reliability: "heuristic",
      evidence: [`${parts.headings.length} heading(s)`, `ATS brand ${ats.platform} detected`],
    };
  }

  return {
    kind: "unknown",
    reliability: "heuristic",
    evidence: ["no forms or apply links detected"],
  };
}