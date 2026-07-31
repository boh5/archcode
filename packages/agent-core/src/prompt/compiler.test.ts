import { describe, expect, test } from "bun:test";
import {
  buildRoleContract,
  discussionRoleContract,
  leadRoleContract,
  exploreRoleContract,
  librarianRoleContract,
  analystRoleContract,
} from "../agents/definitions/role-contracts";
import { PromptContractCompiler, createFailedPromptTrace } from "./compiler";
import { IllegalPromptExecutionModeError, PromptContractLintError, lintRoleContract } from "./lint";
import type { PromptContractV2, RuntimePromptEnvelope } from "./types";

function runtime(overrides: Partial<RuntimePromptEnvelope> = {}): RuntimePromptEnvelope {
  return {
    agentName: "lead",
    sessionId: "session-1",
    rootSessionId: "session-1",
    parentSessionId: "none",
    parentAgentName: "none",
    depth: 0,
    allowedDelegateTargets: ["analyst", "build", "explore", "librarian"],
    todo: "none",
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
    allowedDelegateTargets: [],
    ...overrides,
  });
}

function contract(overrides: Partial<PromptContractV2> = {}): PromptContractV2 {
  return {
    version: "2",
    role: leadRoleContract,
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
  test("keeps Runtime and Current Context free of Session Goal state", async () => {
    const result = await new PromptContractCompiler().compile(contract());

    expect(result.prompt).not.toContain("## Session Goal");
    expect(result.prompt).not.toContain("Goal:");
    expect(result.prompt).not.toContain("goalInstanceId");
    expect(result.prompt).not.toContain("goalObjective");
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

  test("keeps ordinary Analyst review output Skill-driven", async () => {
    const result = await new PromptContractCompiler().compile(contract({
      role: analystRoleContract,
      runtime: child("analyst", "lead", { allowedDelegateTargets: ["explore", "librarian"] }),
      allowedTools: ["file_read", "delegate"],
    }));

    expect(result.prompt).toContain("Completion authority: delegated-scope");
    expect(result.prompt).not.toContain("## Session Goal");
  });

  test("renders only the strict DelegationRequest fields", async () => {
    const result = await new PromptContractCompiler().compile(contract({
      role: buildRoleContract,
      runtime: child("build", "lead", { allowedDelegateTargets: ["explore"] }),
      allowedTools: ["file_read", "file_edit", "delegate"],
      delegationRequest: {
        agent_type: "build",
        profile: "deep",
        title: "Implement parser",
        objective: "Implement the parser and verify the change.",
        skills: [],
        background: true,
      },
    }));

    expect(result.prompt).toContain("Delegation title: Implement parser");
    expect(result.prompt).toContain("Delegation objective: Implement the parser and verify the change.");
    expect(result.prompt).toContain("Background: true");
  });

  test("compiles every formal Agent in a legal mode", async () => {
    const cases: Array<Pick<PromptContractV2, "role" | "allowedTools"> & { runtime: RuntimePromptEnvelope }> = [
      { role: leadRoleContract, allowedTools: ["file_read", "delegate"], runtime: runtime() },
      {
        role: discussionRoleContract,
        allowedTools: ["file_read", "file_write", "file_edit", "project_todo_update", "delegate"],
        runtime: runtime({
          agentName: "discussion",
          todo: { id: "todo-1", mode: "bound" },
          allowedDelegateTargets: ["explore", "librarian"],
          remainingDepth: 2,
        }),
      },
      { role: analystRoleContract, allowedTools: ["file_read", "delegate"], runtime: child("analyst", "lead", { allowedDelegateTargets: ["explore", "librarian"] }) },
      { role: buildRoleContract, allowedTools: ["file_read", "file_edit", "delegate"], runtime: child("build", "lead", { allowedDelegateTargets: ["explore"] }) },
      { role: exploreRoleContract, allowedTools: ["file_read"], runtime: child("explore", "lead") },
      { role: librarianRoleContract, allowedTools: ["web_fetch"], runtime: child("librarian", "lead") },
      { role: exploreRoleContract, allowedTools: ["file_read"], runtime: child("explore", "discussion") },
      { role: librarianRoleContract, allowedTools: ["web_fetch"], runtime: child("librarian", "discussion") },
      { role: leadRoleContract, allowedTools: ["file_read", "delegate"], runtime: runtime({ todo: { id: "todo-1", mode: "bound" } }) },
    ];

    for (const item of cases) {
      const result = await new PromptContractCompiler().compile(contract(item));
      expect(result.prompt).toContain(`Agent: ${item.role.name}`);
    }
  });

  test("rejects illegal role/runtime combinations", async () => {
    await expect(new PromptContractCompiler().compile(contract({
      role: analystRoleContract,
      runtime: runtime({ agentName: "analyst" }),
      allowedTools: ["file_read", "delegate"],
    }))).rejects.toBeInstanceOf(IllegalPromptExecutionModeError);
    await expect(new PromptContractCompiler().compile(contract({
      role: analystRoleContract,
      runtime: child("analyst", "discussion"),
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
    expect(() => lintRoleContract(leadRoleContract, runtime(), ["file_read", "delegate"]))
      .not.toThrow();
    expect(() => lintRoleContract(leadRoleContract, runtime({ allowedDelegateTargets: ["lead"] }), ["file_read", "delegate"]))
      .toThrow(PromptContractLintError);
    expect(() => lintRoleContract(leadRoleContract, runtime({ allowedDelegateTargets: ["explore"] }), ["file_read"]))
      .toThrow(PromptContractLintError);
  });
});
