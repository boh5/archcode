import { describe, expect, test } from "bun:test";
import {
  buildRoleContract,
  engineerRoleContract,
  exploreRoleContract,
  librarianRoleContract,
  planRoleContract,
  reviewerRoleContract,
  shaperRoleContract,
} from "../agents/definitions/role-contracts";
import { PromptContractCompiler, createFailedPromptTrace } from "./compiler";
import { IllegalPromptExecutionModeError, PromptContractLintError, lintRoleContract } from "./lint";
import type { PromptContractV2, RuntimePromptEnvelope } from "./types";

const ACTIVE_GOAL = {
  instanceId: "goal-instance-1",
  generation: 2,
  objective: "Migrate authentication and make every authentication test pass.",
  status: "active",
} as const;

function runtime(overrides: Partial<RuntimePromptEnvelope> = {}): RuntimePromptEnvelope {
  return {
    agentName: "engineer",
    sessionId: "session-1",
    rootSessionId: "session-1",
    parentSessionId: "none",
    parentAgentName: "none",
    depth: 0,
    allowedDelegateTargets: ["plan", "build", "reviewer", "explore", "librarian"],
    goal: "none",
    todo: "none",
    ownedScope: [],
    remainingDepth: 3,
    maxConcurrentChildren: 4,
    mcp: { context7: "ready", exa: "pending" },
    ...overrides,
  };
}

function child(
  agentName: RuntimePromptEnvelope["agentName"],
  parentAgentName: Exclude<RuntimePromptEnvelope["parentAgentName"], "none">,
  overrides: Partial<RuntimePromptEnvelope> = {},
): RuntimePromptEnvelope {
  return runtime({
    agentName,
    sessionId: `${agentName}-child`,
    rootSessionId: "session-1",
    parentSessionId: "session-1",
    parentAgentName,
    depth: 1,
    goal: "none",
    allowedDelegateTargets: [],
    ...overrides,
  });
}

function contract(overrides: Partial<PromptContractV2> = {}): PromptContractV2 {
  return {
    version: "2",
    role: engineerRoleContract,
    runtime: runtime(),
    allowedTools: ["file_read", "delegate"],
    availableSkills: [],
    activeSkills: [],
    guidanceAuthority: {
      skills: { kind: "guidance-only", grants: "none" },
      projectInstructions: { kind: "guidance-only", grants: "none" },
    },
    agentsMd: { status: "absent", source: "/workspace/AGENTS.md" },
    memory: { status: "absent", source: "agent-definition" },
    currentContext: [],
    delegationRequest: "none",
    env: {
      platform: "darwin",
      timezone: "Asia/Shanghai",
      locale: "zh-CN",
      projectRoot: "/workspace",
      cwd: "/workspace",
      versionControl: "git",
      date: "2026-07-19",
    },
    ...overrides,
  };
}

describe("PromptContractCompiler", () => {
  test("keeps an ordinary Engineer prompt free of Goal orchestration", async () => {
    const result = await new PromptContractCompiler().compile(contract());

    expect(result.prompt).toContain("Goal: none");
    expect(result.prompt).not.toContain("## Active Goal");
    expect(result.prompt).not.toContain("Goal Lead");
    expect(result.prompt).not.toContain("goal_manage");
    expect(result.trace.sections.map(({ name }) => name)).toEqual([
      "Shared Kernel",
      "Runtime Envelope",
      "Role Contract",
      "Collaboration Contract",
      "Skills",
      "Tool Visibility",
      "Current Context",
      "Memory",
      "Project Instructions",
      "Environment",
    ]);
  });

  test("adds a narrow active-Goal overlay only to the root Engineer", async () => {
    const result = await new PromptContractCompiler().compile(contract({
      runtime: runtime({ goal: ACTIVE_GOAL }),
      allowedTools: ["file_read", "delegate", "create_goal", "get_goal", "update_goal"],
    }));

    expect(result.prompt).toContain("## Active Goal");
    expect(result.prompt).toContain(`Instance: ${ACTIVE_GOAL.instanceId}`);
    expect(result.prompt).toContain(`Generation: ${ACTIVE_GOAL.generation}`);
    expect(result.prompt).toContain(`Objective: ${ACTIVE_GOAL.objective}`);
    expect(result.prompt).toContain("delegate an independent Reviewer");
    expect(result.prompt).toContain("review_session_id");
    expect(result.prompt).toContain("Do not self-review");
    expect(result.prompt).not.toContain("goal_manage");
    expect(result.trace.sections.filter(({ name }) => name === "Active Goal")).toHaveLength(1);
  });

  test("gives every Reviewer one normal final verdict contract", async () => {
    const result = await new PromptContractCompiler().compile(contract({
      role: reviewerRoleContract,
      runtime: child("reviewer", "engineer", { allowedDelegateTargets: ["explore", "librarian"] }),
      allowedTools: ["file_read", "delegate"],
    }));

    expect(result.prompt).toContain("Completion authority: reviewer");
    expect(result.prompt).toContain("VERDICT: APPROVED");
    expect(result.prompt).toContain("VERDICT: CHANGES_REQUESTED");
    expect(result.prompt).not.toContain("submit_child_result");
    expect(result.prompt).not.toContain("## Active Goal");
  });

  test("renders only the strict DelegationRequest fields", async () => {
    const result = await new PromptContractCompiler().compile(contract({
      role: buildRoleContract,
      runtime: child("build", "engineer", { ownedScope: [{ kind: "tree", path: "src" }], allowedDelegateTargets: ["explore"] }),
      allowedTools: ["file_read", "file_edit", "delegate"],
      delegationRequest: {
        agent_type: "build",
        title: "Implement parser",
        objective: "Implement the parser and verify the change.",
        owned_scope: [{ kind: "tree", path: "src" }],
        skills: [],
        background: true,
      },
    }));

    expect(result.prompt).toContain("Delegation title: Implement parser");
    expect(result.prompt).toContain("Delegation objective: Implement the parser and verify the change.");
    expect(result.prompt).toContain("Background: true");
    expect(result.prompt).not.toContain("contract hash");
    expect(result.prompt).not.toContain("Acceptance criteria:");
  });

  test("compiles every formal Agent in a legal mode", async () => {
    const cases: Array<Pick<PromptContractV2, "role" | "allowedTools"> & { runtime: RuntimePromptEnvelope }> = [
      { role: engineerRoleContract, allowedTools: ["file_read", "delegate"], runtime: runtime() },
      { role: engineerRoleContract, allowedTools: ["file_read", "delegate"], runtime: runtime({ goal: ACTIVE_GOAL }) },
      { role: planRoleContract, allowedTools: ["file_read", "delegate"], runtime: child("plan", "engineer", { allowedDelegateTargets: ["explore", "librarian"] }) },
      { role: buildRoleContract, allowedTools: ["file_read", "file_edit", "delegate"], runtime: child("build", "engineer", { allowedDelegateTargets: ["explore"] }) },
      { role: reviewerRoleContract, allowedTools: ["file_read", "delegate"], runtime: child("reviewer", "engineer", { allowedDelegateTargets: ["explore", "librarian"] }) },
      { role: exploreRoleContract, allowedTools: ["file_read"], runtime: child("explore", "engineer") },
      { role: librarianRoleContract, allowedTools: ["web_fetch"], runtime: child("librarian", "engineer") },
      { role: shaperRoleContract, allowedTools: ["project_todo_update", "delegate"], runtime: runtime({ agentName: "shaper", todo: { id: "todo-1", mode: "bound" }, allowedDelegateTargets: ["explore", "librarian"] }) },
    ];

    for (const item of cases) {
      const result = await new PromptContractCompiler().compile(contract(item));
      expect(result.prompt).toContain(`Agent: ${item.role.name}`);
    }
  });

  test("rejects illegal role/runtime combinations", async () => {
    await expect(new PromptContractCompiler().compile(contract({
      role: reviewerRoleContract,
      runtime: runtime({ agentName: "reviewer" }),
      allowedTools: ["file_read", "delegate"],
    }))).rejects.toBeInstanceOf(IllegalPromptExecutionModeError);
  });

  test("records failed compilation without granting guidance authority", () => {
    const trace = createFailedPromptTrace(contract(), new Error("failed"));
    expect(trace.status).toBe("error");
    expect(trace.warnings).toEqual(["failed"]);
    expect(trace.hash).toHaveLength(64);
  });
});

describe("lintRoleContract", () => {
  test("enforces typed capabilities and delegation targets", () => {
    expect(() => lintRoleContract(engineerRoleContract, runtime(), ["file_read", "delegate"]))
      .not.toThrow();
    expect(() => lintRoleContract(engineerRoleContract, runtime({ allowedDelegateTargets: ["shaper"] }), ["file_read", "delegate"]))
      .toThrow(PromptContractLintError);
    expect(() => lintRoleContract(engineerRoleContract, runtime({ allowedDelegateTargets: ["explore"] }), ["file_read"]))
      .toThrow(PromptContractLintError);
  });
});
