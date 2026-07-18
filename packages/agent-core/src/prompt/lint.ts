import type { AgentName } from "../agents/names";
import type { CapabilityRef, CompletionAuthority, PromptContractV2, RoleContract, RuntimePromptEnvelope, TransitionRef } from "./types";

const TRANSITION_CAPABILITIES: Readonly<Record<TransitionRef, CapabilityRef>> = {
  "goal.begin_review": "goal_manage",
  "goal.retry": "goal_manage",
  "goal.cancel": "goal_manage",
  "goal.finalize_review": "goal_manage",
  "todo.update": "project_todo_update",
};

export class PromptContractLintError extends Error {
  constructor(public readonly violations: readonly string[]) {
    super(`Prompt contract lint failed: ${violations.join("; ")}`);
    this.name = "PromptContractLintError";
  }
}

export function lintRoleContract(
  role: RoleContract,
  runtime: RuntimePromptEnvelope,
  visibleCapabilities: readonly string[],
): void {
  const visible = new Set(visibleCapabilities);
  const violations: string[] = [];

  if (role.name !== runtime.agentName) violations.push("role identity conflicts with runtime agent");

  for (const capability of resolveRequiredCapabilities(role, runtime)) {
    if (!visible.has(capability)) violations.push(`required capability is not visible: ${capability}`);
  }
  for (const capability of role.forbiddenCapabilities) {
    if (visible.has(capability)) violations.push(`forbidden capability is visible: ${capability}`);
  }
  for (const target of runtime.allowedDelegateTargets) {
    if (!role.delegateTargets.includes(target)) violations.push(`runtime exposes forbidden delegate target: ${target}`);
  }
  if (runtime.allowedDelegateTargets.length > 0 && !visible.has("delegate")) {
    violations.push("runtime exposes delegate targets without the delegate capability");
  }
  for (const transition of resolveAllowedTransitions(role, runtime)) {
    const capability = TRANSITION_CAPABILITIES[transition];
    if (!visible.has(capability)) violations.push(`transition has no visible runtime action: ${transition}`);
  }
  if (!role.completionAuthority.includes(completionAuthorityFor(runtime))) {
    violations.push(`completion authority conflicts with execution mode: ${completionAuthorityFor(runtime)}`);
  }
  if (violations.length > 0) throw new PromptContractLintError(violations);
}

export function lintGuidanceAuthority(contract: Pick<PromptContractV2, "guidanceAuthority">): void {
  const violations: string[] = [];
  for (const [source, authority] of Object.entries(contract.guidanceAuthority)) {
    if (authority.kind !== "guidance-only" || authority.grants !== "none") {
      violations.push(`${source} guidance attempts to grant runtime authority`);
    }
  }
  if (violations.length > 0) throw new PromptContractLintError(violations);
}

export function resolveRequiredCapabilities(role: RoleContract, runtime: RuntimePromptEnvelope): readonly CapabilityRef[] {
  if (role.name !== "reviewer") return role.requiredCapabilities;
  return runtime.reviewMode === "goal"
    ? [...role.requiredCapabilities, "goal_manage"]
    : [...role.requiredCapabilities, "submit_child_result"];
}

export function resolveCompletionAuthorities(role: RoleContract, runtime: RuntimePromptEnvelope): readonly CompletionAuthority[] {
  if (role.name !== "reviewer") return role.completionAuthority;
  return [runtime.reviewMode === "goal" ? "goal-reviewer" : "ordinary-reviewer"];
}

export function resolveAllowedTransitions(role: RoleContract, runtime: RuntimePromptEnvelope): readonly TransitionRef[] {
  if (runtime.reviewMode === "ordinary") return role.allowedTransitions.ordinaryReview;
  if (runtime.reviewMode === "goal") return role.allowedTransitions.goalReview;
  if (role.name === "goal_lead" && runtime.goal !== "none") {
    if (runtime.goal.status === "running") return ["goal.begin_review", "goal.cancel"];
    if (runtime.goal.status === "not_done") return ["goal.retry", "goal.cancel"];
    if (runtime.goal.status === "reviewing") return ["goal.cancel"];
  }
  return role.allowedTransitions.default;
}

function completionAuthorityFor(runtime: RuntimePromptEnvelope): CompletionAuthority {
  if (runtime.agentName === "engineer") return "ordinary-session";
  if (runtime.agentName === "goal_lead") return "goal-coordinator";
  if (runtime.agentName === "shaper") return "bound-todo";
  if (runtime.agentName === "reviewer") return runtime.reviewMode === "goal" ? "goal-reviewer" : "ordinary-reviewer";
  return "delegated-scope";
}

export class IllegalPromptExecutionModeError extends Error {
  constructor(public readonly agentName: AgentName, public readonly reason: string) {
    super(`Illegal prompt execution mode for ${agentName}: ${reason}`);
    this.name = "IllegalPromptExecutionModeError";
  }
}

export function assertLegalExecutionMode(runtime: RuntimePromptEnvelope): void {
  const isRoot = runtime.parentSessionId === "none";
  const hasParentAgent = runtime.parentAgentName !== "none";
  const hasGoal = runtime.goal !== "none";
  const goalStatus = runtime.goal === "none" ? undefined : runtime.goal.status;
  const reject = (reason: string): never => { throw new IllegalPromptExecutionModeError(runtime.agentName, reason); };

  if (isRoot === hasParentAgent) reject("parent Session and parent Agent identities must either both be present or both be none");
  if (runtime.agentName !== "shaper" && runtime.todo !== "none") reject("only Shaper may have a bound Todo");

  switch (runtime.agentName) {
    case "engineer": if (!isRoot || hasGoal || runtime.reviewMode !== "none") reject("Engineer requires an ordinary root Session"); break;
    case "goal_lead": if (!isRoot || !hasGoal || runtime.reviewMode !== "none" || !["running", "reviewing", "not_done"].includes(goalStatus!)) reject("Goal Lead requires a supported Goal root state"); break;
    case "shaper": if (!isRoot || hasGoal || runtime.reviewMode !== "none" || runtime.todo === "none") reject("Shaper requires an ordinary bound Todo root"); break;
    case "plan":
    case "build": {
      const legalParent = runtime.parentAgentName === (hasGoal ? "goal_lead" : "engineer");
      if (isRoot || runtime.reviewMode !== "none" || !legalParent || (hasGoal && goalStatus !== "running")) reject(`${runtime.agentName} requires an Engineer parent or a running Goal Lead parent`);
      break;
    }
    case "reviewer": {
      const legalMode = hasGoal
        ? goalStatus === "reviewing" && runtime.reviewMode === "goal" && runtime.parentAgentName === "goal_lead"
        : runtime.reviewMode === "ordinary" && runtime.parentAgentName === "engineer";
      if (isRoot || !legalMode) reject("Reviewer mode or parent does not match runtime review state");
      break;
    }
    case "explore": {
      const legalParent = !hasGoal
        ? runtime.reviewMode === "none" && ["engineer", "plan", "build", "reviewer", "shaper"].includes(runtime.parentAgentName)
        : goalStatus === "running"
          ? runtime.reviewMode === "none" && ["goal_lead", "plan", "build"].includes(runtime.parentAgentName)
          : goalStatus === "reviewing" && runtime.reviewMode === "goal" && runtime.parentAgentName === "reviewer";
      if (isRoot || !legalParent) reject("Explore requires a legal parent role and lifecycle state");
      break;
    }
    case "librarian": {
      const legalParent = !hasGoal
        ? runtime.reviewMode === "none" && ["engineer", "plan", "reviewer", "shaper"].includes(runtime.parentAgentName)
        : goalStatus === "running"
          ? runtime.reviewMode === "none" && ["goal_lead", "plan"].includes(runtime.parentAgentName)
          : goalStatus === "reviewing" && runtime.reviewMode === "goal" && runtime.parentAgentName === "reviewer";
      if (isRoot || !legalParent) reject("Librarian requires a legal parent role and lifecycle state");
      break;
    }
  }
}
