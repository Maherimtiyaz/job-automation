import type { AtsConfidence, AtsVerdict } from "./types.js";

interface HostRule {
  platform: string;
  indicators: readonly string[];
}

interface TextRule {
  platform: string;
  indicators: readonly string[];
}

const HOST_RULES: readonly HostRule[] = [
  { platform: "Greenhouse", indicators: ["greenhouse.io", "greenhouse"] },
  { platform: "Lever", indicators: ["lever.co"] },
  { platform: "Workday", indicators: ["myworkdayjobs.com", "workday"] },
  { platform: "iCIMS", indicators: ["icims"] },
  { platform: "SmartRecruiters", indicators: ["smartrecruiters"] },
  { platform: "JazzHR", indicators: ["jazzhr"] },
];

const TEXT_RULES: readonly TextRule[] = [
  { platform: "Greenhouse", indicators: ["powered by greenhouse", "greenhouse.io"] },
  { platform: "Lever", indicators: ["powered by lever", "jobs.lever.co"] },
  { platform: "iCIMS", indicators: ["powered by icims", "icims careers"] },
  { platform: "SmartRecruiters", indicators: ["powered by smartrecruiters", "jobs.smartrecruiters.com"] },
  { platform: "JazzHR", indicators: ["powered by jazzhr", "jazzhr.com"] },
  { platform: "Workday", indicators: ["workday careers", "myworkdayjobs.com"] },
];

function matchesAny(candidates: readonly string[], text: string): readonly string[] {
  return candidates.filter((candidate) => text.includes(candidate));
}

export function detectAts(input: { hostname: string; textSample: string }): AtsVerdict {
  const hostname = input.hostname.toLowerCase();
  const text = input.textSample.toLowerCase();

  for (const rule of HOST_RULES) {
    if (rule.indicators.some((indicator) => hostname.includes(indicator))) {
      const matchingIndicators = rule.indicators.filter((indicator) => hostname.includes(indicator));
      const textEvidence = TEXT_RULES.filter((textRule) => textRule.platform === rule.platform).flatMap(
        (textRule) => matchesAny(textRule.indicators, text),
      );
      const confidence: AtsConfidence = textEvidence.length > 0 ? "high" : "medium";
      return {
        platform: rule.platform,
        confidence,
        signals: [...matchingIndicators, ...textEvidence],
      };
    }
  }

  for (const rule of TEXT_RULES) {
    const evidence = matchesAny(rule.indicators, text);
    if (evidence.length > 0) {
      return {
        platform: rule.platform,
        confidence: "medium",
        signals: evidence,
      };
    }
  }

  return { platform: "UNKNOWN", confidence: "low", signals: [] };
}