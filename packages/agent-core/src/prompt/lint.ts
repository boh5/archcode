import type { AgentName } from "../agents/names";
import type { CapabilityRef, CompletionAuthority, PromptContractV2, RoleContract, RuntimePromptEnvelope, TransitionRef } from "./types";

const TRANSITION_CAPABILITIES: Readonly<Record<TransitionRef, CapabilityRef>> = {
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

  for (const capability of role.requiredCapabilities) {
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
  for (const transition of role.allowedTransitions) {
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

function completionAuthorityFor(runtime: RuntimePromptEnvelope): CompletionAuthority {
  if (runtime.agentName === "lead") return runtime.todo === "none" ? "ordinary-session" : "bound-todo";
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
  const reject = (reason: string): never => { throw new IllegalPromptExecutionModeError(runtime.agentName, reason); };

  if (isRoot === hasParentAgent) reject("parent Session and parent Agent identities must either both be present or both be none");
  if (runtime.agentName !== "lead" && runtime.todo !== "none") reject("only a root Lead may have a bound Todo");

  switch (runtime.agentName) {
    case "lead": {
      if (!isRoot) reject("Lead requires a root Session");
      if (runtime.todo !== "none" && hasGoal) reject("a Discussion Lead cannot own a Goal");
      break;
    }
    case "analyst":
    case "build": {
      if (isRoot || hasGoal || runtime.parentAgentName !== "lead") reject(`${runtime.agentName} requires a Lead parent and a DelegationRequest`);
      break;
    }
    case "explore": {
      const legalParent = !hasGoal && ["lead", "analyst", "build"].includes(runtime.parentAgentName);
      if (isRoot || !legalParent) reject("Explore requires a legal parent role");
      break;
    }
    case "librarian": {
      const legalParent = !hasGoal && ["lead", "analyst"].includes(runtime.parentAgentName);
      if (isRoot || !legalParent) reject("Librarian requires a legal parent role");
      break;
    }
  }
}
