import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { InspectionReport } from "./types.js";

export function printInspectionReport(report: InspectionReport): void {
  const statusLabel = report.status === "failed" ? "FAILED" : "ok";
  console.log(`Inspection: ${report.pageKind} (${report.pageKindReliability}, ${statusLabel})`);
  console.log(`  Requested: ${report.requestedUrl}`);
  if (report.finalUrl !== null) {
    console.log(`  Final:     ${report.finalUrl}`);
  } else {
    console.log("  Final:     (none - navigation failed)");
  }
  console.log(`  HTTP:      ${report.httpStatus ?? "-"} (${report.loadDurationMs}ms)`);
  console.log(`  Title:     ${report.title ?? "-"}`);
  console.log(`  Network:   ${report.network}`);
  const signals = report.ats.signals.length > 0 ? ` [${report.ats.signals.join(", ")}]` : "";
  console.log(`  ATS:       ${report.ats.platform} (${report.ats.confidence})${signals}`);
  console.log(`  Headings:  ${report.headings.length}`);
  for (const heading of report.headings.slice(0, 3)) {
    console.log(`    - ${heading}`);
  }
  if (report.headings.length > 3) {
    console.log(`    ... and ${report.headings.length - 3} more`);
  }
  console.log(`  Apply links: ${report.applyLinks.length}`);
  for (const link of report.applyLinks.slice(0, 5)) {
    console.log(`    - ${link.text} -> ${link.url}`);
  }
  console.log(`  Forms:     ${report.forms.length}`);
  for (const form of report.forms) {
    const note = form.note !== null ? ` (${form.note})` : "";
    console.log(
      `    - ${form.fields.length} fillable field(s), ${form.submitButtons.length} submit button(s)${note}`,
    );
  }
  console.log(`  Hidden field count: ${report.hiddenFieldCount}`);
  if (report.screenshotPath !== null) {
    console.log(`  Screenshot: ${report.screenshotPath}`);
  }
  for (const warning of report.warnings) {
    console.log(`  Warning: ${warning.message}`);
  }
  for (const problem of report.problems) {
    console.log(`  Problem: [${problem.kind}] ${problem.message}`);
  }
  console.log(`Status: ${report.status}`);
}

export function writeInspectionReport(path: string, report: InspectionReport): void {
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}