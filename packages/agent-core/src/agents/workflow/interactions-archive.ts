import type { WorkflowArtifactManager } from "./artifacts";
import type { WorkflowInteraction, WorkflowState } from "./state";

const TERMINAL_INTERACTION_STATUSES = new Set<WorkflowInteraction["status"]>([
  "resolved",
  "cancelled",
  "superseded",
]);

export interface ArchiveInteractionsInput {
  workflow: WorkflowState;
  artifacts: Pick<WorkflowArtifactManager, "readByKind" | "write">;
  archivedAt?: string;
}

export interface ArchiveInteractionsResult {
  workflowId: string;
  archived: number;
  skipped: number;
  path: "INTERACTIONS.md";
  warning?: string;
}

export async function archiveInteractions(input: ArchiveInteractionsInput): Promise<ArchiveInteractionsResult> {
  const archivedAt = input.archivedAt ?? new Date().toISOString();
  const terminalInteractions = selectTerminalInteractions(input.workflow);
  if (terminalInteractions.length === 0) {
    return {
      workflowId: input.workflow.id,
      archived: 0,
      skipped: 0,
      path: "INTERACTIONS.md",
    };
  }

  try {
    const existingBody = await readExistingInteractionsBody(input);
    const alreadyArchived = extractArchivedInteractionKeys(existingBody);
    const pendingEntries = terminalInteractions.filter((interaction) =>
      !alreadyArchived.has(archiveKey(interaction)),
    );

    if (pendingEntries.length === 0) {
      return {
        workflowId: input.workflow.id,
        archived: 0,
        skipped: terminalInteractions.length,
        path: "INTERACTIONS.md",
      };
    }

    const nextBody = appendInteractionEntries(existingBody, pendingEntries, archivedAt);
    await input.artifacts.write({
      workflowId: input.workflow.id,
      kind: "INTERACTIONS",
      content: nextBody,
    }, {
      writerAgent: "system",
      writerSessionId: input.workflow.sessionIds.orchestrator,
      toolCallId: "archiveInteractions",
      writtenAt: archivedAt,
    });

    return {
      workflowId: input.workflow.id,
      archived: pendingEntries.length,
      skipped: terminalInteractions.length - pendingEntries.length,
      path: "INTERACTIONS.md",
    };
  } catch (error) {
    return {
      workflowId: input.workflow.id,
      archived: 0,
      skipped: 0,
      path: "INTERACTIONS.md",
      warning: `Failed to archive workflow interactions: ${formatError(error)}`,
    };
  }
}

export function formatResolvedDecisionConstraints(interactions: readonly WorkflowInteraction[]): string | null {
  const terminal = interactions.filter((interaction) => interaction.status === "resolved");
  if (terminal.length === 0) return null;

  return [
    "### Resolved Workflow Decisions — Execution Constraints",
    "",
    "Critic, Foreman, Builder, and Reviewer roles must treat these terminal decisions as binding constraints. Do not re-litigate them unless the user explicitly changes the decision.",
    "",
    ...terminal.map(formatConstraintEntry),
  ].join("\n");
}

function selectTerminalInteractions(workflow: WorkflowState): WorkflowInteraction[] {
  const interactionsByArchiveKey = new Map<string, WorkflowInteraction>();
  for (const interaction of [...workflow.requiredInteractions, ...workflow.resolvedInteractions]) {
    if (!TERMINAL_INTERACTION_STATUSES.has(interaction.status)) continue;
    interactionsByArchiveKey.set(archiveKey(interaction), interaction);
  }
  return [...interactionsByArchiveKey.values()].sort(compareInteractions);
}

async function readExistingInteractionsBody(input: ArchiveInteractionsInput): Promise<string> {
  try {
    return (await input.artifacts.readByKind(input.workflow.id, "INTERACTIONS")).body.trimEnd();
  } catch (error) {
    if (isNotFoundError(error)) return "";
    throw error;
  }
}

function appendInteractionEntries(
  existingBody: string,
  interactions: readonly WorkflowInteraction[],
  archivedAt: string,
): string {
  const prefix = existingBody.trim().length > 0 ? `${existingBody.trimEnd()}\n\n` : "# Workflow Interactions Archive\n\n";
  return `${prefix}${interactions.map((interaction) => formatArchiveEntry(interaction, archivedAt)).join("\n\n")}\n`;
}

function formatArchiveEntry(interaction: WorkflowInteraction, archivedAt: string): string {
  return [
    `## ${interaction.decisionKey}`,
    "",
    `<!-- archcode-interaction:${archiveKey(interaction)} -->`,
    "",
    `- Interaction ID: ${interaction.id}`,
    `- Decision Key: ${interaction.decisionKey}`,
    `- Stage: ${interaction.stage}`,
    `- Source Agent: ${interaction.sourceAgent}`,
    `- Kind: ${interaction.kind}`,
    `- Status: ${interaction.status}`,
    `- Question: ${interaction.question}`,
    `- Options: ${formatOptions(interaction.options)}`,
    `- Recommended Option: ${interaction.recommendedOption ?? "none"}`,
    `- Selected Answer: ${interaction.answer ?? "none"}`,
    `- Rationale: ${interaction.rationale}`,
    `- Created At: ${interaction.createdAt ?? "unknown"}`,
    `- Resolved At: ${interaction.resolvedAt ?? "n/a"}`,
    `- Cancelled At: ${interaction.cancelledAt ?? "n/a"}`,
    `- Superseded By: ${interaction.supersededBy ?? "n/a"}`,
    `- Revision: ${interaction.revision}`,
    `- Archived At: ${archivedAt}`,
  ].join("\n");
}

function formatConstraintEntry(interaction: WorkflowInteraction): string {
  return [
    `- ${interaction.decisionKey}`,
    `  - Stage: ${interaction.stage}`,
    `  - Source: ${interaction.sourceAgent}`,
    `  - Question: ${interaction.question}`,
    `  - Answer: ${interaction.answer ?? "none"}`,
    `  - Rationale: ${interaction.rationale}`,
    `  - Resolved At: ${interaction.resolvedAt ?? "unknown"}`,
  ].join("\n");
}

function extractArchivedInteractionKeys(body: string): Set<string> {
  const keys = new Set<string>();
  for (const match of body.matchAll(/<!--\s*archcode-interaction:([^\s]+)\s*-->/g)) {
    if (match[1]) keys.add(match[1]);
  }
  return keys;
}

function archiveKey(interaction: WorkflowInteraction): string {
  return `${interaction.id}:${interaction.status}:${interaction.revision}`;
}

function compareInteractions(left: WorkflowInteraction, right: WorkflowInteraction): number {
  const leftTime = left.resolvedAt ?? left.cancelledAt ?? left.createdAt ?? "";
  const rightTime = right.resolvedAt ?? right.cancelledAt ?? right.createdAt ?? "";
  if (leftTime !== rightTime) return leftTime.localeCompare(rightTime);
  return left.decisionKey.localeCompare(right.decisionKey);
}

function formatOptions(options: readonly string[]): string {
  if (options.length === 0) return "none";
  return options.map((option) => `\`${option.replaceAll("`", "'")}\``).join(", ");
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
