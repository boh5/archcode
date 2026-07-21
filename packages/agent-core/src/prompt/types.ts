import type { AgentName } from "../agents/names";
import type { BuiltinToolName, DelegationRequest } from "@archcode/protocol";
import type { ResolvedSkill, SkillIndexEntry } from "../skills/types";
import type { VersionControl } from "../version-control/detector";

export type CapabilityRef = BuiltinToolName;
export type TransitionRef =
  | "todo.update";

export type CompletionAuthority =
  | "ordinary-session"
  | "delegated-scope"
  | "bound-todo";

export interface RoleContract {
  readonly version: "2";
  readonly name: AgentName;
  readonly displayName: string;
  readonly mission: string;
  readonly inputs: readonly string[];
  readonly requiredBehaviors: readonly string[];
  readonly forbiddenBehaviors: readonly string[];
  readonly outputs: readonly string[];
  readonly requiredCapabilities: readonly CapabilityRef[];
  readonly forbiddenCapabilities: readonly CapabilityRef[];
  readonly allowedTransitions: readonly TransitionRef[];
  readonly completionAuthority: readonly CompletionAuthority[];
  readonly delegateTargets: readonly AgentName[];
}

export type GoalPromptStatus = "active" | "paused" | "blocked" | "budget_limited" | "complete";
export type TodoPromptMode = "none" | "bound";
export type McpPromptStatus = "pending" | "ready" | "ready-zero" | "partial-warning" | "failed";

export interface RuntimePromptEnvelope {
  readonly agentName: AgentName;
  readonly sessionId: string;
  readonly rootSessionId: string;
  readonly parentSessionId: string | "none";
  readonly parentAgentName: AgentName | "none";
  readonly depth: number;
  readonly allowedDelegateTargets: readonly AgentName[];
  readonly goal: {
    readonly instanceId: string;
    readonly generation: number;
    readonly objective: string;
    readonly status: GoalPromptStatus;
  } | "none";
  readonly todo: { readonly id: string; readonly mode: "bound" } | "none";
  readonly remainingDepth: number;
  readonly maxConcurrentChildren: number;
  readonly mcp: Readonly<Record<string, McpPromptStatus>>;
}

export interface PromptSource<T> {
  readonly status: "present" | "absent" | "error";
  readonly source: string;
  readonly value?: T;
  readonly error?: string;
}

export interface PromptEnv {
  readonly platform: string;
  readonly timezone: string;
  readonly locale: string;
  readonly projectRoot: string;
  readonly cwd: string;
  readonly versionControl: VersionControl;
  readonly date: string;
}

export interface PromptMemorySnapshot {
  readonly preferences: string | "none";
  readonly index: string | "none";
}

export interface GuidanceAuthority {
  readonly kind: "guidance-only";
  readonly grants: "none";
}

export interface PromptContractV2 {
  readonly version: "2";
  readonly role: RoleContract;
  readonly runtime: RuntimePromptEnvelope;
  readonly allowedTools: readonly string[];
  readonly availableSkills: readonly SkillIndexEntry[];
  readonly activeSkills: readonly ResolvedSkill[];
  readonly guidanceAuthority: {
    readonly skills: GuidanceAuthority;
    readonly projectInstructions: GuidanceAuthority;
  };
  readonly agentsMd: PromptSource<string>;
  readonly memory: PromptSource<PromptMemorySnapshot>;
  readonly currentContext: readonly string[];
  readonly delegationRequest: DelegationRequest | "none";
  readonly env: PromptEnv;
}

export interface PromptTraceSection {
  readonly name: string;
  readonly source: string;
  readonly hash: string;
}

export interface PromptTrace {
  readonly version: "2";
  readonly status: "compiled" | "error";
  readonly hash: string;
  readonly sections: readonly PromptTraceSection[];
  readonly skills: {
    readonly status: "present" | "absent" | "error";
    readonly active: readonly { readonly name: string; readonly source: string }[];
  };
  readonly visibleTools: readonly string[];
  readonly agentsMd: PromptSource<never>["status"];
  readonly memory: PromptSource<never>["status"];
  readonly mcp: RuntimePromptEnvelope["mcp"];
  readonly warnings: readonly string[];
}

export interface CompiledPromptContract {
  readonly prompt: string;
  readonly trace: PromptTrace;
}
