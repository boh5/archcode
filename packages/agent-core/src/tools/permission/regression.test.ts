import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { silentLogger, type Logger } from "../../logger";
import { storeManager } from "../../store/store";
import { defineTool } from "../define-tool";
import { createTextToolResult } from "../results";
import type { ToolRegistry } from "../registry";
import { createTestToolRegistryFixture, type TestToolRegistryFixture } from "../test-registry";
import type {
  PermissionDecision,
  ToolCallLike,
  ToolDescriptor,
  ToolExecutionContext,
  ToolPermission,
} from "../types";
import type { FinalizedToolResult } from "@archcode/protocol";
import { createProtectedPathPermission } from "./protected-path";
import { ProjectApprovalLoadError, ProjectApprovalManager } from "./project-approvals";
import type { PermissionApprovalScope } from "./policy-types";
import { createTestProjectContext } from "../test-project-context";
import { createMockStore } from "../../store/test-helpers";

const TMP_DIR = realpathSync.native(mkdtempSync(join(tmpdir(), "archcode-permission-regression-")));
const WORKSPACE = join(TMP_DIR, "workspace");
const OUTSIDE = join(TMP_DIR, "outside");
const registryFixtures: TestToolRegistryFixture[] = [];

function createTestRegistry(descriptors: ToolDescriptor[]): ToolRegistry {
  const fixture = createTestToolRegistryFixture({ descriptors });
  registryFixtures.push(fixture);
  return fixture.registry;
}

function settled(outcome: Awaited<ReturnType<ToolRegistry["execute"]>>): FinalizedToolResult {
  if (outcome.kind !== "settled") throw new Error("Expected settled Registry outcome");
  return outcome.result;
}

const ELIGIBLE_SCOPE: PermissionApprovalScope = {
  kind: "bash-exact",
  command: "sudo apt update",
  cwd: WORKSPACE,
  accesses: [],
};

const INELIGIBLE_ASK: PermissionDecision = {
  outcome: "ask",
  reason: "This approval is restricted to one execution",
  prompt: "Review one-time command",
  source: "builtin-policy",
  ruleId: "ask-one-time",
  display: "sudo command-with-secret",
  approval: {
    eligible: false,
    scope: ELIGIBLE_SCOPE,
    display: "sudo command-with-secret",
    reason: "This approval is restricted to one execution",
  },
};

const ELIGIBLE_ASK: PermissionDecision = {
  outcome: "ask",
  reason: "Privilege escalation requires confirmation",
  prompt: "Review privileged command",
  source: "builtin-policy",
  ruleId: "ask-privilege-escalation",
  display: "sudo apt update",
  approval: {
    eligible: true,
    scope: ELIGIBLE_SCOPE,
    display: "sudo apt update",
    reason: "Privilege escalation requires confirmation",
  },
};

const DENY_DECISION: PermissionDecision = {
  outcome: "deny",
  reason: "Hard deny wins",
  source: "builtin-policy",
  ruleId: "deny-regression",
};

function resetWorkspace(): void {
  rmSync(WORKSPACE, { recursive: true, force: true });
  rmSync(OUTSIDE, { recursive: true, force: true });
  mkdirSync(join(WORKSPACE, "src"), { recursive: true });
  mkdirSync(join(WORKSPACE, ".archcode", "runtime", "memory"), { recursive: true });
  mkdirSync(OUTSIDE, { recursive: true });
  writeFileSync(join(WORKSPACE, "src", "main.ts"), "export const value = 1;\n");
  writeFileSync(join(WORKSPACE, ".archcode", "runtime", "permissions.json"), '{"approvals":[]}\n');
  writeFileSync(join(OUTSIDE, "outside.txt"), "outside\n");
}

function makeContext(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return { store: createMockStore(),
  toolName: "regression_tool",
  toolCallId: "call-1",
  input: {},
  step: 0,
  abort: new AbortController().signal,
  startedAt: 0,
  allowedTools: new Set(["regression_tool"]),
  cwd: WORKSPACE,
  storeManager,
    projectContext: createTestProjectContext(WORKSPACE), ...overrides,  };
}

function makeCall(input: unknown = {}): ToolCallLike {
  return {
    toolName: "regression_tool",
    toolCallId: "call-1",
    input,
  };
}

function decisionTool(permission: ToolPermission): ToolDescriptor<{ value?: string }> {
  return defineTool({
    name: "regression_tool",
    description: "Permission regression probe",
    inputSchema: z.object({ value: z.string().optional() }).strict(),
    traits: { readOnly: false, destructive: false, concurrencySafe: false },
    outputPolicy: { kind: "artifact", previewDirection: "head-tail" },
    permissions: [permission],
    execute: async () => createTextToolResult("executed"),
  });
}

function archcodeProtectedTool(): ToolDescriptor<{ path: string; content?: string }> {
  return defineTool({
    name: "regression_tool",
    description: "Protected .archcode mutation regression probe",
    inputSchema: z.object({ path: z.string(), content: z.string().optional() }).strict(),
    traits: { readOnly: false, destructive: false, concurrencySafe: false },
    outputPolicy: { kind: "artifact", previewDirection: "head-tail" },
    permissions: [createProtectedPathPermission()],
    execute: async () => createTextToolResult("executed"),
  });
}

function makeLogger(overrides: Partial<Logger> = {}): Logger {
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => logger,
    ...overrides,
  };
  return logger;
}

async function executeWithConfirmation(
  descriptor: ToolDescriptor,
  input: unknown,
  confirmation: "approve_once" | "approve_always" | "deny",
  manager = new ProjectApprovalManager(silentLogger),
) {
  await manager.load(WORKSPACE);
  const registry = createTestRegistry([descriptor]);
  const ctx = makeContext({
    input,
    projectContext: { ...createTestProjectContext(WORKSPACE), approvals: manager },
  });

  const first = await registry.execute(makeCall(input), ctx);
  const result = first.kind === "blocked"
    ? await registry.resumeBlocked({
      toolCall: makeCall(input),
      request: first.request,
      requestKey: first.requestKey,
      response: { type: "permission_decision", decision: confirmation },
      context: ctx,
    })
    : first;
  return { result: settled(result), request: first.kind === "blocked" ? first.request : undefined, manager, ctx };
}

beforeEach(() => {
  resetWorkspace();
});

afterAll(() => {
  void Promise.all(registryFixtures.map((fixture) => fixture.dispose()));
  rmSync(TMP_DIR, { recursive: true, force: true });
});

describe("permission integration regressions", () => {
  test("Deny cannot be overridden by Allow Always", async () => {
    const { result, request, manager } = await executeWithConfirmation(
      decisionTool(async () => DENY_DECISION),
      {},
      "approve_always",
    );

    expect(result.isError).toBe(true);
    expect(result.details?.error?.code).toBe("TOOL_PERMISSION_DENIED");
    expect(request).toBeUndefined();
    expect(manager.listApprovals()).toEqual([]);
  });

  test("eligible Ask can be approved once and approved always", async () => {
    const once = await executeWithConfirmation(
      decisionTool(async () => ELIGIBLE_ASK),
      {},
      "approve_once",
    );

    expect(once.result.isError).toBe(false);
    expect(once.result.output.preview).toBe("executed");
    expect(once.request?.source.type).toBe("tool_permission");
    expect(once.manager.listApprovals()).toEqual([]);

    const always = await executeWithConfirmation(
      decisionTool(async () => ELIGIBLE_ASK),
      {},
      "approve_always",
    );

    expect(always.result.isError).toBe(false);
    expect(always.manager.listApprovals()).toHaveLength(1);
  });

  test("eligible Ask approved always is persisted and suppresses the next prompt", async () => {
    const manager = new ProjectApprovalManager(silentLogger);

    await executeWithConfirmation(
      decisionTool(async () => ELIGIBLE_ASK),
      {},
      "approve_always",
      manager,
    );

    const registry = createTestRegistry([decisionTool(async () => ELIGIBLE_ASK)]);
    const outcome = await registry.execute(makeCall(), makeContext({
      projectContext: { ...createTestProjectContext(WORKSPACE), approvals: manager },
    }));
    const result = settled(outcome);

    expect(result.isError).toBe(false);
    expect(result.output.preview).toBe("executed");
    expect(outcome.kind).toBe("settled");
  });

  test("ineligible Ask cannot be approved always", async () => {
    const { result, manager, request } = await executeWithConfirmation(
      decisionTool(async () => INELIGIBLE_ASK),
      {},
      "approve_always",
    );

    expect(result.isError).toBe(true);
    expect(result.details?.error?.code).toBe("TOOL_PERMISSION_CONFIRMATION_DENIED");
    expect(manager.listApprovals()).toEqual([]);
    expect(request).toMatchObject({ persistentApprovalEligible: false });
  });

  test("malformed approvals file aborts permission context loading with a typed error", async () => {
    writeFileSync(join(WORKSPACE, ".archcode", "runtime", "permissions.json"), "{ malformed json");
    const warn = mock();
    const manager = new ProjectApprovalManager(makeLogger({ warn }));

    await expect(manager.load(WORKSPACE)).rejects.toBeInstanceOf(ProjectApprovalLoadError);

    expect(warn).not.toHaveBeenCalled();
    expect(manager.listApprovals()).toEqual([]);
  });

  test(".archcode runtime memory mutation is denied through registry file-tool style guard", async () => {
    const { result, request } = await executeWithConfirmation(
      archcodeProtectedTool(),
      { path: ".archcode/runtime/memory/index.md", content: "# hacked" },
      "approve_always",
    );

    expect(result.isError).toBe(true);
    expect(result.details?.error?.code).toBe("PROTECTED_PATH_WRITE_DENIED");
    expect(request).toBeUndefined();
  });
});

describe("workspace permission approval regression", () => {
  test("approved out-of-workspace path is not re-blocked by execute (dual-check bug)", async () => {
    // Regression: tools like file_read, file_edit, file_write had a dual workspace
    // check — once in createWorkspacePermission() and again inside execute().
    // When the user approved the out-of-workspace path through the permission
    // pipeline, execute() would still reject it with TOOL_FILE_OUTSIDE_WORKSPACE.
    // The fix: remove the duplicate check from execute(), letting the permission
    // guard be the sole authority on workspace access.

    const outsideFile = join(OUTSIDE, "approved-file.txt");
    writeFileSync(outsideFile, "approved content");

    const scope: PermissionApprovalScope = {
      kind: "file-path",
      operation: "read",
      path: outsideFile,
      pathMode: "exact",
    };

    const manager = new ProjectApprovalManager(silentLogger);
    await manager.load(WORKSPACE);
    await manager.addApproval(scope, {
      display: `Read ${outsideFile}`,
      reason: "User approved out-of-workspace read",
    });

    // Simulate: workspace guard returns "ask" with scope, but approval already exists.
    // The registry's findFirstUnsatisfiedAsk() should skip it, and execute() should
    // proceed without re-checking the workspace boundary.
    const workspaceAsk: PermissionDecision = {
      outcome: "ask",
      reason: `"${outsideFile}" is outside workspace "${WORKSPACE}" [TOOL_FILE_OUTSIDE_WORKSPACE]`,
      source: "tool-guard",
      ruleId: "tool-file-outside-workspace",
      approval: {
        eligible: true,
        scope,
        display: `Access ${outsideFile}`,
        reason: "Path is outside workspace",
      },
    };

    let executeRan = false;
    const tool = defineTool({
      name: "regression_tool",
      description: "Tests that approved out-of-workspace paths reach execute",
      inputSchema: z.object({ path: z.string() }).strict(),
      traits: { readOnly: true, destructive: false, concurrencySafe: true },
      outputPolicy: { kind: "artifact", previewDirection: "head-tail" },
      permissions: [async () => workspaceAsk],
      execute: async () => {
        executeRan = true;
        return createTextToolResult("executed successfully");
      },
    });

    const registry = createTestRegistry([tool]);
    const first = await registry.execute(
      makeCall({ path: outsideFile }),
      makeContext({
        projectContext: { ...createTestProjectContext(WORKSPACE), approvals: manager },
      }),
    );
    const result = settled(first.kind === "blocked"
      ? await registry.resumeBlocked({
        toolCall: makeCall({ path: outsideFile }),
        request: first.request,
        requestKey: first.requestKey,
        response: { type: "permission_decision", decision: "approve_once" },
        context: makeContext({ projectContext: { ...createTestProjectContext(WORKSPACE), approvals: manager } }),
      })
      : first);

    // Execute should run (not blocked by a duplicate workspace check).
    expect(executeRan).toBe(true);
    expect(result.isError).toBe(false);
    expect(result.output.preview).toBe("executed successfully");
  });
});
