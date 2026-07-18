import { addUsage, normalizeUsage } from "@archcode/protocol";
import type { GoalBudgetSummary, GoalState, NormalizedUsage, ToolChildSessionLink } from "@archcode/protocol";

import { sessionFileInternals, type SessionFile } from "../store/helpers";
import { withGoalExecutionClaimLock } from "./execution-claim";
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

export interface GoalBudgetOptions {
  readonly maxTokens?: number;
  readonly now?: () => Date;
}

export interface GoalBudgetCalculation {
  readonly budget: GoalBudgetSummary;
  readonly includedSessionIds: string[];
  readonly excludedMaintenanceSessionIds: string[];
}

export async function calculateGoalBudget(
  workspaceRoot: string,
  goal: GoalState,
  options: GoalBudgetOptions = {},
): Promise<GoalBudgetCalculation> {
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
  const maxTokens = options.maxTokens ?? goal.budget?.maxTokens;
  const budget: GoalBudgetSummary = {
    status: maxTokens !== undefined && usage.totalTokens >= maxTokens ? "blocked" : "ok",
    usedTokens: usage.totalTokens,
    ...(maxTokens === undefined ? {} : { maxTokens }),
    updatedAt: (options.now ?? (() => new Date()))().toISOString(),
  };

  return {
    budget,
    includedSessionIds: [...includedSessionIds].sort(),
    excludedMaintenanceSessionIds: [...excludedMaintenanceSessionIds].sort(),
  };
}

export async function updateGoalBudget(
  goalStateManager: GoalStateManager,
  workspaceRoot: string,
  goalId: string,
  options: GoalBudgetOptions = {},
): Promise<GoalBudgetCalculation> {
  return await withGoalExecutionClaimLock(goalId, async () => {
    const goal = await goalStateManager.read(goalId);
    const calculation = await calculateGoalBudget(workspaceRoot, goal, options);
    await goalStateManager.updateBudgetSummary(goalId, calculation.budget);
    return calculation;
  });
}

async function readAllSessionFiles(workspaceRoot: string): Promise<SessionFile[]> {
  const files = new Map<string, SessionFile>();
  for (const root of (await sessionFileInternals.listSessionSummaries(workspaceRoot)).sort((left, right) => left.sessionId.localeCompare(right.sessionId))) {
    const rootFile = await sessionFileInternals.readSessionFile(root.sessionId, workspaceRoot, root.rootSessionId);
    files.set(rootFile.sessionId, rootFile);
    for (const descendantId of [...(await sessionFileInternals.scanDescendants(workspaceRoot, root.rootSessionId)).keys()].sort()) {
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
  for (const children of childrenByParent.values()) children.sort((left, right) => left.sessionId.localeCompare(right.sessionId));
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
  for (const link of parentLinks) values.push(link.toolName, link.childAgentName, link.title);
  return values.some((value) => MAINTENANCE_NAMES.has(value.trim().toLowerCase()));
}
