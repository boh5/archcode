import { afterAll, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { GoalStateManager } from "../goals/state";
import { HitlService } from "../hitl/service";
import { MemoryFileManager } from "../memory/file-manager";
import type { ProjectContext } from "../projects/types";
import { SkillService } from "../skills";
import { storeManager } from "../store/store";
import { createMockStore } from "../store/test-helpers";
import { silentLogger } from "../logger";
import { ProjectApprovalManager } from "./permission";
import type { PermissionApprovalScope } from "./permission";
import { createRegistry } from "./registry";
import { createToolExecutionContext, type ToolDescriptor, type ToolExecutionContext } from "./types";
import { z } from "zod";

const TMP_ROOT = join(import.meta.dir, "__test_tmp__", "registry-projectcontext");
const testSkillService = new SkillService({ builtinSkills: {} });

const APPROVAL_SCOPE: PermissionApprovalScope = {
  kind: "tool-operation",
  toolName: "ctx_sensitive_tool",
  operation: "write",
};

afterAll(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
});

async function createProjectContext(name: string): Promise<ProjectContext> {
  const workspaceRoot = join(TMP_ROOT, `${name}-${crypto.randomUUID()}`);
  await mkdir(workspaceRoot, { recursive: true });

  const approvals = new ProjectApprovalManager(silentLogger);
  await approvals.load(workspaceRoot);

  return {
    project: {
      slug: name,
      name,
      workspaceRoot,
      addedAt: new Date().toISOString(),
    },
    goalState: new GoalStateManager(workspaceRoot),
    hitl: new HitlService(),
    memory: new MemoryFileManager({
      project: join(workspaceRoot, ".archcode", "memory"),
      user: join(workspaceRoot, ".archcode", "user-memory"),
    }),
    approvals,
  };
}

function createContext(projectContext: ProjectContext): ToolExecutionContext {
  return createToolExecutionContext({ store: createMockStore(), storeManager, toolName: "ctx_sensitive_tool",
  toolCallId: "ctx-sensitive-call",
  input: {},
  step: 1,
  abort: new AbortController().signal,
  startedAt: Date.now(),
  allowedTools: new Set(["ctx_sensitive_tool"]),
  agentSkills: [],
  skillService: testSkillService,
  projectContext, });
}

function createSensitiveDescriptor(): ToolDescriptor {
  return {
    name: "ctx_sensitive_tool",
    description: "Sensitive tool requiring project approval",
    inputSchema: z.object({}).strict(),
    traits: { readOnly: false, destructive: false, concurrencySafe: false },
    permissions: [async () => ({
      outcome: "ask",
      reason: "needs project approval",
      approval: {
        eligible: true,
        scope: APPROVAL_SCOPE,
        display: "Trust ctx sensitive tool",
        reason: "needs project approval",
      },
    })],
    execute: mock(async () => "executed"),
  };
}

describe("ToolRegistry projectContext approval flow", () => {
  test("approve_always stores approval on ctx.projectContext.approvals and reuses only that context", async () => {
    const registry = createRegistry([createSensitiveDescriptor()]);
    const projectContextA = await createProjectContext("project-a");
    const projectContextB = await createProjectContext("project-b");
    const confirmA = mock(async () => "approve_always" as const);
    const confirmB = mock(async () => "approve_once" as const);

    const first = await registry.execute(
      { toolName: "ctx_sensitive_tool", toolCallId: "first", input: {} },
      { ...createContext(projectContextA), toolCallId: "first", confirmPermission: confirmA },
    );
    const second = await registry.execute(
      { toolName: "ctx_sensitive_tool", toolCallId: "second", input: {} },
      { ...createContext(projectContextA), toolCallId: "second", confirmPermission: confirmA },
    );
    const isolated = await registry.execute(
      { toolName: "ctx_sensitive_tool", toolCallId: "isolated", input: {} },
      { ...createContext(projectContextB), toolCallId: "isolated", confirmPermission: confirmB },
    );

    expect(first.isError).toBe(false);
    expect(second.isError).toBe(false);
    expect(isolated.isError).toBe(false);
    expect(projectContextA.approvals.hasApproval(APPROVAL_SCOPE)).toBe(true);
    expect(projectContextB.approvals.hasApproval(APPROVAL_SCOPE)).toBe(false);
    expect(confirmA).toHaveBeenCalledTimes(1);
    expect(confirmB).toHaveBeenCalledTimes(1);
  });
});
