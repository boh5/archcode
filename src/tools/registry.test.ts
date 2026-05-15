import { describe, expect, test, beforeEach, afterAll, mock } from "bun:test";
import { join } from "node:path";
import { rmSync } from "node:fs";

import { z } from "zod";
import { createRegistry } from "./registry";
import type { ToolRegistry } from "./registry";
import { ResolvedToolSet } from "./registry";
import type {
  ToolDescriptor,
  Logger,
  ToolExecutionContext,
  ToolCallLike,
  ToolPermission,
} from "./types";
import { DuplicateToolError } from "./types";
import { DestructiveToolPermissionError } from "./types";
import { createExecutionLogger } from "./hooks/logger";
import { createAuditHook, type AuditEvent } from "./hooks/audit";
import { REDACTION_MARKER } from "./security/redaction";
import { createRedactionHook } from "./hooks/redact";
import { createOutputTruncator } from "./hooks/truncate";
import { TOOL_ERROR_META_KEY } from "./errors";
import { ProjectApprovalManager } from "./permission";
import type { PermissionApprovalScope } from "./permission";
import { jsonSchema } from "ai";


// ─── Test helpers ───

function makeDescriptor(name: string): ToolDescriptor {
  return {
    name,
    description: `Tool: ${name}`,
    inputSchema: z.object({ msg: z.string() }).strict(),
    traits: {
      readOnly: true,
      destructive: false,
      concurrencySafe: true,
    },
    async execute(input, _ctx) {
      return `echo: ${(input as { msg: string }).msg}`;
    },
  };
}

function makeLogger(): Logger & { warn: ReturnType<typeof mock> } {
  return {
    warn: mock((_message: string, _meta?: Record<string, unknown>) => {}),
    debug: mock(() => {}),
    info: mock(() => {}),
  };
}

// ─── ToolRegistry ───

describe("ToolRegistry", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = createRegistry();
  });

  describe("register()", () => {
    test("registers a single tool and retrieves it by name", () => {
      const desc = makeDescriptor("echo");
      registry.register(desc);

      expect(registry.get("echo")).toBe(desc);
    });

    test("throws DuplicateToolError for duplicate name", () => {
      registry.register(makeDescriptor("echo"));

      expect(() => registry.register(makeDescriptor("echo"))).toThrow(
        DuplicateToolError,
      );
    });

    test("throws DestructiveToolPermissionError for destructive tool with no permissions", () => {
      const desc: ToolDescriptor = {
        name: "nuke",
        description: "Nukes everything",
        inputSchema: z.object({}).strict(),
        traits: { readOnly: false, destructive: true, concurrencySafe: false },
        async execute() {
          return "nuked";
        },
      };

      expect(() => registry.register(desc)).toThrow(DestructiveToolPermissionError);
      expect(() => registry.register(desc)).toThrow(/nuke/);
    });

    test("throws DestructiveToolPermissionError for destructive tool with empty permissions array", () => {
      const desc: ToolDescriptor = {
        name: "nuke",
        description: "Nukes everything",
        inputSchema: z.object({}).strict(),
        traits: { readOnly: false, destructive: true, concurrencySafe: false },
        permissions: [],
        async execute() {
          return "nuked";
        },
      };

      expect(() => registry.register(desc)).toThrow(DestructiveToolPermissionError);
    });

    test("allows destructive tool with at least one permission", () => {
      const perm: ToolPermission = async () => ({ outcome: "allow" });
      const desc: ToolDescriptor = {
        name: "bash",
        description: "Run bash",
        inputSchema: z.object({}).strict(),
        traits: { readOnly: false, destructive: true, concurrencySafe: false },
        permissions: [perm],
        async execute() {
          return "ok";
        },
      };

      expect(() => registry.register(desc)).not.toThrow();
      expect(registry.get("bash")).toBe(desc);
    });

    test("allows non-destructive tool with no permissions", () => {
      const desc: ToolDescriptor = {
        name: "read",
        description: "Read-only tool",
        inputSchema: z.object({}).strict(),
        traits: { readOnly: true, destructive: false, concurrencySafe: true },
        async execute() {
          return "ok";
        },
      };

      expect(() => registry.register(desc)).not.toThrow();
      expect(registry.get("read")).toBe(desc);
    });

    test("allows non-destructive tool with empty permissions array", () => {
      const desc: ToolDescriptor = {
        name: "read",
        description: "Read-only tool",
        inputSchema: z.object({}).strict(),
        traits: { readOnly: true, destructive: false, concurrencySafe: true },
        permissions: [],
        async execute() {
          return "ok";
        },
      };

      expect(() => registry.register(desc)).not.toThrow();
    });
  });

  describe("registerAll()", () => {
    test("registers multiple tools at once", () => {
const descs = [makeDescriptor("echo"), makeDescriptor("read"), makeDescriptor("write")];

      registry.registerAll(descs);

      expect(registry.get("echo")).toBe(descs[0]);
      expect(registry.get("read")).toBe(descs[1]);
      expect(registry.get("write")).toBe(descs[2]);
    });

    test("throws on first duplicate", () => {
      registry.register(makeDescriptor("echo"));

      expect(() =>
        registry.registerAll([makeDescriptor("read"), makeDescriptor("echo")]),
      ).toThrow(DuplicateToolError);
    });
  });

  describe("get()", () => {
    test("returns undefined for unknown name", () => {
      expect(registry.get("nonexistent")).toBeUndefined();
    });
  });

  describe("getAll()", () => {
    test("returns all registered descriptors", () => {
      const descs = [makeDescriptor("a"), makeDescriptor("b")];
      registry.registerAll(descs);

      const all = registry.getAll();

      expect(all).toHaveLength(2);
      expect(all).toContain(descs[0]);
      expect(all).toContain(descs[1]);
    });

    test("returns empty array when nothing registered", () => {
      expect(registry.getAll()).toEqual([]);
    });
  });

  describe("globalHooks", () => {
    test("initializes to empty arrays", () => {
      expect(registry.globalHooks.before).toEqual([]);
      expect(registry.globalHooks.after).toEqual([]);
      expect(registry.globalPermissions).toEqual([]);
    });
  });

  // ─── execute() ───

  function makeContext(
    overrides?: Partial<ToolExecutionContext>,
  ): ToolExecutionContext {
    const ac = new AbortController();
    return {
      store: { getState: () => ({ sessionId: "test-session" }) } as ToolExecutionContext["store"],
      toolName: "echo",
      toolCallId: "call-1",
      input: { msg: "hello" },
      step: 0,
      abort: ac.signal,
      startedAt: 0,
      allowedTools: new Set(["echo"]),
      workspaceRoot: "/tmp",
      ...overrides,
    };
  }

  function makeToolCall(
    overrides?: Partial<ToolCallLike>,
  ): ToolCallLike {
    return {
      toolCallId: "call-1",
      toolName: "echo",
      input: { msg: "hello" },
      ...overrides,
    };
  }

  describe("execute()", () => {
    function makeSpiedDescriptor(name: string): ToolDescriptor & { execute: ReturnType<typeof mock> } {
      return {
        ...makeDescriptor(name),
        execute: mock(async (input: unknown) => `echo: ${(input as { msg: string }).msg}`),
      };
    }

    // 1. Unknown tool returns error result (no throw)
    test("unknown tool returns error result, no throw", async () => {
      const ctx = makeContext({ toolName: "missing" });
      const call = makeToolCall({ toolName: "missing" });

      const result = await registry.execute(call, ctx);

      expect(result.isError).toBe(true);
      expect(result.output).toContain("missing");
      expect(result.output).toContain("not registered");
      expect(result.meta?.[TOOL_ERROR_META_KEY]).toBeDefined();
      expect(result.meta?.permissionErrorCode).toBe("TOOL_UNKNOWN");
      expect(result.meta?.skippedExecution).toBe(true);
    });

    test("unknown tool returns TOOL_UNKNOWN even when explicitly allowed", async () => {
      registry.register(makeSpiedDescriptor("safeTool"));
      const ctx = makeContext({
        toolName: "missingTool",
        allowedTools: new Set(["safeTool", "missingTool"]),
      });
      const call = makeToolCall({ toolName: "missingTool" });

      const result = await registry.execute(call, ctx);

      expect(result.isError).toBe(true);
      expect(result.meta?.permissionErrorCode).toBe("TOOL_UNKNOWN");
      expect(result.meta?.skippedExecution).toBe(true);
    });

    // 2. Invalid input returns error result (no throw)
    test("invalid input returns error result, no throw", async () => {
      registry.register(makeDescriptor("echo"));
      const ctx = makeContext();
      const call = makeToolCall({ input: { bad: 123 } });

      const result = await registry.execute(call, ctx);

      expect(result.isError).toBe(true);
      expect(result.output).toContain("invalid_type");
      expect(result.output).toContain("TOOL_SCHEMA_INVALID_INPUT");
    });

    // 3. Successful execution
    test("successful execution returns output with isError false", async () => {
      registry.register(makeDescriptor("echo"));
      const ctx = makeContext();
      const call = makeToolCall({ input: { msg: "world" } });

      const result = await registry.execute(call, ctx);

      expect(result.isError).toBe(false);
      expect(result.output).toBe("echo: world");
    });

    // 4. Executor throw becomes error result
    test("executor throw becomes error result", async () => {
      const desc: ToolDescriptor = {
        name: "crash",
        description: "always crashes",
        inputSchema: z.object({}).strict(),
        traits: { readOnly: true, destructive: false, concurrencySafe: true },
        async execute() {
          throw new Error("BOOM");
        },
      };
      registry.register(desc);
      const ctx = makeContext({ toolName: "crash", allowedTools: new Set(["crash"]) });
      const call = makeToolCall({ toolName: "crash", input: {} });

      const result = await registry.execute(call, ctx);

      expect(result.isError).toBe(true);
      const output = JSON.parse(result.output) as Record<string, unknown>;
      expect(output.message).toBe("BOOM");
      expect(output.code).toBe("TOOL_EXECUTION_FAILED");
    });

    // 5. Global before hook mutates input, re-parsed
    test("global before hook mutates input, re-parsed successfully", async () => {
      registry.register(makeDescriptor("echo"));
      registry.globalHooks.before.push(async (input) => {
        return { msg: (input as { msg: string }).msg + "!" };
      });
      const ctx = makeContext();
      const call = makeToolCall({ input: { msg: "hi" } });

      const result = await registry.execute(call, ctx);

      expect(result.isError).toBe(false);
      expect(result.output).toBe("echo: hi!");
    });

    // 6. Global before hook mutation fails re-parse → error result
    test("global before hook mutation fails re-parse → error result", async () => {
      registry.register(makeDescriptor("echo"));
      registry.globalHooks.before.push(async () => {
        return { bad: true };
      });
      const ctx = makeContext();
      const call = makeToolCall();

      const result = await registry.execute(call, ctx);

      expect(result.isError).toBe(true);
    });

    // 7. Per-tool before hook mutates input, re-parsed
    test("per-tool before hook mutates input, re-parsed successfully", async () => {
      const desc = makeDescriptor("echo");
      desc.hooks = {
        before: [
          async (input) => {
            return { msg: ((input as { msg: string }).msg as string).toUpperCase() };
          },
        ],
      };
      registry.register(desc);
      const ctx = makeContext();
      const call = makeToolCall({ input: { msg: "hey" } });

      const result = await registry.execute(call, ctx);

      expect(result.isError).toBe(false);
      expect(result.output).toBe("echo: HEY");
    });

    // 8. Per-tool before hook mutation fails re-parse → error result
    test("per-tool before hook mutation fails re-parse → error result", async () => {
      const desc = makeDescriptor("echo");
      desc.hooks = {
        before: [
          async () => {
            return { nope: 1 };
          },
        ],
      };
      registry.register(desc);
      const ctx = makeContext();
      const call = makeToolCall();

      const result = await registry.execute(call, ctx);

      expect(result.isError).toBe(true);
    });

    // 9. Per-tool after hook mutates result
    test("per-tool after hook mutates result", async () => {
      const desc = makeDescriptor("echo");
      desc.hooks = {
        after: [
          async (result) => {
            return { ...result, output: `[wrapped] ${result.output}` };
          },
        ],
      };
      registry.register(desc);
      const ctx = makeContext();
      const call = makeToolCall({ input: { msg: "test" } });

      const result = await registry.execute(call, ctx);

      expect(result.isError).toBe(false);
      expect(result.output).toBe("[wrapped] echo: test");
    });

    // 10. Per-tool after hook throws → result becomes error, global after still runs
    test("per-tool after hook throws → result becomes error, global after still runs", async () => {
      const desc = makeDescriptor("echo");
      desc.hooks = {
        after: [
          async () => {
            throw new Error("after boom");
          },
        ],
      };
      registry.register(desc);

      let globalAfterRan = false;
      registry.globalHooks.after.push(async (result, _ctx) => {
        globalAfterRan = true;
        return result;
      });

      const ctx = makeContext();
      const call = makeToolCall({ input: { msg: "x" } });

      const result = await registry.execute(call, ctx);

      expect(result.isError).toBe(true);
      const output = JSON.parse(result.output) as Record<string, unknown>;
      expect(output.message).toBe("after boom");
      expect(output.code).toBe("TOOL_AFTER_HOOK_FAILED");
      expect(globalAfterRan).toBe(true);
    });

    // 11. Global after hook mutates result
    test("global after hook mutates result", async () => {
      registry.register(makeDescriptor("echo"));
      registry.globalHooks.after.push(async (result) => {
        return { ...result, output: `[global] ${result.output}` };
      });
      const ctx = makeContext();
      const call = makeToolCall({ input: { msg: "x" } });

      const result = await registry.execute(call, ctx);

      expect(result.isError).toBe(false);
      expect(result.output).toBe("[global] echo: x");
    });

    // 12. Global after hook throws → result becomes error, remaining global after still run
    test("global after hook throws → result becomes error, remaining still run", async () => {
      registry.register(makeDescriptor("echo"));

      let secondRan = false;
      registry.globalHooks.after.push(async () => {
        throw new Error("global after error 1");
      });
      registry.globalHooks.after.push(async (result, _ctx) => {
        secondRan = true;
        return result;
      });

      const ctx = makeContext();
      const call = makeToolCall({ input: { msg: "x" } });

      const result = await registry.execute(call, ctx);

      expect(result.isError).toBe(true);
      const output = JSON.parse(result.output) as Record<string, unknown>;
      expect(output.message).toBe("global after error 1");
      expect(output.code).toBe("TOOL_AFTER_HOOK_FAILED");
      expect(secondRan).toBe(true);
    });

    // 13. Hook ordering: global before → per-tool before → executor → per-tool after → global after
    test("hook ordering is correct", async () => {
      const order: string[] = [];

      registry.globalPermissions.push(async () => {
        order.push("global-perm");
        return { outcome: "allow" };
      });

      registry.globalHooks.before.push(async () => {
        order.push("global-before");
      });

      const desc = makeDescriptor("echo");
      desc.hooks = {
        before: [
          async () => {
            order.push("per-tool-before");
          },
        ],
        after: [
          async (result) => {
            order.push("per-tool-after");
            return result;
          },
        ],
      };
      desc.prepareInput = async (raw) => {
        order.push("prepare-input");
        return raw;
      };
      desc.permissions = [
        async () => {
          order.push("per-tool-perm");
          return { outcome: "allow" };
        },
      ];
      desc.execute = async (input) => {
        order.push("executor");
        return `echo: ${(input as { msg: string }).msg}`;
      };
      registry.register(desc);

      registry.globalHooks.after.push(async (result) => {
        order.push("global-after");
        return result;
      });

      const ctx = makeContext();
      const call = makeToolCall();

      await registry.execute(call, ctx);

      expect(order).toEqual([
        "prepare-input",
        "global-perm",
        "per-tool-perm",
        "global-before",
        "per-tool-before",
        "executor",
        "per-tool-after",
        "global-after",
      ]);
    });

    // 14. Context has correct toolName, toolCallId, step, startedAt, durationMs
    test("context is populated with correct fields", async () => {
      registry.register(makeDescriptor("echo"));

      let capturedCtx: ToolExecutionContext | null = null;
      const desc: ToolDescriptor = {
        name: "capture",
        description: "captures ctx",
        inputSchema: z.object({}).strict(),
        traits: { readOnly: true, destructive: false, concurrencySafe: true },
        async execute(_input, ctx) {
          capturedCtx = ctx;
          return "ok";
        },
      };
      registry.register(desc);

      const ac = new AbortController();
      const ctx = makeContext({
        toolName: "capture",
        toolCallId: "my-call-id",
        step: 5,
        abort: ac.signal,
        allowedTools: new Set(["capture"]),
      });
      const call = makeToolCall({
        toolName: "capture",
        toolCallId: "my-call-id",
        input: {},
      });

      await registry.execute(call, ctx);

      expect(capturedCtx).not.toBeNull();
      expect(capturedCtx!.toolName).toBe("capture");
      expect(capturedCtx!.toolCallId).toBe("my-call-id");
      expect(capturedCtx!.step).toBe(5);
      expect(capturedCtx!.startedAt).toBeGreaterThan(0);
      expect(capturedCtx!.durationMs).toBeGreaterThanOrEqual(0);
      expect(capturedCtx!.input).toEqual({});
    });

    // 15. AbortSignal identity preserved in context
    test("abort signal identity is preserved", async () => {
      registry.register(makeDescriptor("echo"));

      let capturedSignal: AbortSignal | null = null;
      const desc: ToolDescriptor = {
        name: "check-abort",
        description: "checks abort signal",
        inputSchema: z.object({}).strict(),
        traits: { readOnly: true, destructive: false, concurrencySafe: true },
        async execute(_input, ctx) {
          capturedSignal = ctx.abort;
          return "ok";
        },
      };
      registry.register(desc);

      const ac = new AbortController();
      const ctx = makeContext({
        toolName: "check-abort",
        abort: ac.signal,
        allowedTools: new Set(["check-abort"]),
      });
      const call = makeToolCall({ toolName: "check-abort", input: {} });

      await registry.execute(call, ctx);

      expect(capturedSignal).not.toBeNull();
      expect(capturedSignal === ac.signal).toBe(true);
    });

    // 16. execute() never throws
    test("execute() never throws for any failure mode", async () => {
      // Unknown tool
      await expect(
        registry.execute(makeToolCall({ toolName: "nope" }), makeContext({ toolName: "nope" })),
      ).resolves.toBeDefined();

      // Registered tool with invalid input
      registry.register(makeDescriptor("echo"));
      await expect(
        registry.execute(makeToolCall({ input: { bad: 1 } }), makeContext()),
      ).resolves.toBeDefined();

      // Executor throws
      const crashDesc: ToolDescriptor = {
        name: "crash",
        description: "crashes",
        inputSchema: z.object({}).strict(),
        traits: { readOnly: true, destructive: false, concurrencySafe: true },
        async execute() {
          throw new Error("bang");
        },
      };
      registry.register(crashDesc);
      await expect(
        registry.execute(
          makeToolCall({ toolName: "crash", input: {} }),
          makeContext({ toolName: "crash", allowedTools: new Set(["crash"]) }),
        ),
      ).resolves.toBeDefined();
    });

    test("prepareInput runs before parse and failure returns permission error through global after only", async () => {
      const order: string[] = [];
      const desc = makeDescriptor("echo");
      desc.prepareInput = async () => {
        order.push("prepare-input");
        throw new Error("prepare failed");
      };
      desc.hooks = {
        before: [async () => order.push("per-tool-before")],
        after: [async (result) => {
          order.push("per-tool-after");
          return result;
        }],
      };
      desc.execute = async () => {
        order.push("executor");
        return "ok";
      };
      registry.register(desc);
      registry.globalHooks.before.push(async () => {
        order.push("global-before");
      });
      registry.globalHooks.after.push(async (result) => {
        order.push("global-after");
        return { ...result, output: `${result.output} wrapped` };
      });

      const result = await registry.execute(makeToolCall(), makeContext());

      expect(result.isError).toBe(true);
      expect(result.output).toContain("prepare failed");
      expect(result.output).toContain("wrapped");
      expect(result.meta?.permissionErrorCode).toBe("TOOL_PREPARE_INPUT_FAILED");
      expect(result.meta?.skippedExecution).toBe(true);
      expect(order).toEqual(["prepare-input", "global-after"]);
    });

    test("registered but disallowed tool skips execution and runs global after only", async () => {
      const order: string[] = [];
      const desc = makeDescriptor("echo");
      desc.hooks = {
        before: [async () => order.push("per-tool-before")],
        after: [async (result) => {
          order.push("per-tool-after");
          return result;
        }],
      };
      desc.execute = async () => {
        order.push("executor");
        return "ok";
      };
      registry.register(desc);
      registry.globalHooks.before.push(async () => {
        order.push("global-before");
      });
      registry.globalHooks.after.push(async (result) => {
        order.push("global-after");
        return result;
      });

      const result = await registry.execute(makeToolCall(), makeContext({ allowedTools: new Set() }));

      expect(result.isError).toBe(true);
      expect(result.meta?.permissionErrorCode).toBe("TOOL_NOT_ALLOWED");
      expect(result.meta?.skippedExecution).toBe(true);
      expect(order).toEqual(["global-after"]);
    });

    test("registered destructiveTool not in allowedTools returns TOOL_NOT_ALLOWED and skips executor spy", async () => {
      const desc = makeSpiedDescriptor("destructiveTool");
      desc.traits = { readOnly: false, destructive: true, concurrencySafe: false };
      desc.permissions = [async () => ({ outcome: "allow" })];
      registry.register(desc);

      const result = await registry.execute(
        makeToolCall({ toolName: "destructiveTool" }),
        makeContext({ toolName: "destructiveTool", allowedTools: new Set(["safeTool"]) }),
      );

      expect(result.isError).toBe(true);
      expect(result.meta?.permissionErrorCode).toBe("TOOL_NOT_ALLOWED");
      expect(desc.execute).not.toHaveBeenCalled();
    });

    test("permission deny uses stable permission metadata and skips hooks plus executor", async () => {
      const order: string[] = [];
      const desc = makeDescriptor("echo");
      desc.permissions = [async () => {
        order.push("per-tool-perm");
        return { outcome: "allow" };
      }];
      desc.hooks = { before: [async () => order.push("per-tool-before")] };
      desc.execute = async () => {
        order.push("executor");
        return "ok";
      };
      registry.register(desc);
      registry.globalPermissions.push(async () => {
        order.push("global-perm");
        return { outcome: "deny", reason: "blocked" };
      });
      registry.globalHooks.after.push(async (result) => {
        order.push("global-after");
        return result;
      });

      const result = await registry.execute(makeToolCall(), makeContext());

      expect(result.isError).toBe(true);
      expect(result.output).toContain("blocked");
      expect(result.meta?.permissionErrorCode).toBe("TOOL_PERMISSION_DENIED");
      expect(result.meta?.skippedExecution).toBe(true);
      expect(order).toEqual(["global-perm", "per-tool-perm", "global-after"]);
    });

    test("permission deny uses permission-provided structured error kind and code", async () => {
      const desc = makeSpiedDescriptor("safeTool");
      desc.permissions = [async () => ({
        outcome: "deny",
        reason: "must read before write",
        errorKind: "read-before-write",
        errorCode: "TOOL_FILE_NOT_READ_FIRST",
      })];
      registry.register(desc);

      const result = await registry.execute(
        makeToolCall({ toolName: "safeTool" }),
        makeContext({ toolName: "safeTool", allowedTools: new Set(["safeTool"]) }),
      );

      const output = JSON.parse(result.output) as Record<string, unknown>;
      const toolError = result.meta?.[TOOL_ERROR_META_KEY] as Record<string, unknown>;
      expect(result.isError).toBe(true);
      expect(output.kind).toBe("read-before-write");
      expect(output.code).toBe("TOOL_FILE_NOT_READ_FIRST");
      expect(toolError.kind).toBe("read-before-write");
      expect(result.meta?.permissionErrorCode).toBe("TOOL_FILE_NOT_READ_FIRST");
      expect(result.meta?.skippedExecution).toBe(true);
      expect(desc.execute).not.toHaveBeenCalled();
    });

    test("permission deny without structured fields falls back to generic permission denial", async () => {
      const desc = makeSpiedDescriptor("safeTool");
      desc.permissions = [async () => ({ outcome: "deny", reason: "blocked" })];
      registry.register(desc);

      const result = await registry.execute(
        makeToolCall({ toolName: "safeTool" }),
        makeContext({ toolName: "safeTool", allowedTools: new Set(["safeTool"]) }),
      );

      const output = JSON.parse(result.output) as Record<string, unknown>;
      expect(result.isError).toBe(true);
      expect(output.kind).toBe("permission-denied");
      expect(output.code).toBe("TOOL_PERMISSION_DENIED");
      expect(result.meta?.permissionErrorCode).toBe("TOOL_PERMISSION_DENIED");
      expect(result.meta?.skippedExecution).toBe(true);
      expect(desc.execute).not.toHaveBeenCalled();
    });

    test("permission deny skips before executor per-tool after and still runs global after", async () => {
      const order: string[] = [];
      const desc = makeSpiedDescriptor("sensitiveReadTool");
      desc.hooks = {
        before: [async () => order.push("per-tool-before")],
        after: [async (result) => {
          order.push("per-tool-after");
          return result;
        }],
      };
      desc.permissions = [async () => {
        order.push("descriptor-perm");
        return { outcome: "deny", reason: "sensitive read denied" };
      }];
      registry.register(desc);
      registry.globalHooks.before.push(async () => order.push("global-before"));
      registry.globalHooks.after.push(async (result) => {
        order.push("global-after");
        return result;
      });

      const result = await registry.execute(
        makeToolCall({ toolName: "sensitiveReadTool" }),
        makeContext({ toolName: "sensitiveReadTool", allowedTools: new Set(["sensitiveReadTool"]) }),
      );

      expect(result.isError).toBe(true);
      expect(result.meta?.permissionErrorCode).toBe("TOOL_PERMISSION_DENIED");
      expect(desc.execute).not.toHaveBeenCalled();
      expect(order).toEqual(["descriptor-perm", "global-after"]);
    });

    test("ask decision calls confirmation callback and approval continues", async () => {
      const order: string[] = [];
      registry.globalPermissions.push(async () => {
        order.push("global-perm");
        return { outcome: "ask", reason: "needs approval" };
      });
      registry.globalHooks.before.push(async () => {
        order.push("global-before");
      });
      const desc = makeDescriptor("echo");
      desc.execute = async () => {
        order.push("executor");
        return "approved";
      };
      registry.register(desc);
      const confirmPermission = mock(async (request) => {
        expect(request).toEqual({
          toolName: "echo",
          toolCallId: "call-1",
          input: { msg: "hello" },
          description: "Tool: echo",
          reason: "needs approval",
        });
        order.push("confirm");
        return "approve" as const;
      });

      const result = await registry.execute(makeToolCall(), makeContext({ confirmPermission }));

      expect(result).toEqual({ output: "approved", isError: false });
      expect(confirmPermission).toHaveBeenCalledTimes(1);
      expect(order).toEqual(["global-perm", "confirm", "global-before", "executor"]);
    });

    test("deny decisions skip confirmation even when approval exists", async () => {
      const scope: PermissionApprovalScope = {
        kind: "tool-operation",
        toolName: "echo",
        operation: "danger",
      };
      const manager = new ProjectApprovalManager();
      const workspaceRoot = join(import.meta.dir, "__test_tmp__", `approval-deny-${crypto.randomUUID()}`);
      await manager.load(workspaceRoot);
      await manager.addApproval(scope, { display: "Existing approval", reason: "already trusted" });
      registry.setProjectApprovalManager(manager);
      registry.register({
        ...makeDescriptor("echo"),
        execute: mock(async () => "should not run"),
        permissions: [async () => ({
          outcome: "deny",
          reason: "blocked despite approval",
          approval: { eligible: true, scope, display: "Existing approval", reason: "already trusted" },
        })],
      });
      const confirmPermission = mock(async () => "approve_once" as const);

      const result = await registry.execute(
        makeToolCall(),
        makeContext({ workspaceRoot, confirmPermission }),
      );

      expect(result.isError).toBe(true);
      expect(result.meta?.permissionErrorCode).toBe("TOOL_PERMISSION_DENIED");
      expect(confirmPermission).not.toHaveBeenCalled();
      expect(registry.get("echo")!.execute).not.toHaveBeenCalled();
    });

    test("eligible ask without matching approval prompts user", async () => {
      const scope: PermissionApprovalScope = {
        kind: "file-path",
        operation: "write",
        path: "notes.md",
        pathMode: "exact",
      };
      const workspaceRoot = join(import.meta.dir, "__test_tmp__", `approval-prompt-${crypto.randomUUID()}`);
      registry.setProjectApprovalManager(new ProjectApprovalManager());
      registry.register({
        ...makeDescriptor("echo"),
        permissions: [async () => ({
          outcome: "ask",
          reason: "write notes",
          prompt: "Allow writing notes?",
          display: "Write notes.md",
          ruleId: "file-write",
          approval: { eligible: true, scope, display: "Write notes.md", reason: "write notes" },
        })],
      });
      const confirmPermission = mock(async (request) => {
        expect(request.approval).toEqual({
          eligible: true,
          scope,
          display: "Write notes.md",
          reason: "write notes",
        });
        expect(request.reason).toBe("Allow writing notes?");
        expect(request.decisionDisplay).toBe("Write notes.md");
        expect(request.ruleId).toBe("file-write");
        return "approve_once" as const;
      });

      const result = await registry.execute(
        makeToolCall(),
        makeContext({ workspaceRoot, confirmPermission }),
      );

      expect(result.isError).toBe(false);
      expect(confirmPermission).toHaveBeenCalledTimes(1);
    });

    test("redacts approval display and reason while preserving scope", async () => {
      const scope: PermissionApprovalScope = {
        kind: "bash-exact",
        normalized: "curl https://example.com?api_key=sk-1234567890",
        effects: ["network"],
      };
      const workspaceRoot = join(import.meta.dir, "__test_tmp__", `approval-redaction-${crypto.randomUUID()}`);
      registry.setProjectApprovalManager(new ProjectApprovalManager());
      registry.register({
        ...makeDescriptor("echo"),
        permissions: [async () => ({
          outcome: "ask",
          reason: "api_key=sk-1234567890",
          approval: {
            eligible: true,
            scope,
            display: "Run api_key=sk-1234567890",
            reason: "Needed because token=ghp-1234567890",
          },
        })],
      });
      const confirmPermission = mock(async (request) => {
        expect(request.approval).toEqual({
          eligible: true,
          scope,
          display: `Run api_key=${REDACTION_MARKER}`,
          reason: `Needed because token=${REDACTION_MARKER}`,
        });
        return "approve_once" as const;
      });

      const result = await registry.execute(
        makeToolCall(),
        makeContext({ workspaceRoot, confirmPermission }),
      );

      expect(result.isError).toBe(false);
      expect(confirmPermission).toHaveBeenCalledTimes(1);
    });

    test("eligible ask with matching project approval executes without prompt", async () => {
      const scope: PermissionApprovalScope = {
        kind: "web-origin",
        origin: "https://example.com",
      };
      const manager = new ProjectApprovalManager();
      const workspaceRoot = join(import.meta.dir, "__test_tmp__", `approval-match-${crypto.randomUUID()}`);
      await manager.load(workspaceRoot);
      await manager.addApproval(scope, { display: "Fetch example.com", reason: "trusted origin" });
      registry.setProjectApprovalManager(manager);
      const desc = makeSpiedDescriptor("echo");
      desc.permissions = [async () => ({
        outcome: "ask",
        reason: "fetch origin",
        approval: { eligible: true, scope, display: "Fetch example.com", reason: "trusted origin" },
      })];
      registry.register(desc);
      const confirmPermission = mock(async () => "deny" as const);

      const result = await registry.execute(
        makeToolCall(),
        makeContext({ workspaceRoot, confirmPermission }),
      );

      expect(result.isError).toBe(false);
      expect(desc.execute).toHaveBeenCalledTimes(1);
      expect(confirmPermission).not.toHaveBeenCalled();
    });

    test("ineligible ask passes no persistent scope and approve always is not persisted", async () => {
      const manager = new ProjectApprovalManager();
      const workspaceRoot = join(import.meta.dir, "__test_tmp__", `approval-ineligible-${crypto.randomUUID()}`);
      await manager.load(workspaceRoot);
      registry.setProjectApprovalManager(manager);
      registry.register({
        ...makeDescriptor("echo"),
        permissions: [async () => ({
          outcome: "ask",
          reason: "parser uncertain",
          approval: { eligible: false, display: "Parser uncertain", reason: "cannot persist uncertainty" },
        })],
      });
      const confirmPermission = mock(async (request) => {
        expect(request.approval).toEqual({
          eligible: false,
          display: "Parser uncertain",
          reason: "cannot persist uncertainty",
        });
        expect(request.approval?.scope).toBeUndefined();
        return "approve_always" as const;
      });

      const result = await registry.execute(
        makeToolCall(),
        makeContext({ workspaceRoot, confirmPermission }),
      );

      expect(result.isError).toBe(false);
      expect(manager.listApprovals()).toEqual([]);
    });

    test("allow always persists exactly the structured approval scope", async () => {
      const scope: PermissionApprovalScope = {
        kind: "bash-exact",
        normalized: "bun test src/tools/registry.test.ts",
        effects: ["execute-code"],
      };
      const manager = new ProjectApprovalManager();
      const workspaceRoot = join(import.meta.dir, "__test_tmp__", `approval-persist-${crypto.randomUUID()}`);
      registry.setProjectApprovalManager(manager);
      registry.register({
        ...makeDescriptor("echo"),
        permissions: [async () => ({
          outcome: "ask",
          reason: "run test command",
          approval: { eligible: true, scope, display: "Run registry test", reason: "run test command" },
        })],
      });

      const result = await registry.execute(
        makeToolCall(),
        makeContext({
          workspaceRoot,
          agentName: "Orchestrator",
          currentDepth: 0,
          confirmPermission: async () => "approve_always",
        }),
      );

      expect(result.isError).toBe(false);
      const approvals = manager.listApprovals();
      expect(approvals).toHaveLength(1);
      expect(approvals[0].scope).toEqual(scope);
      expect(approvals[0].display).toBe("Run registry test");
      expect(approvals[0].reason).toBe("run test command");
      expect(approvals[0].grantedBy).toEqual({ agentName: "Orchestrator", depth: 0 });
    });

    test("permission ask approve runs before hooks and executor for safeTool", async () => {
      const order: string[] = [];
      const desc = makeSpiedDescriptor("safeTool");
      desc.permissions = [async () => {
        order.push("descriptor-perm");
        return { outcome: "ask", reason: "confirm safe tool" };
      }];
      desc.hooks = {
        before: [async () => {
          order.push("per-tool-before");
        }],
      };
      desc.execute = mock(async () => {
        order.push("executor");
        return "approved";
      });
      registry.register(desc);
      registry.globalHooks.before.push(async () => {
        order.push("global-before");
      });
      const confirmPermission = mock(async () => {
        order.push("confirm");
        return "approve" as const;
      });

      const result = await registry.execute(
        makeToolCall({ toolName: "safeTool" }),
        makeContext({ toolName: "safeTool", allowedTools: new Set(["safeTool"]), confirmPermission }),
      );

      expect(result).toEqual({ output: "approved", isError: false });
      expect(desc.execute).toHaveBeenCalledTimes(1);
      expect(order).toEqual(["descriptor-perm", "confirm", "global-before", "per-tool-before", "executor"]);
    });

    test.each([
      ["deny", "TOOL_PERMISSION_CONFIRMATION_DENIED"],
      ["timeout", "TOOL_PERMISSION_CONFIRMATION_TIMEOUT"],
    ] as const)("confirmation %s returns %s and skips execution", async (decision, code) => {
      const order: string[] = [];
      registry.register({
        ...makeDescriptor("echo"),
        execute: async () => {
          order.push("executor");
          return "nope";
        },
      });
      registry.globalPermissions.push(async () => ({ outcome: "ask", reason: "confirm" }));
      registry.globalHooks.after.push(async (result) => {
        order.push("global-after");
        return result;
      });

      const result = await registry.execute(
        makeToolCall(),
        makeContext({ confirmPermission: async () => decision }),
      );

      expect(result.isError).toBe(true);
      expect(result.meta?.permissionErrorCode).toBe(code);
      expect(result.meta?.skippedExecution).toBe(true);
      expect(order).toEqual(["global-after"]);
    });

    test("ask decision without confirmation callback returns unavailable", async () => {
      registry.register(makeDescriptor("echo"));
      registry.globalPermissions.push(async () => ({ outcome: "ask", reason: "confirm" }));

      const result = await registry.execute(makeToolCall(), makeContext());

      expect(result.isError).toBe(true);
      expect(result.meta?.permissionErrorCode).toBe("TOOL_PERMISSION_CONFIRMATION_UNAVAILABLE");
      expect(result.meta?.skippedExecution).toBe(true);
    });

    test("confirmation rejection returns failed permission result", async () => {
      registry.register(makeDescriptor("echo"));
      registry.globalPermissions.push(async () => ({ outcome: "ask", reason: "confirm" }));

      const result = await registry.execute(
        makeToolCall(),
        makeContext({ confirmPermission: async () => { throw new Error("ui failed"); } }),
      );

      expect(result.isError).toBe(true);
      expect(result.output).toContain("ui failed");
      expect(result.meta?.permissionErrorCode).toBe("TOOL_PERMISSION_CONFIRMATION_FAILED");
      expect(result.meta?.skippedExecution).toBe(true);
    });

    test("descriptor with no permissions defaults to allow when global permissions allow", async () => {
      const desc = makeSpiedDescriptor("safeTool");
      registry.register(desc);
      registry.globalPermissions.push(async () => ({ outcome: "allow" }));

      const result = await registry.execute(
        makeToolCall({ toolName: "safeTool", input: { msg: "open" } }),
        makeContext({ toolName: "safeTool", allowedTools: new Set(["safeTool"]) }),
      );

      expect(result).toEqual({ output: "echo: open", isError: false });
      expect(desc.execute).toHaveBeenCalledTimes(1);
    });

    test("no global permissions and no descriptor permissions defaults to allow", async () => {
      const desc = makeSpiedDescriptor("safeTool");
      registry.register(desc);

      const result = await registry.execute(
        makeToolCall({ toolName: "safeTool", input: { msg: "open" } }),
        makeContext({ toolName: "safeTool", allowedTools: new Set(["safeTool"]) }),
      );

      expect(result).toEqual({ output: "echo: open", isError: false });
      expect(desc.execute).toHaveBeenCalledTimes(1);
    });

    test("safeParse failure preserves existing non-permission error behavior", async () => {
      const desc = makeSpiedDescriptor("safeTool");
      registry.register(desc);
      const globalAfter = mock(async (result) => result);
      registry.globalHooks.after.push(globalAfter);

      const result = await registry.execute(
        makeToolCall({ toolName: "safeTool", input: { bad: 1 } }),
        makeContext({ toolName: "safeTool", allowedTools: new Set(["safeTool"]) }),
      );

      expect(result.isError).toBe(true);
      expect(result.output).toContain("invalid_type");
      expect(result.meta?.[TOOL_ERROR_META_KEY]).toBeDefined();
      expect(desc.execute).not.toHaveBeenCalled();
      expect(globalAfter).toHaveBeenCalledTimes(1);
    });

    test("global after hook throwing on permission denied preserves current global-after semantics", async () => {
      const desc = makeSpiedDescriptor("safeTool");
      desc.permissions = [async () => ({ outcome: "deny", reason: "blocked" })];
      registry.register(desc);
      const secondAfter = mock(async (result) => result);
      registry.globalHooks.after.push(async () => {
        throw new Error("global after denied failure");
      });
      registry.globalHooks.after.push(secondAfter);

      const result = await registry.execute(
        makeToolCall({ toolName: "safeTool" }),
        makeContext({ toolName: "safeTool", allowedTools: new Set(["safeTool"]) }),
      );

      const output = JSON.parse(result.output) as Record<string, unknown>;
      expect(output.message).toBe("global after denied failure");
      expect(output.code).toBe("TOOL_AFTER_HOOK_FAILED");
      expect(desc.execute).not.toHaveBeenCalled();
      expect(secondAfter).toHaveBeenCalledTimes(1);
    });

    test.each([
      ["deny", "TOOL_PERMISSION_CONFIRMATION_DENIED"],
      ["timeout", "TOOL_PERMISSION_CONFIRMATION_TIMEOUT"],
      ["unavailable", "TOOL_PERMISSION_CONFIRMATION_UNAVAILABLE"],
      ["failed", "TOOL_PERMISSION_CONFIRMATION_FAILED"],
    ] as const)("permission ask %s returns %s and skips execution", async (scenario, code) => {
      const desc = makeSpiedDescriptor("sensitiveReadTool");
      desc.permissions = [async () => ({ outcome: "ask", reason: "confirm sensitive read" })];
      registry.register(desc);

      const confirmPermission =
        scenario === "deny"
          ? mock(async () => "deny" as const)
          : scenario === "timeout"
            ? mock(async () => "timeout" as const)
            : scenario === "failed"
              ? mock(async () => { throw new Error("confirmation failed"); })
              : undefined;

      const result = await registry.execute(
        makeToolCall({ toolName: "sensitiveReadTool" }),
        makeContext({
          toolName: "sensitiveReadTool",
          allowedTools: new Set(["sensitiveReadTool"]),
          ...(confirmPermission ? { confirmPermission } : {}),
        }),
      );

      expect(result.isError).toBe(true);
      expect(result.meta?.permissionErrorCode).toBe(code);
      expect(result.meta?.skippedExecution).toBe(true);
      expect(desc.execute).not.toHaveBeenCalled();
    });

    test("prepareInput failure returns TOOL_PREPARE_INPUT_FAILED and runs global after", async () => {
      const order: string[] = [];
      const desc = makeSpiedDescriptor("safeTool");
      desc.prepareInput = async () => {
        order.push("prepare-input");
        throw new Error("bad mirror input");
      };
      registry.register(desc);
      registry.globalHooks.after.push(async (result) => {
        order.push("global-after");
        return result;
      });

      const result = await registry.execute(
        makeToolCall({ toolName: "safeTool" }),
        makeContext({ toolName: "safeTool", allowedTools: new Set(["safeTool"]) }),
      );

      expect(result.isError).toBe(true);
      expect(result.output).toContain("bad mirror input");
      expect(result.meta?.permissionErrorCode).toBe("TOOL_PREPARE_INPUT_FAILED");
      expect(desc.execute).not.toHaveBeenCalled();
      expect(order).toEqual(["prepare-input", "global-after"]);
    });

    test("global permissions run before descriptor permissions", async () => {
      const order: string[] = [];
      registry.globalPermissions.push(async () => {
        order.push("global-perm-1");
        return { outcome: "allow" };
      });
      registry.globalPermissions.push(async () => {
        order.push("global-perm-2");
        return { outcome: "ask", reason: "global ask" };
      });
      const desc = makeSpiedDescriptor("safeTool");
      desc.permissions = [async () => {
        order.push("descriptor-perm");
        return { outcome: "allow" };
      }];
      registry.register(desc);

      await registry.execute(
        makeToolCall({ toolName: "safeTool" }),
        makeContext({
          toolName: "safeTool",
          allowedTools: new Set(["safeTool"]),
          confirmPermission: async () => "approve",
        }),
      );

      expect(order).toEqual(["global-perm-1", "global-perm-2", "descriptor-perm"]);
    });

    test("permission confirmation request includes agent attribution and abort signal", async () => {
      const desc = makeSpiedDescriptor("attributedTool");
      desc.permissions = [async () => ({ outcome: "ask", reason: "confirm attributed tool" })];
      registry.register(desc);
      const controller = new AbortController();
      let capturedSignal: AbortSignal | undefined;
      const confirmPermission = mock(async (_request, abortSignal?: AbortSignal) => {
        capturedSignal = abortSignal;
        return "approve_once" as const;
      });

      const result = await registry.execute(
        makeToolCall({ toolName: "attributedTool" }),
        makeContext({
          toolName: "attributedTool",
          allowedTools: new Set(["attributedTool"]),
          abort: controller.signal,
          agentName: "Explorer",
          currentDepth: 2,
          confirmPermission,
        }),
      );

      expect(result.isError).toBe(false);
      expect(confirmPermission).toHaveBeenCalledTimes(1);
      expect(confirmPermission.mock.calls[0]![0]).toMatchObject({
        toolName: "attributedTool",
        toolCallId: "call-1",
        agentName: "Explorer",
        currentDepth: 2,
      });
      expect(capturedSignal).toBe(controller.signal);
    });
  });
});

// ─── resolveForAgent ───

describe("resolveForAgent()", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = createRegistry();
  });

  test("undefined toolNames returns empty ResolvedToolSet", () => {
    registry.register(makeDescriptor("echo"));

    const resolved = registry.resolveForAgent(undefined);

    expect(resolved.descriptors).toEqual([]);
  });

  test("empty array toolNames returns empty ResolvedToolSet", () => {
    registry.register(makeDescriptor("echo"));

    const resolved = registry.resolveForAgent([]);

    expect(resolved.descriptors).toEqual([]);
  });

  test("resolves registered tool by name", () => {
    const echoDesc = makeDescriptor("echo");
    const readDesc = makeDescriptor("read");
    registry.registerAll([echoDesc, readDesc]);

    const resolved = registry.resolveForAgent(["echo"]);

    expect(resolved.has("echo")).toBe(true);
    expect(resolved.has("read")).toBe(false);
    expect(resolved.get("echo")).toBe(echoDesc);
    expect(resolved.get("read")).toBeUndefined();
  });

  test("unknown tool name is warned via logger and omitted", () => {
    const logger = makeLogger();
    registry = createRegistry([], logger);

    registry.register(makeDescriptor("echo"));

    const resolved = registry.resolveForAgent(["echo", "missing"]);

    // missing tool is omitted
    expect(resolved.has("echo")).toBe(true);
    expect(resolved.has("missing")).toBe(false);
    expect(resolved.descriptors).toHaveLength(1);

    // logger.warn was called for the missing tool
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const callArg = (logger.warn as ReturnType<typeof mock>).mock.calls[0][0];
    expect(callArg).toContain("missing");
  });
});

// ─── ResolvedToolSet ───

describe("ResolvedToolSet", () => {
  let echoDesc: ToolDescriptor;
  let readDesc: ToolDescriptor;
  let set: ResolvedToolSet;

  beforeEach(() => {
    echoDesc = makeDescriptor("echo");
    readDesc = makeDescriptor("read");
    set = new ResolvedToolSet([echoDesc, readDesc]);
  });

  describe("descriptors", () => {
    test("exposes all descriptors", () => {
      expect(set.descriptors).toHaveLength(2);
      expect(set.descriptors[0]).toBe(echoDesc);
      expect(set.descriptors[1]).toBe(readDesc);
    });
  });

  describe("has()", () => {
    test("returns true for known name", () => {
      expect(set.has("echo")).toBe(true);
      expect(set.has("read")).toBe(true);
    });

    test("returns false for unknown name", () => {
      expect(set.has("write")).toBe(false);
    });
  });

  describe("get()", () => {
    test("returns descriptor for known name", () => {
      expect(set.get("echo")).toBe(echoDesc);
    });

    test("returns undefined for unknown name", () => {
      expect(set.get("write")).toBeUndefined();
    });
  });

  describe("toAITools()", () => {
    test("returns description + inputSchema, no execute", () => {
      const aiTools = set.toAITools();

      expect(aiTools).toHaveProperty("echo");
      expect(aiTools).toHaveProperty("read");

      const echoAi = aiTools["echo"];
      expect(echoAi).toHaveProperty("description", "Tool: echo");
      expect(echoAi).toHaveProperty("inputSchema");
      // Must NOT include execute
      expect(echoAi).not.toHaveProperty("execute");

      const readAi = aiTools["read"];
      expect(readAi).toHaveProperty("description", "Tool: read");
      expect(readAi).toHaveProperty("inputSchema");
      expect(readAi).not.toHaveProperty("execute");
    });

    test("returns empty object for empty descriptor list", () => {
      const empty = new ResolvedToolSet([]);
      expect(empty.toAITools()).toEqual({});
    });

    test("prefers aiInputSchema over inputSchema when set", () => {
      const zodSchema = z.object({ msg: z.string() });
      const aiSchema = jsonSchema({
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      });

      const dualDesc: ToolDescriptor = {
        name: "mcp__ctx7__resolve",
        description: "Resolve context",
        inputSchema: zodSchema,
        aiInputSchema: aiSchema,
        traits: { readOnly: true, destructive: false, concurrencySafe: true },
        execute: async () => "ok",
      };

      const aiTools = new ResolvedToolSet([dualDesc]).toAITools();

      expect(aiTools["mcp__ctx7__resolve"].inputSchema).toBe(aiSchema);
    });

    test("falls back to inputSchema when aiInputSchema is undefined", () => {
      const zodSchema = z.object({ msg: z.string() });
      const builtinDesc: ToolDescriptor = {
        name: "echo",
        description: "Echo tool",
        inputSchema: zodSchema,
        traits: { readOnly: true, destructive: false, concurrencySafe: true },
        execute: async () => "ok",
      };

      const aiTools = new ResolvedToolSet([builtinDesc]).toAITools();

      // When aiInputSchema is undefined, inputSchema (Zod) is used
      expect(aiTools["echo"].inputSchema).toBe(zodSchema);
    });
  });
});

// ─── createRegistry factory ───

describe("createRegistry()", () => {
  test("creates ToolRegistry with no descriptors", () => {
    const registry = createRegistry();

    expect(registry.getAll()).toEqual([]);
    expect(registry.globalHooks.before).toEqual([]);
    expect(registry.globalHooks.after).toEqual([]);
  });

  test("creates ToolRegistry and registers initial descriptors", () => {
    const descs = [makeDescriptor("echo"), makeDescriptor("read")];

    const registry = createRegistry(descs);

    expect(registry.getAll()).toHaveLength(2);
    expect(registry.get("echo")).toBe(descs[0]);
    expect(registry.get("read")).toBe(descs[1]);
  });

  test("accepts optional logger", () => {
    const logger = makeLogger();

    const registry = createRegistry([], logger);

    // Verify the logger is used (resolveForAgent for a missing tool)
    registry.register(makeDescriptor("echo"));
    const resolved = registry.resolveForAgent(["missing"]);

    expect(resolved.descriptors).toEqual([]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

// ─── Hook Integration with Registry ───

describe("hook integration with registry", () => {
  const tmpRoot = join(import.meta.dir, "__test_tmp__");

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function makeContext(
    overrides?: Partial<ToolExecutionContext>,
  ): ToolExecutionContext {
    const ac = new AbortController();
    return {
      store: { getState: () => ({ sessionId: "test-session" }) } as ToolExecutionContext["store"],
      toolName: "echo",
      toolCallId: "call-1",
      input: { msg: "hello" },
      step: 0,
      abort: ac.signal,
      startedAt: 0,
      allowedTools: new Set(["echo"]),
      workspaceRoot: "/tmp",
      ...overrides,
    };
  }

  function makeToolCall(
    overrides?: Partial<ToolCallLike>,
  ): ToolCallLike {
    return {
      toolCallId: "call-1",
      toolName: "echo",
      input: { msg: "hello" },
      ...overrides,
    };
  }

  // 1. Duration flows into execution logger via global after hook
  test("duration flows into execution logger via global after hook", async () => {
    const registry = createRegistry();
    registry.register(makeDescriptor("echo"));

    const logger = makeLogger();
    registry.globalHooks.after.push(createExecutionLogger(logger));

    const ctx = makeContext();
    const call = makeToolCall({ input: { msg: "hello" } });

    await registry.execute(call, ctx);

    expect(logger.info).toHaveBeenCalledTimes(1);
    const calls = (logger.info as ReturnType<typeof mock>).mock.calls;
    expect(calls[0][0]).toBe("Tool execution completed");

    const meta = calls[0][1] as Record<string, unknown>;
    expect(meta.toolName).toBe("echo");
    expect(meta.toolCallId).toBe("call-1");
    expect(meta.isError).toBe(false);
    expect(typeof meta.outputSize).toBe("number");
    expect((meta.outputSize as number) > 0).toBe(true);
    expect(typeof meta.durationMs).toBe("number");
    expect((meta.durationMs as number) >= 0).toBe(true);
  });

  // 2. Truncator runs after per-tool after failure and truncates error output
  test("truncator truncates error output from failed per-tool after hook", async () => {
    const registry = createRegistry();
    const desc = makeDescriptor("echo");

    // Per-tool after hook throws a long error message (> maxBytes=100)
    const longErrorMessage = "ERROR: " + "X".repeat(200);
    desc.hooks = {
      after: [
        async () => {
          throw new Error(longErrorMessage);
        },
      ],
    };
    registry.register(desc);

    const truncOutDir = join(tmpRoot, "scenario2");
    registry.globalHooks.after.push(
      createOutputTruncator({ outputDir: truncOutDir, maxBytes: 100, maxLines: 5 }),
    );

    const ctx = makeContext();
    const call = makeToolCall({ input: { msg: "hello" } });

    const result = await registry.execute(call, ctx);

    // Result should still be error
    expect(result.isError).toBe(true);
    // Output should contain truncation marker
    expect(result.output).toContain("[Output truncated; full output saved to:");
    expect(result.meta?.truncated).toBe(true);
    expect(typeof result.meta?.fullOutputPath).toBe("string");

    // Verify full error was persisted to file
    const fullPath = result.meta!.fullOutputPath as string;
    const fileContent = await Bun.file(fullPath).text();
    expect(fileContent).toContain("TOOL_AFTER_HOOK_FAILED");
    expect(fileContent).toContain("ERROR: [REDACTED:SECRET]");
  });

  // 3. Permission check runs before executor without mutating input
  test("permission check runs before executor without mutating input", async () => {
    const registry = createRegistry();
    registry.register(makeDescriptor("echo"));
    const order: string[] = [];
    registry.globalPermissions.push(async () => {
      order.push("perm");
      return { outcome: "allow" };
    });
    registry.globalHooks.before.push(async () => {
      order.push("before");
    });

    const ctx = makeContext();
    const call = makeToolCall({ input: { msg: "hello" } });

    const result = await registry.execute(call, ctx);

    expect(result.isError).toBe(false);
    expect(result.output).toBe("echo: hello");
    expect(order).toEqual(["perm", "before"]);
  });

  // 4. Truncator handles large successful output, preserves isError false
  test("truncator truncates large successful output, preserves isError false", async () => {
    const registry = createRegistry();
    const desc = makeDescriptor("echo");

    // Executor returns large output (> maxBytes=100)
    desc.execute = async () => {
      return "Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\n" + "X".repeat(200);
    };
    registry.register(desc);

    const truncOutDir = join(tmpRoot, "scenario4");
    registry.globalHooks.after.push(
      createOutputTruncator({ outputDir: truncOutDir, maxBytes: 100, maxLines: 5 }),
    );

    const ctx = makeContext();
    const call = makeToolCall({ input: { msg: "hello" } });

    const result = await registry.execute(call, ctx);

    // isError should remain false (successful execution)
    expect(result.isError).toBe(false);
    // Output should contain truncation marker
    expect(result.output).toContain("[Output truncated; full output saved to:");
    expect(result.meta?.truncated).toBe(true);
    expect(typeof result.meta?.fullOutputPath).toBe("string");

    // Verify full output was persisted to file
    const fullPath = result.meta!.fullOutputPath as string;
    const fileContent = await Bun.file(fullPath).text();
    const expectedContent = "Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\n" + "X".repeat(200);
    expect(fileContent).toBe(expectedContent);
  });

  test("redaction precedes truncation, audit, logger, and persisted full output", async () => {
    const registry = createRegistry();
    const events: AuditEvent[] = [];
    const logger = makeLogger();
    const rawSecret = "sk_test_1234567890abcdef";
    const output = [
      "line1",
      "line2",
      "line3",
      "line4",
      "line5",
      `line6 secret=${rawSecret}`,
    ].join("\n");

    const desc = makeDescriptor("echo");
    desc.execute = async () => output;
    registry.register(desc);
    const auditSink = (event: AuditEvent): void => { events.push(event); };
    registry.globalHooks.after.push(createRedactionHook());
    registry.globalHooks.after.push(createOutputTruncator({ outputDir: join(tmpRoot, "redact-truncate"), maxBytes: 20, maxLines: 3 }));
    registry.globalHooks.after.push(createAuditHook({ sink: auditSink }));
    registry.globalHooks.after.push(createExecutionLogger(logger));

    const result = await registry.execute(
      makeToolCall({ input: { msg: `token=${rawSecret}` } }),
      makeContext({ input: { msg: `token=${rawSecret}` } }),
    );

    expect(result.output).not.toContain(rawSecret);
    expect(result.output).toContain("[Output truncated; full output saved to:");
    const fullPath = result.meta!.fullOutputPath as string;
    const fileContent = await Bun.file(fullPath).text();
    expect(fileContent).toContain(REDACTION_MARKER);
    expect(fileContent).not.toContain(rawSecret);
    expect(JSON.stringify(events)).toContain(REDACTION_MARKER);
    expect(JSON.stringify(events)).not.toContain(rawSecret);
    const loggerMeta = (logger.info as ReturnType<typeof mock>).mock.calls[0][1] as Record<string, unknown>;
    expect(JSON.stringify(loggerMeta)).toContain(REDACTION_MARKER);
    expect(JSON.stringify(loggerMeta)).not.toContain(rawSecret);
  });

  test("schema parse errors and before-hook reparse errors run global after hooks", async () => {
    const registry = createRegistry();
    const after = mock(async (result) => ({ ...result, output: `${result.output}\nAFTER` }));
    registry.register(makeDescriptor("echo"));
    registry.globalHooks.after.push(after);

    const parseError = await registry.execute(
      makeToolCall({ input: { bad: 1 } }),
      makeContext({ input: { bad: 1 } }),
    );

    registry.globalHooks.before.push(async () => ({ bad: true }));
    const reparseError = await registry.execute(makeToolCall(), makeContext());

    expect(parseError.output).toContain("AFTER");
    expect(reparseError.output).toContain("AFTER");
    expect(after).toHaveBeenCalledTimes(2);
  });

  test("redacts permission denial and confirmation prompt before callback and result", async () => {
    const registry = createRegistry();
    const rawSecret = "sk_test_1234567890abcdef";
    registry.register(makeDescriptor("echo"));
    registry.globalHooks.after.push(createRedactionHook());

    registry.globalPermissions.push(async () => ({ outcome: "ask", prompt: `approve token=${rawSecret}` }));
    const confirmPermission = mock(async (request) => {
      expect(JSON.stringify(request)).not.toContain(rawSecret);
      expect(JSON.stringify(request)).toContain(REDACTION_MARKER);
      return "deny" as const;
    });

    const denied = await registry.execute(
      makeToolCall({ input: { msg: `token=${rawSecret}` } }),
      makeContext({ input: { msg: `token=${rawSecret}` }, confirmPermission }),
    );

    expect(denied.output).not.toContain(rawSecret);
    expect(confirmPermission).toHaveBeenCalledTimes(1);

    const denyRegistry = createRegistry();
    denyRegistry.register(makeDescriptor("echo"));
    denyRegistry.globalHooks.after.push(createRedactionHook());
    denyRegistry.globalPermissions.push(async () => ({ outcome: "deny", reason: `blocked secret=${rawSecret}` }));
    const result = await denyRegistry.execute(makeToolCall(), makeContext());
    expect(result.output).toContain(`blocked secret=${REDACTION_MARKER}`);
    expect(result.output).not.toContain(rawSecret);
  });
});

// ─── Permission API contract (TDD red phase) ───

describe("Permission API contract — registry", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = createRegistry();
  });

  describe("globalPermissions", () => {
    test("registry has 'globalPermissions' field instead of 'globalGuards'", () => {
      expect(Array.isArray(registry.globalPermissions)).toBe(true);
      expect(registry.globalPermissions).toEqual([]);
    });

    test("globalPermissions is a mutable array accepting ToolPermission functions", () => {
      const perm: ToolPermission = async () => ({ outcome: "allow" });
      registry.globalPermissions.push(perm);
      expect(registry.globalPermissions).toHaveLength(1);
      expect(registry.globalPermissions[0]).toBe(perm);
    });


  });

  describe("descriptor.permissions", () => {
    test("descriptor uses 'permissions' instead of 'guards'", () => {
      const perm: ToolPermission = async () => ({ outcome: "allow" });
      const desc: ToolDescriptor = {
        name: "test_perm",
        description: "Test permission",
        inputSchema: z.object({ msg: z.string() }).strict(),
        traits: { readOnly: true, destructive: false, concurrencySafe: true },
        permissions: [perm],
        async execute(input) {
          return `echo: ${(input as { msg: string }).msg}`;
        },
      };

      expect(Array.isArray(desc.permissions)).toBe(true);
      expect(desc.permissions).toHaveLength(1);
    });


  });

  describe("ctx.permissionOutcome", () => {
    function makeContext(
      overrides?: Partial<ToolExecutionContext>,
    ): ToolExecutionContext {
      const ac = new AbortController();
      return {
        store: { getState: () => ({ sessionId: "test-session" }) } as ToolExecutionContext["store"],
        toolName: "echo",
        toolCallId: "call-1",
        input: { msg: "hello" },
        step: 0,
        abort: ac.signal,
        startedAt: 0,
        allowedTools: new Set(["echo"]),
        workspaceRoot: "/tmp",
        ...overrides,
      };
    }

    function makeToolCall(
      overrides?: Partial<ToolCallLike>,
    ): ToolCallLike {
      return {
        toolCallId: "call-1",
        toolName: "echo",
        input: { msg: "hello" },
        ...overrides,
      };
    }

    test("permissionOutcome is set to 'allow' when all permissions allow", async () => {
      const desc: ToolDescriptor = {
        name: "echo",
        description: "Tool: echo",
        inputSchema: z.object({ msg: z.string() }).strict(),
        traits: { readOnly: true, destructive: false, concurrencySafe: true },
        permissions: [async () => ({ outcome: "allow" })],
        async execute(input) {
          return `echo: ${(input as { msg: string }).msg}`;
        },
      };
      registry.register(desc);
      registry.globalPermissions.push(async () => ({ outcome: "allow" }));

      const ctx = makeContext();
      await registry.execute(makeToolCall(), ctx);

      expect(ctx.permissionOutcome).toBe("allow");
    });

    test("permissionOutcome is set to 'deny' when a permission denies", async () => {
      const desc: ToolDescriptor = {
        name: "echo",
        description: "Tool: echo",
        inputSchema: z.object({ msg: z.string() }).strict(),
        traits: { readOnly: true, destructive: false, concurrencySafe: true },
        permissions: [async () => ({ outcome: "deny", reason: "blocked" })],
        async execute(input) {
          return `echo: ${(input as { msg: string }).msg}`;
        },
      };
      registry.register(desc);

      const ctx = makeContext();
      await registry.execute(makeToolCall(), ctx);

      expect(ctx.permissionOutcome).toBe("deny");
    });

    test("permissionOutcome is set to 'ask' when a permission asks", async () => {
      const desc: ToolDescriptor = {
        name: "echo",
        description: "Tool: echo",
        inputSchema: z.object({ msg: z.string() }).strict(),
        traits: { readOnly: true, destructive: false, concurrencySafe: true },
        permissions: [async () => ({ outcome: "ask", reason: "confirm?" })],
        async execute(input) {
          return `echo: ${(input as { msg: string }).msg}`;
        },
      };
      registry.register(desc);

      const ctx = makeContext();
      await registry.execute(makeToolCall(), ctx);

      expect(ctx.permissionOutcome).toBe("ask");
    });
  });

  describe("combinePermissionDecisions", () => {
    test("combinePermissionDecisions is exported from ./permission", async () => {
      const { combinePermissionDecisions } = await import("./permission");
      expect(typeof combinePermissionDecisions).toBe("function");

      const allow = combinePermissionDecisions([{ outcome: "allow" }]);
      expect(allow.outcome).toBe("allow");

      const deny = combinePermissionDecisions([
        { outcome: "allow" },
        { outcome: "deny", reason: "blocked" },
      ]);
      expect(deny.outcome).toBe("deny");

      const ask = combinePermissionDecisions([
        { outcome: "allow" },
        { outcome: "ask", reason: "confirm?" },
      ]);
      expect(ask.outcome).toBe("ask");
    });
  });
});
