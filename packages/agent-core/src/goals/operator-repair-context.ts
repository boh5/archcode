import type { GoalRepairContext, GoalRepairIssue } from "@archcode/protocol";

import type { SessionRole } from "../store/types";

const OPERATOR_REPAIR_CONTEXT_START = "<archcode-operator-repair-context>";
const OPERATOR_REPAIR_CONTEXT_END = "</archcode-operator-repair-context>";
const PRIVATE_TEXT_MARKER_PATTERN = /RAW_MODEL_PRIVATE_TEXT/gu;
const MAX_FIELD_LENGTH = 2_000;

export interface OperatorRepairContextOptions {
  readonly sessionRole?: SessionRole;
}

export function shouldExposeOperatorRepairContext(options: OperatorRepairContextOptions): boolean {
  return options.sessionRole === "main" || options.sessionRole === "plan" || options.sessionRole === "build";
}

export function buildOperatorRepairContextSection(
  repairContext: GoalRepairContext | undefined,
  options: OperatorRepairContextOptions = {},
): string | null {
  if (repairContext === undefined || repairContext.issues.length === 0) return null;
  if (!shouldExposeOperatorRepairContext(options)) return null;

  const lines = [
    "## Operator Repair Context",
    "",
    "The previous Reviewer outcome was NOT_DONE. Use this structured context to plan and delegate the next repair attempt. Do not ask for or depend on raw Reviewer output; treat the items below as the canonical repair targets.",
    "",
    OPERATOR_REPAIR_CONTEXT_START,
    `Generated at: ${sanitizeField(repairContext.generatedAt)}`,
    `Summary: ${sanitizeField(repairContext.summary)}`,
    "",
    "Issues:",
    ...repairContext.issues.flatMap(formatIssue),
    OPERATOR_REPAIR_CONTEXT_END,
  ];

  return lines.join("\n");
}

function formatIssue(issue: GoalRepairIssue, index: number): string[] {
  const fields = [
    `- ${index + 1}. Condition/Criterion: ${sanitizeField(issue.conditionId)}`,
    `  Evidence summary: ${sanitizeField(issue.evidenceSummary)}`,
    `  Repair guidance: ${sanitizeField(issue.repairGuidance)}`,
  ];
  if (issue.repairTarget !== undefined) {
    fields.push(`  Repair target: ${sanitizeField(issue.repairTarget)}`);
  }
  if (issue.implicatedFiles !== undefined && issue.implicatedFiles.length > 0) {
    fields.push(`  Implicated files/areas: ${sanitizeList(issue.implicatedFiles)}`);
  }
  if (issue.failingCommands !== undefined && issue.failingCommands.length > 0) {
    fields.push(`  Failing commands: ${sanitizeList(issue.failingCommands)}`);
  }
  if (issue.resultSummaries !== undefined && issue.resultSummaries.length > 0) {
    fields.push(`  Result summaries: ${sanitizeList(issue.resultSummaries)}`);
  }
  return fields;
}

function sanitizeList(values: readonly string[]): string {
  return values.map(sanitizeField).join(", ");
}

function sanitizeField(value: string): string {
  const sanitized = value
    .replace(PRIVATE_TEXT_MARKER_PATTERN, "[redacted-private-reviewer-output]")
    .replace(/\r\n?/gu, "\n")
    .trim();
  if (sanitized.length <= MAX_FIELD_LENGTH) return sanitized;
  return `${sanitized.slice(0, MAX_FIELD_LENGTH)}\n<!-- repair context field truncated -->`;
}
