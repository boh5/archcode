import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { silentLogger, type Logger } from "../../logger";
import { storeManager } from "../../store/store";
import { defineTool } from "../define-tool";
import { TOOL_ERROR_META_KEY } from "../errors";
import { createRegistry } from "../registry";
import { classifyCommand } from "../security/bash-classifier";
import type {
  PermissionDecision,
  ToolCallLike,
  ToolConfirmationRequest,
  ToolConfirmationResult,
  ToolDescriptor,
  ToolExecutionContext,
  ToolPermission,
} from "../types";
import { createBashPermission } from "./bash";
import { createProtectedPathPermission } from "./protected-path";
import { ProjectApprovalLoadError, ProjectApprovalManager } from "./project-approvals";
import type { PermissionApprovalScope } from "./policy-types";
import { createTestProjectContext } from "../test-project-context";
import { createMockStore } from "../../store/test-helpers";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "permission-regression", crypto.randomUUID());
const WORKSPACE = join(TMP_DIR, "workspace");
const OUTSIDE = join(TMP_DIR, "outside");

const ELIGIBLE_SCOPE: PermissionApprovalScope = {
  kind: "bash-exact",
  normalized: "rm -rf tmp/cache",
  effects: ["delete"],
};

const INELIGIBLE_ASK: PermissionDecision = {
  outcome: "ask",
  reason: "Parser uncertainty requires confirmation",
  prompt: "Review parser-uncertain command",
  source: "builtin-policy",
  ruleId: "ask-parser-uncertainty",
  display: "echo $(whoami)",
  approval: {
    eligible: false,
    display: "echo $(whoami)",
    reason: "Parser uncertainty requires confirmation",
  },
};

function resolveIneligibleApprovalShortcut(input: string): ToolConfirmationResult {
  return input === "1" || input === "o" || input === "y" || input === "Y"
    ? "approve_once"
    : "deny";
}

const ELIGIBLE_ASK: PermissionDecision = {
  outcome: "ask",
  reason: "Destructive local command requires confirmation",
  prompt: "Review destructive local command",
  source: "builtin-policy",
  ruleId: "ask-destructive-local",
  display: "rm -rf tmp/cache",
  approval: {
    eligible: true,
    scope: ELIGIBLE_SCOPE,
    display: "rm -rf tmp/cache",
    reason: "Destructive local command requires confirmation",
  },
};

const DENY_DECISION: PermissionDecision = {
  outcome: "deny",
  reason: "Hard deny wins",
  source: "builtin-policy",
  ruleId: "deny-regression",
};

function resetWorkspace(): void {
  rmSync(TMP_DIR, { recursive: true, force: true });
  mkdirSync(join(WORKSPACE, "src"), { recursive: true });
  mkdirSync(join(WORKSPACE, ".archcode", "memory"), { recursive: true });
  mkdirSync(OUTSIDE, { recursive: true });
  writeFileSync(join(WORKSPACE, "src", "main.ts"), "export const value = 1;\n");
  writeFileSync(join(WORKSPACE, ".archcode", "permissions.json"), '{"approvals":[]}\n');
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
    permissions: [permission],
    execute: async () => "executed",
  });
}

function bashTool(): ToolDescriptor<{ command: string; cwd?: string }> {
  return defineTool({
    name: "regression_tool",
    description: "Bash permission regression probe",
    inputSchema: z.object({ command: z.string(), cwd: z.string().optional() }).strict(),
    traits: { readOnly: false, destructive: true, concurrencySafe: false },
    permissions: [createBashPermission()],
    execute: async () => "executed",
  });
}

function archcodeProtectedTool(): ToolDescriptor<{ path: string; content?: string }> {
  return defineTool({
    name: "regression_tool",
    description: "Protected .archcode mutation regression probe",
    inputSchema: z.object({ path: z.string(), content: z.string().optional() }).strict(),
    traits: { readOnly: false, destructive: false, concurrencySafe: false },
    permissions: [createProtectedPathPermission()],
    execute: async () => "executed",
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
  confirmation: ToolConfirmationResult,
  manager = new ProjectApprovalManager(silentLogger),
) {
  await manager.load(WORKSPACE);
  const confirmPermission = mock(async (_request: ToolConfirmationRequest) => confirmation);
  const registry = createRegistry([descriptor]);
  const ctx = makeContext({
    input,
    projectContext: { ...createTestProjectContext(WORKSPACE), approvals: manager },
    confirmPermission,
  });

  const result = await registry.execute(makeCall(input), ctx);
  return { result, confirmPermission, manager, ctx };
}

function classify(command: string) {
  return classifyCommand(command, { workspaceRoot: WORKSPACE });
}

beforeEach(() => {
  resetWorkspace();
});

afterAll(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

describe("permission integration regressions", () => {
  test("Deny cannot be overridden by Allow Always", async () => {
    const { result, confirmPermission, manager } = await executeWithConfirmation(
      decisionTool(async () => DENY_DECISION),
      {},
      "approve_always",
    );

    expect(result.isError).toBe(true);
    expect(result.meta?.permissionErrorCode).toBe("TOOL_PERMISSION_DENIED");
    expect(result.meta?.skippedExecution).toBe(true);
    expect(confirmPermission).not.toHaveBeenCalled();
    expect(manager.listApprovals()).toEqual([]);
  });

  test("eligible Ask can be approved once and approved always", async () => {
    const once = await executeWithConfirmation(
      decisionTool(async () => ELIGIBLE_ASK),
      {},
      "approve_once",
    );

    expect(once.result.isError).toBe(false);
    expect(once.result.output).toBe("executed");
    expect(once.confirmPermission).toHaveBeenCalledTimes(1);
    expect(once.manager.listApprovals()).toEqual([]);

    const always = await executeWithConfirmation(
      decisionTool(async () => ELIGIBLE_ASK),
      {},
      "approve_always",
    );

    expect(always.result.isError).toBe(false);
    expect(always.manager.hasApproval(ELIGIBLE_SCOPE)).toBe(true);
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

    const confirmPermission = mock(async () => "deny" as ToolConfirmationResult);
    const registry = createRegistry([decisionTool(async () => ELIGIBLE_ASK)]);
    const result = await registry.execute(makeCall(), makeContext({
      confirmPermission,
      projectContext: { ...createTestProjectContext(WORKSPACE), approvals: manager },
    }));

    expect(result.isError).toBe(false);
    expect(result.output).toBe("executed");
    expect(confirmPermission).not.toHaveBeenCalled();
  });

  test("ineligible Ask cannot be approved always", async () => {
    const { result, manager, confirmPermission } = await executeWithConfirmation(
      decisionTool(async () => INELIGIBLE_ASK),
      {},
      "approve_always",
    );

    expect(result.isError).toBe(false);
    expect(confirmPermission).toHaveBeenCalledTimes(1);
    expect(manager.listApprovals()).toEqual([]);
    const request = confirmPermission.mock.calls[0]?.[0];
    expect(request?.approval?.eligible).toBe(false);
      expect(request.approval?.eligible).toBe(false);
      expect(resolveIneligibleApprovalShortcut("2")).toBe("deny");
      expect(resolveIneligibleApprovalShortcut("a")).toBe("deny");
  });

  test("malformed approvals file aborts permission context loading with a typed error", async () => {
    writeFileSync(join(WORKSPACE, ".archcode", "permissions.json"), "{ malformed json");
    const warn = mock();
    const manager = new ProjectApprovalManager(makeLogger({ warn }));

    await expect(manager.load(WORKSPACE)).rejects.toBeInstanceOf(ProjectApprovalLoadError);

    expect(warn).not.toHaveBeenCalled();
    expect(manager.listApprovals()).toEqual([]);
  });

  test(".archcode direct mutation is denied through registry file-tool style guard", async () => {
    const { result, confirmPermission } = await executeWithConfirmation(
      archcodeProtectedTool(),
      { path: ".archcode/memory/index.md", content: "# hacked" },
      "approve_always",
    );

    expect(result.isError).toBe(true);
    expect(result.meta?.permissionErrorCode).toBe("PROTECTED_PATH_WRITE_DENIED");
    expect(result.meta?.[TOOL_ERROR_META_KEY]).toBeDefined();
    expect(confirmPermission).not.toHaveBeenCalled();
  });
});

describe("bash permission bypass regressions", () => {
  test("opaque interpreter execution cannot bypass worktree policy or persist approval", async () => {
    const command = `python -c 'import subprocess; subprocess.run(["git", "work" + "tree", "remove", "../feature"])'`;
    const decision = classify(command);
    expect(decision).toMatchObject({
      outcome: "ask",
      ruleId: "ask-opaque-interpreter-execution",
      approval: { eligible: false },
    });
    expect(decision.approval?.scope).toBeUndefined();

    const manager = new ProjectApprovalManager(silentLogger);
    const first = await executeWithConfirmation(
      bashTool(),
      { command },
      "approve_always",
      manager,
    );
    expect(first.result.isError).toBe(false);
    expect(first.confirmPermission).toHaveBeenCalledTimes(1);
    expect(first.confirmPermission.mock.calls[0]?.[0]?.approval?.eligible).toBe(false);
    expect(manager.listApprovals()).toEqual([]);

    const second = await executeWithConfirmation(
      bashTool(),
      { command },
      "approve_once",
      manager,
    );
    expect(second.result.isError).toBe(false);
    expect(second.confirmPermission).toHaveBeenCalledTimes(1);
    expect(manager.listApprovals()).toEqual([]);
  });

  test("direct worktree deny still wins over opaque interpreter confirmation", () => {
    const decision = classify(
      `node -e 'console.log("opaque")' && git worktree remove ../feature`,
    );

    expect(decision).toMatchObject({
      outcome: "deny",
      ruleId: "deny-direct-worktree-command",
    });
    expect(decision.approval).toBeUndefined();
  });

  test(".archcode direct mutation and explicit permissions file reads are denied", async () => {
    for (const command of [
      "rm -rf .archcode/",
      "mkdir .archcode/tmp",
      "echo hacked > .archcode/memory/index.md",
      "cat .archcode/permissions.json",
      "cat ./.archcode/permissions.json",
      "python3 -c \"import shutil; shutil.rmtree('.archcode')\"",
      "python3 -c \"open('.archcode','w')\"",
      `python3 -c "import shutil; shutil.rmtree('${join(WORKSPACE, ".archcode")}')"`,
    ]) {
      const decision = classify(command);
      expect(decision.outcome, command).toBe("deny");
    }
  });

  test("bash registry integration denies inline .archcode directory mutation", async () => {
    const { result, confirmPermission } = await executeWithConfirmation(
      bashTool(),
      { command: "python3 -c \"import shutil; shutil.rmtree('.archcode')\"" },
      "approve_always",
    );

    expect(result.isError).toBe(true);
    expect(result.meta?.permissionErrorCode).toBe("TOOL_PERMISSION_DENIED");
    expect(confirmPermission).not.toHaveBeenCalled();
  });

  test("bash registry integration denies explicit .archcode/permissions.json mention including read", async () => {
    const { result, confirmPermission } = await executeWithConfirmation(
      bashTool(),
      { command: "cat .archcode/permissions.json" },
      "approve_always",
    );

    expect(result.isError).toBe(true);
    expect(result.meta?.permissionErrorCode).toBe("TOOL_PERMISSION_DENIED");
    expect(confirmPermission).not.toHaveBeenCalled();
  });

  test("broad-prefix command approvals cannot allow redirection to home dotfiles", async () => {
    const broadCargoScope: PermissionApprovalScope = {
      kind: "bash-command",
      command: "cargo",
      subcommands: [],
      argumentMode: "any",
      effects: ["execute-code"],
    };
    const manager = new ProjectApprovalManager(silentLogger);
    await manager.load(WORKSPACE);
    await manager.addApproval(broadCargoScope, {
      display: "cargo *",
      reason: "Pre-existing broad command approval must not satisfy risky exact command",
    });

    const requests: ToolConfirmationRequest[] = [];
    const confirmPermission = mock(async (request: ToolConfirmationRequest) => {
      requests.push(request);
      return "deny" as ToolConfirmationResult;
    });
    const registry = createRegistry([bashTool()]);
    const result = await registry.execute(
      makeCall({ command: "cargo check > ~/.zshrc" }),
      makeContext({
        input: { command: "cargo check > ~/.zshrc" },
        confirmPermission,
        projectContext: { ...createTestProjectContext(WORKSPACE), approvals: manager },
      }),
    );

    expect(result.isError).toBe(true);
    expect(result.meta?.permissionErrorCode).toBe("TOOL_PERMISSION_CONFIRMATION_DENIED");
    expect(confirmPermission).toHaveBeenCalledTimes(1);
    const request = requests[0];
    expect(request).toBeDefined();
    expect(request?.ruleId).toBeDefined();
    expect(request?.approval?.scope).not.toEqual(broadCargoScope);
    expect(["ask-out-of-workspace-path-access", "ask-write-redirection"]).toContain(request!.ruleId!);
  });

  test("kill -9 cannot be reduced to a safe prefix by token extraction", () => {
    const decision = classify("kill -9 44165");

    expect(decision.outcome).toBe("ask");
    expect(decision.approval?.eligible).toBe(true);
    expect(decision.approval?.scope).toMatchObject({
      kind: "bash-exact",
      normalized: "kill -9 44165",
    });
    expect(decision.approval?.scope).not.toMatchObject({
      kind: "bash-command",
      command: "kill",
      argumentMode: "any",
    });
  });

  test("compound commands apply Deny and Ask across all segments", () => {
    expect(classify("pwd && sudo echo hi").outcome).toBe("deny");

    const askDecision = classify("git status && echo x > out.txt");
    expect(askDecision.outcome).toBe("ask");
    expect(askDecision.ruleId).toBe("ask-write-redirection");
  });

  test('bash -c "sudo echo hi" recursively denies or asks but never allows', () => {
    const decision = classify('bash -c "sudo echo hi"');

    expect(decision.outcome).not.toBe("allow");
    expect(["deny", "ask"]).toContain(decision.outcome);
  });

  test("ordinary commands remain low-friction", () => {
    for (const command of [
      "bun add express",
      'git commit -m "msg"',
      "curl https://example.com",
    ]) {
      expect(classify(command).outcome, command).toBe("allow");
    }
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
      permissions: [async () => workspaceAsk],
      execute: async () => {
        executeRan = true;
        return "executed successfully";
      },
    });

    const registry = createRegistry([tool]);
    const confimPermission = mock(async () => "deny" as ToolConfirmationResult);
    const result = await registry.execute(
      makeCall({ path: outsideFile }),
      makeContext({
        projectContext: { ...createTestProjectContext(WORKSPACE), approvals: manager },
        confirmPermission: confimPermission,
      }),
    );

    // The pre-existing approval should satisfy the "ask" without prompting.
    expect(confimPermission).not.toHaveBeenCalled();
    // Execute should run (not blocked by a duplicate workspace check).
    expect(executeRan).toBe(true);
    expect(result.isError).toBe(false);
    expect(result.output).toBe("executed successfully");
  });
});
