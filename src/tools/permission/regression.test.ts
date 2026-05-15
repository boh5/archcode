import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { createSessionStore } from "../../store/store";
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
import { handleConfirmationInput } from "../../tui/UserInput";
import { createBashPermission } from "./bash";
import { createProtectedSpecraPermission } from "./protected-specra";
import { ProjectApprovalManager } from "./project-approvals";
import type { PermissionApprovalScope } from "./policy-types";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "permission-regression");
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
  mkdirSync(join(WORKSPACE, ".specra", "memory"), { recursive: true });
  mkdirSync(OUTSIDE, { recursive: true });
  writeFileSync(join(WORKSPACE, "src", "main.ts"), "export const value = 1;\n");
  writeFileSync(join(WORKSPACE, ".specra", "permissions.json"), "{}\n");
  writeFileSync(join(OUTSIDE, "outside.txt"), "outside\n");
}

function makeContext(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    store: createSessionStore(crypto.randomUUID()),
    toolName: "regression_tool",
    toolCallId: "call-1",
    input: {},
    step: 0,
    abort: new AbortController().signal,
    startedAt: 0,
    allowedTools: new Set(["regression_tool"]),
    workspaceRoot: WORKSPACE,
    ...overrides,
  };
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
    permissions: [createBashPermission(WORKSPACE)],
    execute: async () => "executed",
  });
}

function specraProtectedTool(): ToolDescriptor<{ path: string; content?: string }> {
  return defineTool({
    name: "regression_tool",
    description: "Protected .specra mutation regression probe",
    inputSchema: z.object({ path: z.string(), content: z.string().optional() }).strict(),
    traits: { readOnly: false, destructive: false, concurrencySafe: false },
    permissions: [createProtectedSpecraPermission()],
    execute: async () => "executed",
  });
}

async function executeWithConfirmation(
  descriptor: ToolDescriptor,
  input: unknown,
  confirmation: ToolConfirmationResult,
  manager = new ProjectApprovalManager({ warn: mock() }),
) {
  const confirmPermission = mock(async (_request: ToolConfirmationRequest) => confirmation);
  const registry = createRegistry([descriptor], undefined, manager);
  const ctx = makeContext({
    input,
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
    const manager = new ProjectApprovalManager({ warn: mock() });

    await executeWithConfirmation(
      decisionTool(async () => ELIGIBLE_ASK),
      {},
      "approve_always",
      manager,
    );

    const confirmPermission = mock(async () => "deny" as ToolConfirmationResult);
    const registry = createRegistry([decisionTool(async () => ELIGIBLE_ASK)], undefined, manager);
    const result = await registry.execute(makeCall(), makeContext({ confirmPermission }));

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
    expect(handleConfirmationInput("2", { escape: false }, request)).toBe("deny");
    expect(handleConfirmationInput("a", { escape: false }, request)).toBe("deny");
  });

  test("malformed approvals file is safe and does not satisfy eligible Ask", async () => {
    writeFileSync(join(WORKSPACE, ".specra", "permissions.json"), "{ malformed json");
    const warn = mock();
    const manager = new ProjectApprovalManager({ warn });
    const confirmPermission = mock(async () => "approve_once" as ToolConfirmationResult);
    const registry = createRegistry([decisionTool(async () => ELIGIBLE_ASK)], undefined, manager);

    const result = await registry.execute(makeCall(), makeContext({ confirmPermission }));

    expect(result.isError).toBe(false);
    expect(confirmPermission).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(manager.listApprovals()).toEqual([]);
  });

  test(".specra direct mutation is denied through registry file-tool style guard", async () => {
    const { result, confirmPermission } = await executeWithConfirmation(
      specraProtectedTool(),
      { path: ".specra/memory/index.md", content: "# hacked" },
      "approve_always",
    );

    expect(result.isError).toBe(true);
    expect(result.meta?.permissionErrorCode).toBe("SPECRA_PROTECTED_PATH_WRITE_DENIED");
    expect(result.meta?.[TOOL_ERROR_META_KEY]).toBeDefined();
    expect(confirmPermission).not.toHaveBeenCalled();
  });
});

describe("bash permission bypass regressions", () => {
  test(".specra direct mutation and explicit permissions file reads are denied", async () => {
    for (const command of [
      "rm -rf .specra/",
      "mkdir .specra/tmp",
      "echo hacked > .specra/memory/index.md",
      "cat .specra/permissions.json",
      "cat ./.specra/permissions.json",
    ]) {
      const decision = classify(command);
      expect(decision.outcome, command).toBe("deny");
    }
  });

  test("bash registry integration denies explicit .specra/permissions.json mention including read", async () => {
    const { result, confirmPermission } = await executeWithConfirmation(
      bashTool(),
      { command: "cat .specra/permissions.json" },
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
    const manager = new ProjectApprovalManager({ warn: mock() });
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
    const registry = createRegistry([bashTool()], undefined, manager);
    const result = await registry.execute(
      makeCall({ command: "cargo check > ~/.zshrc" }),
      makeContext({ input: { command: "cargo check > ~/.zshrc" }, confirmPermission }),
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
