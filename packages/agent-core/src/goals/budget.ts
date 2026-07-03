import { addUsage, normalizeUsage } from "@archcode/protocol";
import type { GoalState, GoalTokenBudgetState, NormalizedUsage, ToolChildSessionLink } from "@archcode/protocol";

import { sessionFileInternals, type SessionFile } from "../store/helpers";
import type { GoalStateManager } from "./state";

const MAINTENANCE_NAMES = new Set([
  "title-generation",
  "memory-extraction",
  "memory-consolidation",
]);

const EMPTY_USAGE: NormalizedUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  reasoningTokens: 0,
  cachedInputTokens: 0,
};

export interface GoalTokenBudgetOptions {
  readonly maxTokens?: number;
  readonly warningThresholdTokens?: number;
  readonly now?: () => Date;
}

export interface GoalTokenBudgetCalculation {
  readonly budget: GoalTokenBudgetState;
  readonly includedSessionIds: string[];
  readonly excludedMaintenanceSessionIds: string[];
}

export async function calculateGoalTokenBudget(
  workspaceRoot: string,
  goal: GoalState,
  options: GoalTokenBudgetOptions = {},
): Promise<GoalTokenBudgetCalculation> {
  const files = await readAllSessionFiles(workspaceRoot);
  const fileById = new Map(files.map((file) => [file.sessionId, file]));
  const childrenByParent = buildChildrenByParent(files);
  const linksByChild = buildLinksByChild(files);
  const explicitSeedIds = new Set([
    ...(goal.mainSessionId === undefined ? [] : [goal.mainSessionId]),
    ...goal.childSessionIds,
  ]);
  const seedIds = new Set<string>(explicitSeedIds);

  for (const file of files) {
    if (file.goalId === goal.id) seedIds.add(file.sessionId);
  }

  const visited = new Set<string>();
  const includedSessionIds = new Set<string>();
  const excludedMaintenanceSessionIds = new Set<string>();
  const queue = [...seedIds].sort();

  while (queue.length > 0) {
    const sessionId = queue.shift();
    if (sessionId === undefined || visited.has(sessionId)) continue;
    visited.add(sessionId);

    const file = fileById.get(sessionId);
    if (file === undefined) continue;

    if (isMaintenanceSession(file, linksByChild.get(sessionId) ?? [])) {
      excludedMaintenanceSessionIds.add(sessionId);
      continue;
    }

    const belongsToGoal = file.goalId === goal.id || explicitSeedIds.has(sessionId);
    if (!belongsToGoal) continue;

    includedSessionIds.add(sessionId);
    for (const child of childrenByParent.get(sessionId) ?? []) queue.push(child.sessionId);
    queue.sort();
  }

  const usage = [...includedSessionIds]
    .sort()
    .map((sessionId) => normalizeUsage(fileById.get(sessionId)?.stats.usage))
    .reduce((total, current) => addUsage(total, current), EMPTY_USAGE);

  const maxTokens = options.maxTokens ?? goal.tokenBudget?.maxTokens;
  const warningThresholdTokens = options.warningThresholdTokens ?? goal.tokenBudget?.warningThresholdTokens;
  const budget: GoalTokenBudgetState = {
    status: budgetStatus(usage.totalTokens, maxTokens, warningThresholdTokens),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(warningThresholdTokens === undefined ? {} : { warningThresholdTokens }),
    ...preservedWarningApproval(goal.tokenBudget, warningThresholdTokens),
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
    cachedInputTokens: usage.cachedInputTokens,
    totalTokens: usage.totalTokens,
    updatedAt: (options.now ?? (() => new Date()))().toISOString(),
  };

  return {
    budget,
    includedSessionIds: [...includedSessionIds].sort(),
    excludedMaintenanceSessionIds: [...excludedMaintenanceSessionIds].sort(),
  };
}

function preservedWarningApproval(
  existing: GoalTokenBudgetState | undefined,
  warningThresholdTokens: number | undefined,
): Partial<GoalTokenBudgetState> {
  if (existing?.warningApprovalPoint === undefined || existing.warningApprovedAt === undefined) return {};
  if (existing.warningApprovalThresholdTokens !== warningThresholdTokens) return {};
  return {
    warningApprovalPoint: existing.warningApprovalPoint,
    warningApprovalThresholdTokens: existing.warningApprovalThresholdTokens,
    warningApprovedAt: existing.warningApprovedAt,
    warningApprovedTotalTokens: existing.warningApprovedTotalTokens,
  };
}

export async function updateGoalTokenBudget(
  goalStateManager: GoalStateManager,
  workspaceRoot: string,
  goalId: string,
  options: GoalTokenBudgetOptions = {},
): Promise<GoalTokenBudgetCalculation> {
  const goal = await goalStateManager.read(goalId);
  const calculation = await calculateGoalTokenBudget(workspaceRoot, goal, options);
  await goalStateManager.updateTokenBudget(goalId, calculation.budget);
  return calculation;
}

function budgetStatus(
  totalTokens: number,
  maxTokens: number | undefined,
  warningThresholdTokens: number | undefined,
): GoalTokenBudgetState["status"] {
  if (maxTokens !== undefined && totalTokens >= maxTokens) return "exceeded";
  if (warningThresholdTokens !== undefined && totalTokens >= warningThresholdTokens) return "warning";
  return "ok";
}

async function readAllSessionFiles(workspaceRoot: string): Promise<SessionFile[]> {
  const rootSummaries = (await sessionFileInternals.listSessionSummaries(workspaceRoot))
    .slice()
    .sort((left, right) => left.sessionId.localeCompare(right.sessionId));
  const files = new Map<string, SessionFile>();

  for (const root of rootSummaries) {
    const rootFile = await sessionFileInternals.readSessionFile(root.sessionId, workspaceRoot, root.rootSessionId);
    files.set(rootFile.sessionId, rootFile);

    const descendantIds = [...(await sessionFileInternals.scanDescendants(workspaceRoot, root.rootSessionId)).keys()]
      .sort();
    for (const descendantId of descendantIds) {
      const descendant = await sessionFileInternals.readSessionFile(descendantId, workspaceRoot, root.rootSessionId);
      files.set(descendant.sessionId, descendant);
    }
  }

  return [...files.values()].sort((left, right) => left.sessionId.localeCompare(right.sessionId));
}

function buildChildrenByParent(files: readonly SessionFile[]): Map<string, SessionFile[]> {
  const childrenByParent = new Map<string, SessionFile[]>();
  for (const file of files) {
    if (file.parentSessionId === undefined) continue;
    const children = childrenByParent.get(file.parentSessionId) ?? [];
    children.push(file);
    childrenByParent.set(file.parentSessionId, children);
  }

  for (const children of childrenByParent.values()) {
    children.sort((left, right) => left.sessionId.localeCompare(right.sessionId));
  }

  return childrenByParent;
}

function buildLinksByChild(files: readonly SessionFile[]): Map<string, ToolChildSessionLink[]> {
  const linksByChild = new Map<string, ToolChildSessionLink[]>();
  for (const file of files) {
    for (const link of file.childSessionLinks) {
      const links = linksByChild.get(link.childSessionId) ?? [];
      links.push(link);
      linksByChild.set(link.childSessionId, links);
    }
  }
  return linksByChild;
}

function isMaintenanceSession(file: SessionFile, parentLinks: readonly ToolChildSessionLink[]): boolean {
  const values = [file.agentName, file.title ?? "", file.sessionRole ?? ""];
  for (const link of parentLinks) {
    values.push(link.toolName, link.childAgentName, link.title ?? "", link.description ?? "");
  }

  return values.some((value) => MAINTENANCE_NAMES.has(value.trim().toLowerCase()));
}
