import { describe, expect, test } from "bun:test";
import type {
  MaybePromise,
  ToolTraits,
  RawToolResult,
  ToolExecutionContext,
  BeforeHook,
  AfterHook,
  ToolDescriptor,
  ToolCallLike,
  PermissionErrorCode,
  PermissionDecision,
  ToolPermission,
} from "./types";
import { createToolExecutionContext, DuplicateToolError } from "./types";
import { createTextToolResult } from "./results";
import type { ProjectContext } from "../projects/types";
import { storeManager } from "../store/store";
import { SkillService } from "../skills";
import { createTestProjectContext } from "./test-project-context";

const testSkillService = new SkillService({ builtinSkills: {} });

function makeProjectContext(workspaceRoot: string): ProjectContext {
  return {
    ...createTestProjectContext(workspaceRoot),
    project: { slug: "types-test", name: "Types Test", workspaceRoot, addedAt: new Date().toISOString() },
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

test("RawToolResult has a strict draft and details boundary", () => {
  const minimal: RawToolResult = createTextToolResult("ok");
  expect(minimal.draft).toEqual({ kind: "text", text: "ok" });

  const withDetails: RawToolResult = createTextToolResult("done", {
    details: { process: { exitCode: 0, signal: null, timedOut: false, aborted: false, durationMs: 42 } },
  });
  expect(withDetails.details?.process?.durationMs).toBe(42);
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
    return createTextToolResult("replaced", { isError: result.isError, details: result.details });
  };

  expect(beforeVoid).toBeDefined();
  expect(beforeReplace).toBeDefined();
  expect(afterVoid).toBeDefined();
  expect(afterReplace).toBeDefined();
});

test("ToolDescriptor requires all fields", () => {
  // @ts-expect-error — missing `traits` and `outputPolicy`
  const _bad: ToolDescriptor = {
    name: "test",
    description: "A test tool",
    inputSchema: {} as any,
    execute: async (_input, _ctx) => createTextToolResult("ok"),
  };

  // Valid descriptor
  const _good: ToolDescriptor = {
    name: "test",
    description: "A test tool",
    inputSchema: {} as any,
    traits: { readOnly: true, destructive: false, concurrencySafe: true },
    outputPolicy: { kind: "artifact", previewDirection: "head-tail" },
    execute: async (_input, _ctx) => createTextToolResult("ok"),
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

test("ToolExecutionContext accepts allowedTools and cwd", () => {
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
  projectContext: makeProjectContext("/tmp/workspace"),
  cwd: "/tmp/workspace", });
  expect(ctx.allowedTools.has("echo")).toBe(true);
  expect(ctx.agentSkills).toEqual(["git-master"]);
  expect(ctx.skillService).toBe(testSkillService);
  expect(ctx.cwd).toBe("/tmp/workspace");
});

// ─── Extended ToolDescriptor ───

test("ToolDescriptor accepts prepareInput and permissions", () => {
  const _desc: ToolDescriptor = {
    name: "test",
    description: "A test tool",
    inputSchema: {} as any,
    traits: { readOnly: true, destructive: false, concurrencySafe: true },
    outputPolicy: { kind: "artifact", previewDirection: "head-tail" },
    prepareInput: async (raw, _ctx) => raw,
    permissions: [
      async (_input, _ctx) => ({ outcome: "allow" as const }),
    ],
    execute: async (_input, _ctx) => createTextToolResult("ok"),
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
    outputPolicy: { kind: "artifact", previewDirection: "head-tail" },
    execute: async (_input, _ctx) => createTextToolResult("ok"),
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
      outputPolicy: { kind: "artifact", previewDirection: "head-tail" },
      permissions: [
        async (_input, _ctx) => ({ outcome: "allow" as const }),
      ],
      execute: async (_input, _ctx) => createTextToolResult("ok"),
    };
    expect(_desc.permissions).toHaveLength(1);
  });

  test("ToolDescriptor permissions are optional", () => {
    const _desc: ToolDescriptor = {
      name: "test",
      description: "A test tool",
      inputSchema: {} as any,
      traits: { readOnly: true, destructive: false, concurrencySafe: true },
      outputPolicy: { kind: "artifact", previewDirection: "head-tail" },
      execute: async (_input, _ctx) => createTextToolResult("ok"),
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
    cwd: "/tmp",
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
    projectContext: makeProjectContext("/tmp"),
    cwd: "/tmp", });
    expect(ctx.permissionOutcome).toBeUndefined();
  });
});
