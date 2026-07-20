import { z } from "zod/v4";
import { buildRoleContract, engineerRoleContract, reviewerRoleContract } from "../agents/definitions/role-contracts";
import { PromptContractCompiler } from "./compiler";
import type { PromptContractV2, RuntimePromptEnvelope } from "./types";

export const PromptLiveEvalManifestSchema = z.strictObject({
  version: z.literal(1),
  models: z.array(z.strictObject({ qualifiedId: z.string().regex(/^[^:]+:[^:]+$/) })).min(1),
  resultPath: z.string().trim().min(1),
});

export const PromptLiveEvalScenariosSchema = z.strictObject({
  version: z.literal(1),
  scenarios: z.array(z.strictObject({
    id: z.string().trim().min(1),
    agent: z.enum(["engineer", "build", "reviewer"]),
    executionMode: z.enum(["ordinary-root", "ordinary-child", "goal-review", "goal-activation-probe"]),
    probe: z.enum(["terminal-action", "execution-strategy"]).optional(),
    request: z.string().trim().min(1),
    expectedAny: z.array(z.string().trim().min(1)).min(1),
    forbidden: z.array(z.string().trim().min(1)),
  })).min(1),
});

export type PromptLiveEvalManifest = z.infer<typeof PromptLiveEvalManifestSchema>;
export type PromptLiveEvalScenarios = z.infer<typeof PromptLiveEvalScenariosSchema>;

export interface PromptLiveEvalExecutor {
  (qualifiedId: string, system: string, prompt: string): Promise<string>;
}

export interface PromptLiveEvalResult {
  readonly version: 1;
  readonly createdAt: string;
  readonly models: readonly string[];
  readonly scenarios: readonly {
    model: string;
    scenario: string;
    passed: boolean;
    matchedExpected: string[];
    matchedForbidden: string[];
    output: string;
  }[];
}

export async function runPromptLiveEval(
  manifest: PromptLiveEvalManifest,
  fixture: PromptLiveEvalScenarios,
  execute: PromptLiveEvalExecutor,
): Promise<PromptLiveEvalResult> {
  const scenarios: PromptLiveEvalResult["scenarios"][number][] = [];
  for (const { qualifiedId } of manifest.models) {
    for (const scenario of fixture.scenarios) {
      const system = (await new PromptContractCompiler().compile(
        buildLiveEvalContract(scenario),
      )).prompt;
      const prompt = scenario.executionMode === "goal-activation-probe"
        ? [
          "Classify the following user request using the Engineer Goal activation contract.",
          "Reply with exactly CREATE_GOAL when the request explicitly asks for persistent autonomous work until a defined endpoint.",
          "Reply with exactly ASK_CLARIFY when persistent work is requested but the verifiable endpoint is unclear.",
          "Reply with exactly NO_GOAL otherwise. Do not solve the request.",
          "",
          `User request: ${scenario.request}`,
        ].join("\n")
        : scenario.probe === "terminal-action"
          ? [
            "Do not perform the work. Based only on the role and runtime contract, reply with exactly the canonical terminal submission tool name.",
            `Original request: ${scenario.request}`,
          ].join("\n")
          : scenario.probe === "execution-strategy"
            ? [
              "Do not perform the work. Classify the required execution strategy from the role contract and request.",
              "Reply with exactly DIRECT, PARALLEL, or SERIAL.",
              `Original request: ${scenario.request}`,
            ].join("\n")
          : scenario.request;
      const output = await execute(qualifiedId, system, prompt);
      const normalized = output.toLowerCase();
      const matchedExpected = scenario.expectedAny.filter((term) => normalized.includes(term.toLowerCase()));
      const matchedForbidden = scenario.forbidden.filter((term) => normalized.includes(term.toLowerCase()));
      scenarios.push({
        model: qualifiedId,
        scenario: scenario.id,
        passed: matchedExpected.length > 0 && matchedForbidden.length === 0,
        matchedExpected,
        matchedForbidden,
        output,
      });
    }
  }
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    models: manifest.models.map(({ qualifiedId }) => qualifiedId),
    scenarios,
  };
}

function buildLiveEvalContract(
  scenario: PromptLiveEvalScenarios["scenarios"][number],
): PromptContractV2 {
  const base: RuntimePromptEnvelope = {
    agentName: scenario.agent,
    sessionId: "live-eval-session",
    rootSessionId: scenario.executionMode === "ordinary-root" || scenario.executionMode === "goal-activation-probe" ? "live-eval-session" : "live-eval-root",
    parentSessionId: scenario.executionMode === "ordinary-root" || scenario.executionMode === "goal-activation-probe" ? "none" : "live-eval-root",
    parentAgentName: scenario.executionMode === "ordinary-root" || scenario.executionMode === "goal-activation-probe"
      ? "none"
      : "engineer",
    depth: scenario.executionMode === "ordinary-root" || scenario.executionMode === "goal-activation-probe" ? 0 : 1,
    allowedDelegateTargets: scenario.agent === "reviewer" ? ["explore", "librarian"] : scenario.agent === "engineer" ? ["plan", "build", "reviewer", "explore", "librarian"] : ["explore"],
    goal: scenario.executionMode === "goal-review"
      ? { instanceId: "live-eval-goal", generation: 1, objective: scenario.request, status: "active" }
      : "none",
    todo: "none",
    reviewMode: scenario.agent === "reviewer" ? (scenario.executionMode === "goal-review" ? "goal" : "ordinary") : "none",
    ownedScope: scenario.agent === "build" ? [{ kind: "tree", path: "src" }] : [],
    remainingDepth: scenario.executionMode === "ordinary-root" || scenario.executionMode === "goal-activation-probe" ? 3 : 1,
    maxConcurrentChildren: 4,
    mcp: { context7: "ready" },
  };
  const role = scenario.agent === "engineer" ? engineerRoleContract : scenario.agent === "build" ? buildRoleContract : reviewerRoleContract;
  const allowedTools = scenario.agent === "engineer"
    ? ["file_read", "delegate", "create_goal", "get_goal", "update_goal"]
    : scenario.agent === "build"
      ? ["file_read", "file_edit", "delegate", "submit_child_result"]
      : ["file_read", "delegate", "submit_child_result"];
  return {
    version: "2",
    role,
    runtime: base,
    allowedTools,
    availableSkills: [],
    activeSkills: [],
    guidanceAuthority: {
      skills: { kind: "guidance-only", grants: "none" },
      projectInstructions: { kind: "guidance-only", grants: "none" },
    },
    agentsMd: { status: "absent", source: "live-eval fixture" },
    memory: { status: "absent", source: "live-eval fixture" },
    currentContext: [`liveEvalScenario=${scenario.id}`],
    delegation: scenario.agent === "build" ? {
      hash: "a".repeat(64),
      contract: {
        agent_type: "build", title: "Live eval child result", objective: scenario.request,
        owned_scope: [{ kind: "tree", path: "src" }], non_goals: [],
        acceptance_criteria: [{ id: "AC-1", condition: "Complete the delegated scope", requiredEvidence: "verification output" }],
        evidence: [], verification: [], depends_on: [], skills: [], background: false,
      },
    } : "none",
    env: { platform: "linux", timezone: "UTC", locale: "en-US", projectRoot: "/workspace", cwd: "/workspace", versionControl: "git", date: "2026-07-18" },
  };
}
