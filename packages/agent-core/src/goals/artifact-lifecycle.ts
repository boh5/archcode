import type {
  DoneResult,
  GoalReviewReport,
  GoalSpecComplianceEvidence,
  GoalTokenBudgetState,
} from "@archcode/protocol";

import { redactString } from "../tools/security/redaction";
import type { GoalArtifactManager } from "./artifacts";
import type { GoalState } from "./state";

const LIFECYCLE_AGENT = "goal-lifecycle";
const BUDGET_AGENT = "budget-enforcement";
const APPROVAL_AGENT = "goal-approval-gate";

export interface BudgetArtifactEvent {
  readonly event: "warning_pending" | "warning_denied" | "warning_approved" | "hard_stop";
  readonly source: string;
  readonly reason: string;
  readonly estimatedNextCallTokens?: number;
}

export interface RetryArtifactEvent {
  readonly attempt: number;
  readonly status: "scheduled" | "running" | "escalated";
  readonly failureSummary: string;
  readonly freshSessionId?: string;
  readonly nextRetryAt?: string;
  readonly exhausted?: boolean;
}

export interface ApprovalArtifactEvent {
  readonly approvalPoint: string;
  readonly sessionId: string;
  readonly status: "requested" | "approved" | "denied" | "cancelled" | "timeout";
  readonly decision?: string;
  readonly comment?: string;
}

export async function writeGoalBuildArtifactIfMissing(
  goalArtifacts: GoalArtifactManager,
  goal: GoalState,
  source: string,
): Promise<void> {
  const existing = await goalArtifacts.readArtifact(goal.id, "build.md");
  if (existing !== null) return;

  const content = [
    "# Build Record",
    "",
    table([
      ["Field", "Value"],
      ["Recorded at", new Date().toISOString()],
      ["Source", source],
      ["Goal id", goal.id],
      ["Title", goal.title],
      ["Phase", goal.phase],
      ["Status", goal.status],
      ["Main session", goal.mainSessionId ?? "not recorded"],
      ["Child sessions", goal.childSessionIds.length > 0 ? goal.childSessionIds.join(", ") : "none recorded"],
    ]),
    "",
    "## Evidence Summary",
    "",
    "Lifecycle reached review phase. No raw build transcript is stored in this artifact.",
    "",
  ].join("\n");

  await goalArtifacts.writeArtifact(goal, "build.md", content, { agentName: LIFECYCLE_AGENT });
}

export async function writeGoalReviewArtifacts(
  goalArtifacts: GoalArtifactManager,
  goal: GoalState,
): Promise<void> {
  if (goal.reviewReport) {
    await goalArtifacts.writeArtifact(goal, "review.md", reviewMarkdown(goal.reviewReport, goal), {
      agentName: LIFECYCLE_AGENT,
    });
  }

  const specEvidence = collectSpecComplianceEvidence(goal);
  if (specEvidence.length > 0) {
    await goalArtifacts.writeArtifact(goal, "spec-compliance.md", specComplianceMarkdown(goal, specEvidence), {
      agentName: LIFECYCLE_AGENT,
    });
  }
}

export async function writeGoalFinalReport(
  goalArtifacts: GoalArtifactManager,
  goal: GoalState,
  reason?: string,
): Promise<void> {
  await goalArtifacts.writeArtifact(goal, "final-report.md", finalReportMarkdown(goal, reason), {
    agentName: LIFECYCLE_AGENT,
  });
}

export async function writeGoalBudgetArtifact(
  goalArtifacts: GoalArtifactManager,
  goal: GoalState,
  budget: GoalTokenBudgetState,
  event: BudgetArtifactEvent,
): Promise<void> {
  const content = [
    "# Budget Ledger",
    "",
    table([
      ["Field", "Value"],
      ["Recorded at", new Date().toISOString()],
      ["Source", event.source],
      ["Event", event.event],
      ["Status", event.event === "hard_stop" ? "hard_limit_exceeded" : event.event],
      ["Goal id", goal.id],
      ["Goal status", goal.status],
      ["Budget status", budget.status],
      ["Input token count", String(budget.inputTokens)],
      ["Output token count", String(budget.outputTokens)],
      ["Reasoning token count", String(budget.reasoningTokens ?? 0)],
      ["Cached input token count", String(budget.cachedInputTokens ?? 0)],
      ["Total token count", String(budget.totalTokens)],
      ["Maximum token count", budget.maxTokens === undefined ? "unset" : String(budget.maxTokens)],
      ["Warning threshold count", budget.warningThresholdTokens === undefined ? "unset" : String(budget.warningThresholdTokens)],
      ["Estimated next call token count", event.estimatedNextCallTokens === undefined ? "not recorded" : String(event.estimatedNextCallTokens)],
      ["Warning approval point", budget.warningApprovalPoint ?? "not recorded"],
      ["Warning approved at", budget.warningApprovedAt ?? "not recorded"],
      ["Reason", event.reason],
    ]),
    "",
  ].join("\n");

  await goalArtifacts.writeArtifact(goal, "budget.md", content, { agentName: BUDGET_AGENT });
}

export async function writeGoalRetryArtifact(
  goalArtifacts: GoalArtifactManager,
  goal: GoalState,
  event: RetryArtifactEvent,
): Promise<void> {
  const existing = await goalArtifacts.readArtifact(goal.id, "retry-log.md");
  const rows = extractMarkdownRows(existing);
  rows.push([
    new Date().toISOString(),
    String(event.attempt),
    event.status,
    event.failureSummary,
    event.freshSessionId ?? "none",
    event.nextRetryAt ?? "not scheduled",
    event.exhausted ? "retry budget exhausted" : "not exhausted",
  ]);

  const content = [
    "# Retry Log",
    "",
    table([
      ["Field", "Value"],
      ["Goal id", goal.id],
      ["Current status", goal.status],
      ["Retry count", String(goal.retryCount)],
      ["Maximum retries", String(goal.retryPolicy.maxRetries)],
      ["Backoff ms", String(goal.retryPolicy.backoffMs)],
      ["Escalate on failure", goal.retryPolicy.escalateOnFailure ? "yes" : "no"],
    ]),
    "",
    "## Attempts",
    "",
    table([
      ["Recorded at", "Attempt", "Status", "Failure summary", "Fresh session", "Next retry at", "Escalation"],
      ...rows,
    ]),
    "",
  ].join("\n");

  await goalArtifacts.writeArtifact(goal, "retry-log.md", content, { agentName: LIFECYCLE_AGENT });
}

export async function writeGoalApprovalArtifactEvent(
  goalArtifacts: GoalArtifactManager,
  goal: GoalState,
  event: ApprovalArtifactEvent,
): Promise<void> {
  const existing = await goalArtifacts.readArtifact(goal.id, "approvals.md");
  const rows = extractMarkdownRows(existing);
  rows.push([
    new Date().toISOString(),
    event.approvalPoint,
    event.status,
    event.decision ?? "not recorded",
    event.comment ?? "not recorded",
    event.sessionId,
  ]);

  const content = [
    "# Approval History",
    "",
    table([
      ["Field", "Value"],
      ["Goal id", goal.id],
      ["Title", goal.title],
      ["Configured approval points", goal.approvalPoints.length > 0 ? goal.approvalPoints.join(", ") : "none"],
    ]),
    "",
    "## Events",
    "",
    table([
      ["Recorded at", "Approval point", "Status", "Decision", "Comment", "Session"],
      ...rows,
    ]),
    "",
  ].join("\n");

  await goalArtifacts.writeArtifact(goal, "approvals.md", content, { agentName: APPROVAL_AGENT });
}

function reviewMarkdown(report: GoalReviewReport, goal: GoalState): string {
  const failedCriteria = report.criteria.filter((criterion) => criterion.status === "failed" || criterion.compliant === false);
  return [
    "# Review Report",
    "",
    table([
      ["Field", "Value"],
      ["Goal id", goal.id],
      ["Reviewer", report.reviewerAgent],
      ["Outcome", report.outcome],
      ["Reviewed at", report.reviewedAt],
      ["Summary", report.summary],
      ["Failed criteria", failedCriteria.length > 0 ? failedCriteria.map((criterion) => criterion.criterionId).join(", ") : "none"],
    ]),
    "",
    "## Criteria Evidence",
    "",
    criteriaTable(report.criteria),
    "",
    ...repairContextSection(goal),
  ].join("\n");
}

function specComplianceMarkdown(goal: GoalState, evidenceList: GoalSpecComplianceEvidence[]): string {
  const sections: string[] = ["# Spec Compliance", ""];
  for (const evidence of evidenceList) {
    sections.push(
      `## ${safeText(evidence.specPath ?? "Spec evidence")}`,
      "",
      table([
        ["Field", "Value"],
        ["Goal id", goal.id],
        ["Checked at", evidence.checkedAt],
        ["Spec path", evidence.specPath ?? "not recorded"],
        ["Summary", evidence.summary],
      ]),
      "",
      criteriaTable(evidence.criteria),
      "",
    );
  }
  return sections.join("\n");
}

function finalReportMarkdown(goal: GoalState, reason?: string): string {
  const reviewOutcome = goal.reviewReport?.outcome ?? "not recorded";
  return [
    "# Final Report",
    "",
    table([
      ["Field", "Value"],
      ["Recorded at", new Date().toISOString()],
      ["Goal id", goal.id],
      ["Title", goal.title],
      ["Final status", goal.status],
      ["Phase", goal.phase],
      ["Review outcome", reviewOutcome],
      ["Reason", reason ?? goal.lastError ?? goal.reviewReport?.summary ?? "No final reason recorded"],
      ["Main session", goal.mainSessionId ?? "not recorded"],
      ["Child sessions", goal.childSessionIds.length > 0 ? goal.childSessionIds.join(", ") : "none recorded"],
    ]),
    "",
    "## Files and Commands Evidence",
    "",
    criteriaTable(goal.reviewReport?.criteria ?? criteriaFromDoneResults(goal.doneResults)),
    "",
    "## Budget Totals",
    "",
    budgetSummaryTable(goal.tokenBudget),
    "",
    "## Retries",
    "",
    table([
      ["Field", "Value"],
      ["Retry count", String(goal.retryCount)],
      ["Maximum retries", String(goal.retryPolicy.maxRetries)],
      ["Backoff ms", String(goal.retryPolicy.backoffMs)],
      ["Escalate on failure", goal.retryPolicy.escalateOnFailure ? "yes" : "no"],
      ["Last error", goal.lastError ?? "not recorded"],
    ]),
    "",
    "## Approvals",
    "",
    table([
      ["Field", "Value"],
      ["Configured approval points", goal.approvalPoints.length > 0 ? goal.approvalPoints.join(", ") : "none"],
      ["Budget warning approval point", goal.tokenBudget?.warningApprovalPoint ?? "not recorded"],
      ["Budget warning approved at", goal.tokenBudget?.warningApprovedAt ?? "not recorded"],
      ["Approval history artifact", goal.approvalPoints.length > 0 || goal.tokenBudget?.warningApprovalPoint ? "approvals.md or budget.md" : "not applicable"],
    ]),
    "",
    "## Residual Risks",
    "",
    residualRisks(goal),
    "",
  ].join("\n");
}

function collectSpecComplianceEvidence(goal: GoalState): GoalSpecComplianceEvidence[] {
  return Object.values(goal.doneResults)
    .map((result) => result.specCompliance)
    .filter((evidence): evidence is GoalSpecComplianceEvidence => evidence !== undefined);
}

function criteriaFromDoneResults(doneResults: Record<string, DoneResult>) {
  return Object.values(doneResults).map((result) => ({
    criterionId: result.conditionId,
    criterion: result.conditionId,
    compliant: result.passed,
    status: result.passed ? "satisfied" as const : "failed" as const,
    evidence: [result.evidence],
  }));
}

function criteriaTable(criteria: GoalReviewReport["criteria"]): string {
  if (criteria.length === 0) return "No structured criteria evidence recorded.";
  return table([
    ["Criterion", "Status", "Evidence", "Files", "Commands", "Results", "Artifacts"],
    ...criteria.map((criterion) => [
      criterion.criterionId,
      criterion.status ?? (criterion.compliant ? "satisfied" : "failed"),
      criterion.evidence.join("; "),
      criterion.fileRefs?.join(", ") ?? "not recorded",
      criterion.commandRefs?.join(", ") ?? "not recorded",
      criterion.resultRefs?.join(", ") ?? "not recorded",
      criterion.artifactNames?.join(", ") ?? "not recorded",
    ]),
  ]);
}

function budgetSummaryTable(budget: GoalTokenBudgetState | undefined): string {
  if (!budget) return "No token budget recorded.";
  return table([
    ["Field", "Value"],
    ["Budget status", budget.status],
    ["Input token count", String(budget.inputTokens)],
    ["Output token count", String(budget.outputTokens)],
    ["Reasoning token count", String(budget.reasoningTokens ?? 0)],
    ["Cached input token count", String(budget.cachedInputTokens ?? 0)],
    ["Total token count", String(budget.totalTokens)],
    ["Warning threshold count", budget.warningThresholdTokens === undefined ? "unset" : String(budget.warningThresholdTokens)],
    ["Maximum token count", budget.maxTokens === undefined ? "unset" : String(budget.maxTokens)],
    ["Updated at", budget.updatedAt],
  ]);
}

function repairContextSection(goal: GoalState): string[] {
  if (!goal.repairContext) return [];
  return [
    "## Operator Repair Context",
    "",
    table([
      ["Field", "Value"],
      ["Generated at", goal.repairContext.generatedAt],
      ["Summary", goal.repairContext.summary],
    ]),
    "",
    table([
      ["Condition", "Evidence summary", "Repair guidance", "Repair target", "Files", "Commands", "Results"],
      ...goal.repairContext.issues.map((issue) => [
        issue.conditionId,
        issue.evidenceSummary,
        issue.repairGuidance,
        issue.repairTarget ?? "not recorded",
        issue.implicatedFiles?.join(", ") ?? "not recorded",
        issue.failingCommands?.join(", ") ?? "not recorded",
        issue.resultSummaries?.join(", ") ?? "not recorded",
      ]),
    ]),
    "",
  ];
}

function residualRisks(goal: GoalState): string {
  const issues = goal.repairContext?.issues ?? [];
  if (issues.length === 0 && goal.status === "completed") return "No residual risks recorded in Goal state.";
  if (issues.length === 0) return goal.lastError ? `- ${safeText(goal.lastError)}` : "- Final state requires operator review.";
  return issues
    .map((issue) => `- ${safeText(issue.conditionId)}: ${safeText(issue.repairGuidance)}${issue.repairTarget ? ` (target: ${safeText(issue.repairTarget)})` : ""}`)
    .join("\n");
}

function extractMarkdownRows(content: string | null): string[][] {
  if (!content) return [];
  return content
    .split("\n")
    .filter((line) => line.startsWith("| ") && !line.includes("---") && !line.startsWith("| Field |") && !line.startsWith("| Goal id |"))
    .filter((line) => line.startsWith("| Recorded at |") === false)
    .map((line) => line.slice(2, -2).split(" | ").map((cellValue) => cellValue.replaceAll("\\|", "|")))
    .filter((row) => row.length > 2);
}

function table(rows: string[][]): string {
  if (rows.length === 0) return "";
  const header = rows[0]!;
  const body = rows.slice(1);
  return [
    `| ${header.map(cell).join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...body.map((row) => `| ${row.map(cell).join(" | ")} |`),
  ].join("\n");
}

function cell(value: string): string {
  return safeText(value).replaceAll("|", "\\|").replaceAll("\n", "<br>");
}

function safeText(value: string): string {
  return redactString(value)
    .replace(
      /\b[A-Za-z0-9_-]*(?:api[_-]?key|auth|authorization|bearer|client[_-]?secret|credential|pass(?:word)?|secret|token)[A-Za-z0-9_-]*\s*[=:]\s*\[REDACTED:SECRET\]/gi,
      "[redacted secret]",
    )
    .trim() || "not recorded";
}
