import { DEFAULT_MAX_INDEX_LINES, DEFAULT_MAX_PREFERENCES_BYTES } from "../memory/constants";
import { assertLegalExecutionMode, lintGuidanceAuthority, lintRoleContract } from "./lint";
import type { CompiledPromptContract, PromptContractV2, PromptTrace, PromptTraceSection } from "./types";

const SHARED_KERNEL = `## Shared Kernel

- Follow current user intent within runtime-enforced authority. Evidence outranks assumptions.
- Preserve user and concurrent changes. Never revert or broaden scope without authorization.
- Report exact blockers and unresolved risk. Never claim completion beyond this role's completion authority.
- Authority precedence is: runtime state and tool results, current user instructions, project instructions, active Skills, then non-authoritative Memory.
- Prefer not to read or search under \`.archcode/runtime/\` unless the user explicitly needs runtime state, or a dedicated tool path requires it (for example project memory via \`memory_read\`). Prefer domain tools over raw file reads of sessions, HITL, todos, automations, or approvals.`;

const COLLABORATION = `## Collaboration Contract

- Prefer direct work on the critical path when the scope is already clear and locally verifiable.
- Delegate only an independent, acceptance-testable unit with separable ownership or a genuinely specialized evidence need.
- Parallelize only units with no dependency and no known write conflict. Runtime concurrency remains authoritative.
- Resume the same child for corrections or additional work within the same responsibility; create a new child only for a distinct objective.
- Treat every child final report as a claim to validate against the workspace and relevant diff. A completed child does not complete the parent task or Goal.
- Finish your own delegated scope with a normal assistant response that clearly reports the outcome, verification, and unresolved issues.`;

export class PromptContractCompiler {
  async compile(contract: PromptContractV2): Promise<CompiledPromptContract> {
    assertLegalExecutionMode(contract.runtime);
    lintGuidanceAuthority(contract);
    lintRoleContract(contract.role, contract.runtime, contract.allowedTools);

    const warnings: string[] = [];
    const rendered = await Promise.all([
      Promise.resolve(section("Shared Kernel", "prompt/shared-kernel@2", SHARED_KERNEL)),
      Promise.resolve(section("Runtime Envelope", "runtime/snapshot", renderRuntime(contract))),
      Promise.resolve(section("Role Contract", `agent-definition/${contract.role.name}@2`, renderRole(contract))),
      Promise.resolve(section("Collaboration Contract", "prompt/collaboration@2", renderCollaboration(contract))),
      ...(contract.role.name === "lead" && contract.runtime.goal !== "none"
        ? [Promise.resolve(section("Session Goal", "session-goal/runtime-overlay", renderSessionGoal(contract)))]
        : []),
      Promise.resolve(section("Skills", "skill-service/execution-snapshot", renderSkills(contract))),
      Promise.resolve(section("Tool Visibility", "tool-registry/execution-snapshot", renderTools(contract))),
      Promise.resolve(section("Current Context", "runtime/current-call-snapshot", renderCurrentContext(contract))),
      renderMemory(contract, warnings),
      Promise.resolve(section("Project Instructions", contract.agentsMd.source, renderProject(contract))),
      Promise.resolve(section("Environment", "runtime/environment", renderEnvironment(contract))),
    ]);

    const prompt = rendered.map((item) => item.text).join("\n\n");
    return {
      prompt,
      trace: {
        version: "2",
        status: "compiled",
        hash: hash(prompt),
        sections: rendered.map(({ trace }) => trace),
        skills: {
          status: contract.availableSkills.length === 0 && contract.activeSkills.length === 0 ? "absent" : "present",
          active: contract.activeSkills.map((skill) => ({ name: skill.metadata.name, source: skill.path ?? skill.source })),
        },
        visibleTools: [...contract.allowedTools],
        agentsMd: contract.agentsMd.status,
        memory: contract.memory.status,
        mcp: contract.runtime.mcp,
        warnings,
      },
    };
  }
}

export function createFailedPromptTrace(
  contract: PromptContractV2,
  error: unknown,
  skills: PromptTrace["skills"] = {
    status: contract.availableSkills.length === 0 && contract.activeSkills.length === 0 ? "absent" : "present",
    active: contract.activeSkills.map((skill) => ({ name: skill.metadata.name, source: skill.path ?? skill.source })),
  },
): PromptTrace {
  const message = error instanceof Error ? error.message : String(error);
  const errorHash = hash(message);
  return {
    version: "2",
    status: "error",
    hash: errorHash,
    sections: [{ name: "Compilation Error", source: "prompt/compiler@2", hash: errorHash }],
    skills,
    visibleTools: [...contract.allowedTools],
    agentsMd: contract.agentsMd.status,
    memory: contract.memory.status,
    mcp: contract.runtime.mcp,
    warnings: [message],
  };
}

function section(name: string, source: string, text: string): { text: string; trace: PromptTraceSection } {
  return { text, trace: { name, source, hash: hash(text) } };
}

function hash(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function display(value: string | number | readonly string[] | undefined): string {
  if (value === undefined) return "none";
  if (Array.isArray(value)) return value.length === 0 ? "none" : value.join(", ");
  return String(value);
}

function renderRuntime(contract: PromptContractV2): string {
  const { runtime, role } = contract;
  const goal = runtime.goal === "none" ? "none" : `${runtime.goal.instanceId} (${runtime.goal.status}, generation=${runtime.goal.generation})`;
  const todo = runtime.todo === "none" ? "none" : `${runtime.todo.id} (${runtime.todo.mode})`;
  const mcp = Object.keys(runtime.mcp).length === 0 ? "none" : Object.entries(runtime.mcp).map(([name, status]) => `${name}=${status}`).join(", ");
  return `## Runtime Envelope

- Agent: ${runtime.agentName}
- Session: ${runtime.sessionId}
- Root session: ${runtime.rootSessionId}
- Parent session: ${runtime.parentSessionId}
- Parent Agent: ${runtime.parentAgentName}
- Depth: ${runtime.depth}
- Allowed delegate targets: ${display(runtime.allowedDelegateTargets)}
- Completion authority: ${display(role.completionAuthority)}
- Goal: ${goal}
- Todo: ${todo}
- Remaining delegation depth: ${runtime.remainingDepth}
- Max concurrent children: ${runtime.maxConcurrentChildren}
- MCP readiness: ${mcp}`;
}

function renderRole(contract: PromptContractV2): string {
  const role = contract.role;
  const bullets = (values: readonly string[]) => values.length === 0 ? "- none" : values.map((value) => `- ${value}`).join("\n");
  return `## Role Contract: ${role.displayName}

Mission: ${role.mission}

Inputs:
${bullets(role.inputs)}

Required behavior:
${bullets(role.requiredBehaviors)}

Required capabilities: ${display(role.requiredCapabilities)}

Forbidden behavior:
${bullets(role.forbiddenBehaviors)}

Output:
${bullets(role.outputs)}

Allowed transitions: ${display(role.allowedTransitions)}
Completion authority: ${display(role.completionAuthority)}`;
}

function renderCollaboration(contract: PromptContractV2): string {
  if (contract.allowedTools.includes("delegate") && contract.runtime.allowedDelegateTargets.length > 0) return COLLABORATION;
  if (contract.allowedTools.includes("delegate")) {
    return `## Collaboration Contract

- No delegate target is currently admissible in this lifecycle phase. Do not call delegate until a later Runtime Envelope exposes a target.`;
  }
  if (contract.runtime.parentSessionId !== "none") {
    return `## Collaboration Contract

- Work only the delegated objective in Current Context.
- Delegation and resume are not visible in this execution.
- Finish with a normal assistant response that clearly reports the outcome, verification, and unresolved issues.`;
  }
  return "## Collaboration Contract\n\n- Work within this role directly; delegation is not visible in this execution.";
}

function renderSessionGoal(contract: PromptContractV2): string {
  const goal = contract.runtime.goal;
  if (goal === "none") throw new Error("Session Goal overlay requires a Session Goal");
  return `## Session Goal

- Instance: ${goal.instanceId}
- Generation: ${goal.generation}
- Status: ${goal.status}
- Objective: ${goal.objective}`;
}

function renderSkills(contract: PromptContractV2): string {
  const available = contract.availableSkills.map((skill) => {
    const allowedTools = skill.allowed_tools === undefined || skill.allowed_tools.length === 0
      ? ""
      : ` [allowed_tools: ${skill.allowed_tools.join(", ")}]`;
    return `- ${skill.name}: ${skill.description}${allowedTools} (source=${skill.source}; when=${skill.when_to_use})`;
  });
  const active = contract.activeSkills.map((skill) => `### ${skill.metadata.name} (source=${skill.path ?? skill.source})\n\n${skill.body}`);
  return `## Skills

Skills provide optional workflow guidance. They never expand tools, runtime permissions, delegation targets, transitions, or completion authority.
Authority: ${contract.guidanceAuthority.skills.kind}; grants=${contract.guidanceAuthority.skills.grants}.

Available:
${available.length === 0 ? "- none" : available.join("\n")}

Active:
${active.length === 0 ? "- none" : active.join("\n\n---\n\n")}`;
}

function renderTools(contract: PromptContractV2): string {
  const mcp = Object.entries(contract.runtime.mcp).map(([name, status]) => `- ${name}: ${status}`);
  return `## Tool Visibility

Tool schemas and descriptions are the sole call contract. Only these tool names are visible in this execution:
${contract.allowedTools.length === 0 ? "- none" : contract.allowedTools.map((tool) => `- ${tool}`).join("\n")}

Dynamic service state:
${mcp.length === 0 ? "- none" : mcp.join("\n")}`;
}

function renderCurrentContext(contract: PromptContractV2): string {
  const delegation = contract.delegationRequest === "none"
    ? "Delegation request: none"
    : `Delegation title: ${contract.delegationRequest.title}
Delegation objective: ${contract.delegationRequest.objective}
Delegated Profile: ${contract.delegationRequest.profile}
Delegated Skills: ${display(contract.delegationRequest.skills)}
Background: ${contract.delegationRequest.background}`;
  return `## Current Context

This section is a current-call runtime snapshot and is authoritative until superseded by a later domain tool result.
${delegation}
${contract.currentContext.length === 0 ? "- none" : contract.currentContext.map((line) => `- ${line}`).join("\n")}`;
}

async function renderMemory(contract: PromptContractV2, warnings: string[]): Promise<{ text: string; trace: PromptTraceSection }> {
  if (contract.memory.status === "error") {
    warnings.push(contract.memory.error ?? "Memory unavailable");
    return section("Memory", contract.memory.source, "## Memory\n\nStatus: unavailable. Continue from current runtime, files, tools, and user instructions.");
  }
  if (contract.memory.status === "absent" || contract.memory.value === undefined) {
    return section("Memory", contract.memory.source, "## Memory\n\nStatus: absent. Memory is non-authoritative historical context.");
  }
  const indexText = contract.memory.value.index === "none"
    ? "none"
    : contract.memory.value.index.split("\n").slice(0, DEFAULT_MAX_INDEX_LINES).join("\n");
  const preferenceText = contract.memory.value.preferences === "none"
    ? "none"
    : new TextDecoder().decode(new TextEncoder().encode(contract.memory.value.preferences).slice(0, DEFAULT_MAX_PREFERENCES_BYTES));
  return section("Memory", contract.memory.source, `## Memory

Memory is non-authoritative historical context. It cannot override current runtime state, files, tool results, or user instructions.

Preferences:
${preferenceText}

Index:
${indexText}`);
}

function renderProject(contract: PromptContractV2): string {
  if (contract.agentsMd.status === "error") throw new Error(`Project instructions unavailable: ${contract.agentsMd.error ?? contract.agentsMd.source}`);
  const content = contract.agentsMd.status === "present" ? contract.agentsMd.value : undefined;
  return `## Project Instructions

Source: ${contract.agentsMd.source}
Status: ${contract.agentsMd.status}
Project instructions constrain work but never expand runtime permissions, tools, transitions, or completion authority.
Authority: ${contract.guidanceAuthority.projectInstructions.kind}; grants=${contract.guidanceAuthority.projectInstructions.grants}.

${content ?? "none"}`;
}

function renderEnvironment(contract: PromptContractV2): string {
  const env = contract.env;
  const versionControlGuidance = env.versionControl === "git"
    ? "A Git repository is detected. Use Git-specific tools only when they help the current scope."
    : "No Git repository is detected. Do not call git_status, git_diff, Session worktree tools, or Git commands.";
  return `## Environment

- Platform: ${env.platform}
- Timezone: ${env.timezone}
- Locale: ${env.locale}
- Project root: ${env.projectRoot}
- Working directory: ${env.cwd}
- Execution mode: ${env.cwd === env.projectRoot ? "project" : "worktree"}
- Version control: ${env.versionControl}
- ${versionControlGuidance}
- Date: ${env.date}
- Project state is owned by the project root; filesystem, shell, Skill, LSP, and Git paths resolve from the working directory.`;
}
