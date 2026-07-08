import { describe, expect, test } from "bun:test";
import type {
  MaybePromise,
  ToolTraits,
  ToolExecutionResult,
  ToolExecutionContext,
  BeforeHook,
  AfterHook,
  ToolDescriptor,
  ToolCallLike,
  ToolConfirmationRequest,
  ToolConfirmationCallback,
  PermissionErrorCode,
  PermissionDecision,
  ToolPermission,
} from "./types";
import { createToolExecutionContext, DuplicateToolError } from "./types";
import { GoalStateManager } from "../goals/state";
import { HitlService } from "../hitl/service";
import { LoopStateManager } from "../loops/state";
import { MemoryFileManager } from "../memory/file-manager";
import type { ProjectContext } from "../projects/types";
import { silentLogger } from "../logger";
import { storeManager } from "../store/store";
import { ProjectApprovalManager } from "./permission";
import { SkillService } from "../skills";

const testSkillService = new SkillService({ builtinSkills: {} });

function makeProjectContext(workspaceRoot: string): ProjectContext {
  return {
    project: { slug: "types-test", name: "Types Test", workspaceRoot, addedAt: new Date().toISOString() },
    goalState: new GoalStateManager(workspaceRoot),
    loopState: new LoopStateManager(workspaceRoot),
    hitl: new HitlService(),
    memory: new MemoryFileManager({ project: `${workspaceRoot}/memory`, user: `${workspaceRoot}/user-memory` }),
    approvals: new ProjectApprovalManager(silentLogger),
  };
}

// ─── DuplicateToolError ───

describe("DuplicateToolError", () => {
  test("has correct name property", () => {
    const error = new DuplicateToolError("read_file");
    expect(error.name).toBe("DuplicateToolError");
  });

  test("includes tool name in message", () => {
    const error = new DuplicateToolError("read_file");
    expect(error.message).toContain("read_file");
    expect(error.message.toLowerCase()).toContain("duplicate");
  });

  test("is instance of Error", () => {
    const error = new DuplicateToolError("bash");
    expect(error).toBeInstanceOf(Error);
  });
});

// ─── Compile-time type assertions ───

test("ToolTraits requires all fields at compile time", () => {
  // @ts-expect-error — missing `readOnly`
  const _bad1: ToolTraits = { destructive: false, concurrencySafe: true };

  // @ts-expect-error — missing `destructive`
  const _bad2: ToolTraits = { readOnly: true, concurrencySafe: false };

  // @ts-expect-error — missing `concurrencySafe`
  const _bad3: ToolTraits = { readOnly: true, destructive: false };

  // Valid — all fields present
  const _good: ToolTraits = {
    readOnly: true,
    destructive: false,
    concurrencySafe: true,
  };

  expect(_good.readOnly).toBe(true);
});

test("ToolExecutionResult has required and optional fields", () => {
  // Minimal valid result
  const minimal: ToolExecutionResult = { output: "ok", isError: false };
  expect(minimal.output).toBe("ok");

  // With optional meta
  const withMeta: ToolExecutionResult = {
    output: "done",
    isError: false,
    meta: { tokens: 42 },
  };
  expect(withMeta.meta?.tokens).toBe(42);
});

test("ToolCallLike shape", () => {
  const call: ToolCallLike = {
    toolCallId: "call_123",
    toolName: "read_file",
    input: { path: "/tmp/a.txt" },
  };
  expect(call.toolCallId).toBe("call_123");
});

test("BeforeHook and AfterHook accept void return", () => {
  const beforeVoid: BeforeHook = (_input, _ctx) => {
    // returns void — means unchanged
  };
  const beforeReplace: BeforeHook = (_input, _ctx) => {
    return { modified: true };
  };
  const afterVoid: AfterHook = (_result, _ctx) => {
    // returns void — means unchanged
  };
  const afterReplace: AfterHook = (result, _ctx) => {
    return { ...result, output: "replaced" };
  };

  expect(beforeVoid).toBeDefined();
  expect(beforeReplace).toBeDefined();
  expect(afterVoid).toBeDefined();
  expect(afterReplace).toBeDefined();
});

test("ToolDescriptor requires all fields", () => {
  // @ts-expect-error — missing `traits`
  const _bad: ToolDescriptor = {
    name: "test",
    description: "A test tool",
    inputSchema: {} as any,
    execute: async (_input, _ctx) => "ok",
  };

  // Valid descriptor
  const _good: ToolDescriptor = {
    name: "test",
    description: "A test tool",
    inputSchema: {} as any,
    traits: { readOnly: true, destructive: false, concurrencySafe: true },
    execute: async (_input, _ctx) => "ok",
  };

  expect(_good.name).toBe("test");
});

// ─── New Permission Types ───

describe("PermissionDecision", () => {
  test("accepts allow outcome", () => {
    const decision: PermissionDecision = { outcome: "allow" };
    expect(decision.outcome).toBe("allow");
  });

  test("accepts deny outcome with reason", () => {
    const decision: PermissionDecision = { outcome: "deny", reason: "not allowed" };
    expect(decision.outcome).toBe("deny");
    expect(decision.reason).toBe("not allowed");
  });

  test("accepts optional structured error kind and code", () => {
    const decision: PermissionDecision = {
      outcome: "deny",
      reason: "outside workspace",
      errorKind: "workspace",
      errorCode: "TOOL_FILE_OUTSIDE_WORKSPACE",
    };
    expect(decision.errorKind).toBe("workspace");
    expect(decision.errorCode).toBe("TOOL_FILE_OUTSIDE_WORKSPACE");
  });

  test("accepts ask outcome without reason", () => {
    const decision: PermissionDecision = { outcome: "ask" };
    expect(decision.outcome).toBe("ask");
    expect(decision.errorKind).toBeUndefined();
    expect(decision.errorCode).toBeUndefined();
  });
});

describe("ToolPermission", () => {
  test("is a function returning MaybePromise<PermissionDecision>", () => {
    const perm: ToolPermission = async (_input, _ctx) => {
      return { outcome: "allow" };
    };
    expect(typeof perm).toBe("function");
  });
});

describe("ToolConfirmationRequest", () => {
  test("has all required fields", () => {
    const request: ToolConfirmationRequest = {
      toolName: "file_write",
      toolCallId: "call_1",
      input: { path: "/tmp/test.txt" },
      description: "Write to /tmp/test.txt",
    };
    expect(request.toolName).toBe("file_write");
    expect(request.toolCallId).toBe("call_1");
    expect(request.description).toBe("Write to /tmp/test.txt");
  });
});

describe("ToolConfirmationCallback", () => {
  test("returns a promise with approval result", async () => {
    const cb: ToolConfirmationCallback = async (_request) => "approve";
    const result = await cb({
      toolName: "test",
      toolCallId: "call_1",
      input: {},
      description: "test",
    });
    expect(result).toBe("approve");
  });
});

describe("PermissionErrorCode", () => {
  test("includes all expected error codes", () => {
    const codes: PermissionErrorCode[] = [
      "TOOL_UNKNOWN",
      "TOOL_NOT_ALLOWED",
      "TOOL_PERMISSION_DENIED",
      "TOOL_PERMISSION_CONFIRMATION_DENIED",
      "TOOL_PERMISSION_CONFIRMATION_TIMEOUT",
      "TOOL_PERMISSION_CONFIRMATION_UNAVAILABLE",
      "TOOL_PERMISSION_CONFIRMATION_FAILED",
      "TOOL_PREPARE_INPUT_FAILED",
    ];
    expect(codes).toHaveLength(8);
    expect(codes).toContain("TOOL_UNKNOWN");
    expect(codes).toContain("TOOL_PREPARE_INPUT_FAILED");
  });
});

// ─── Extended ToolExecutionContext ───

test("ToolExecutionContext accepts allowedTools and workspaceRoot", () => {
  const ctx = createToolExecutionContext({ store: {} as any, storeManager, toolName: "test",
  toolCallId: "call_1",
  input: {},
  step: 1,
  abort: new AbortController().signal,
  agentName: "agent",
  startedAt: Date.now(),
  durationMs: 10,
  allowedTools: new Set(["echo"]),
  agentSkills: ["git-master"],
  skillService: testSkillService,
  projectContext: makeProjectContext("/tmp/workspace"), });
  expect(ctx.allowedTools.has("echo")).toBe(true);
  expect(ctx.agentSkills).toEqual(["git-master"]);
  expect(ctx.skillService).toBe(testSkillService);
  expect(ctx.workspaceRoot).toBe("/tmp/workspace");
});

test("ToolExecutionContext confirmPermission is optional", () => {
  const ctx = createToolExecutionContext({ store: {} as any, storeManager, toolName: "test",
  toolCallId: "call_1",
  input: {},
  step: 1,
  abort: new AbortController().signal,
  startedAt: Date.now(),
  allowedTools: new Set(),
  agentSkills: [],
  skillService: testSkillService,
  projectContext: makeProjectContext("/tmp"), });
  expect(ctx.confirmPermission).toBeUndefined();
});

// ─── Extended ToolDescriptor ───

test("ToolDescriptor accepts prepareInput and permissions", () => {
  const _desc: ToolDescriptor = {
    name: "test",
    description: "A test tool",
    inputSchema: {} as any,
    traits: { readOnly: true, destructive: false, concurrencySafe: true },
    prepareInput: async (raw, _ctx) => raw,
    permissions: [
      async (_input, _ctx) => ({ outcome: "allow" as const }),
    ],
    execute: async (_input, _ctx) => "ok",
  };
  expect(_desc.prepareInput).toBeDefined();
  expect(_desc.permissions).toHaveLength(1);
});

test("ToolDescriptor prepareInput and permissions are optional", () => {
  const _desc: ToolDescriptor = {
    name: "test",
    description: "A test tool",
    inputSchema: {} as any,
    traits: { readOnly: true, destructive: false, concurrencySafe: true },
    execute: async (_input, _ctx) => "ok",
  };
  expect(_desc.prepareInput).toBeUndefined();
  expect(_desc.permissions).toBeUndefined();
});

// ─── Permission API contract (TDD red phase) ───

describe("PermissionDecision", () => {
  test("accepts allow outcome", () => {
    const decision: PermissionDecision = { outcome: "allow" };
    expect(decision.outcome).toBe("allow");
  });

  test("accepts deny outcome with reason", () => {
    const decision: PermissionDecision = { outcome: "deny", reason: "not allowed" };
    expect(decision.outcome).toBe("deny");
    expect(decision.reason).toBe("not allowed");
  });

  test("accepts optional structured error kind and code", () => {
    const decision: PermissionDecision = {
      outcome: "deny",
      reason: "outside workspace",
      errorKind: "workspace",
      errorCode: "TOOL_FILE_OUTSIDE_WORKSPACE",
    };
    expect(decision.errorKind).toBe("workspace");
    expect(decision.errorCode).toBe("TOOL_FILE_OUTSIDE_WORKSPACE");
  });

  test("accepts ask outcome without reason", () => {
    const decision: PermissionDecision = { outcome: "ask" };
    expect(decision.outcome).toBe("ask");
    expect(decision.errorKind).toBeUndefined();
    expect(decision.errorCode).toBeUndefined();
  });

  test("accepts ask outcome with prompt", () => {
    const decision: PermissionDecision = { outcome: "ask", prompt: "Confirm write?" };
    expect(decision.prompt).toBe("Confirm write?");
  });
});

describe("ToolPermission", () => {
  test("is a function returning MaybePromise<PermissionDecision>", () => {
    const perm: ToolPermission = async (_input, _ctx) => {
      return { outcome: "allow" };
    };
    expect(typeof perm).toBe("function");
  });

  test("can return sync PermissionDecision", () => {
    const perm: ToolPermission = (_input, _ctx) => {
      return { outcome: "deny", reason: "blocked" };
    };
    expect(typeof perm).toBe("function");
  });
});



describe("ToolDescriptor — permissions field", () => {
  test("ToolDescriptor accepts permissions array", () => {
    const _desc: ToolDescriptor = {
      name: "test",
      description: "A test tool",
      inputSchema: {} as any,
      traits: { readOnly: true, destructive: false, concurrencySafe: true },
      permissions: [
        async (_input, _ctx) => ({ outcome: "allow" as const }),
      ],
      execute: async (_input, _ctx) => "ok",
    };
    expect(_desc.permissions).toHaveLength(1);
  });

  test("ToolDescriptor permissions are optional", () => {
    const _desc: ToolDescriptor = {
      name: "test",
      description: "A test tool",
      inputSchema: {} as any,
      traits: { readOnly: true, destructive: false, concurrencySafe: true },
      execute: async (_input, _ctx) => "ok",
    };
    expect(_desc.permissions).toBeUndefined();
  });


});

describe("ToolExecutionContext — permissionOutcome preserved", () => {
  test("permissionOutcome receives allow/deny/ask from permission decisions", () => {
    const ctx = createToolExecutionContext({ store: {} as any, storeManager, toolName: "test",
    toolCallId: "call_1",
    input: {},
    step: 1,
    abort: new AbortController().signal,
    startedAt: Date.now(),
    allowedTools: new Set(),
    agentSkills: [],
    skillService: testSkillService,
    projectContext: makeProjectContext("/tmp"),
    permissionOutcome: "allow", });
    expect(ctx.permissionOutcome).toBe("allow");

    const ctx2: ToolExecutionContext = {
      ...ctx,
      permissionOutcome: "deny",
    };
    expect(ctx2.permissionOutcome).toBe("deny");

    const ctx3: ToolExecutionContext = {
      ...ctx,
      permissionOutcome: "ask",
    };
    expect(ctx3.permissionOutcome).toBe("ask");
  });

  test("permissionOutcome is optional", () => {
    const ctx = createToolExecutionContext({ store: {} as any, storeManager, toolName: "test",
    toolCallId: "call_1",
    input: {},
    step: 1,
    abort: new AbortController().signal,
    startedAt: Date.now(),
    allowedTools: new Set(),
    agentSkills: [],
    skillService: testSkillService,
    projectContext: makeProjectContext("/tmp"), });
    expect(ctx.permissionOutcome).toBeUndefined();
  });
});
