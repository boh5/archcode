import { afterAll, describe, expect, mock, spyOn, test } from "bun:test";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { z } from "zod";

import { SkillService } from "../skills";
import { storeManager } from "../store/store";
import type { Logger } from "../logger";
import { createTestProjectContext } from "./test-project-context";
import { createTestToolRegistryFixture, type TestToolRegistryFixture } from "./test-registry";
import { expectBlockedOutcome, expectBlockedRequest, expectSettledResult } from "./test-results";
import { createTextToolResult } from "./results";
import { askUserTool } from "./builtins/ask-user";
import { createRegistry, ResolvedToolSet } from "./registry";
import {
  createToolExecutionContext,
  DestructiveToolPermissionError,
  DuplicateToolError,
  type ToolDescriptor,
  type ToolExecutionContext,
} from "./types";

const fixtures: TestToolRegistryFixture[] = [];
const skills = new SkillService({ builtinSkills: {} });
let workspaceIndex = 0;
const contextRoots: string[] = [];

afterAll(async () => {
  await Promise.all(fixtures.map((fixture) => fixture.dispose()));
  await Promise.all(contextRoots.map((root) => rm(root, { recursive: true, force: true })));
});

function fixture(options: Parameters<typeof createTestToolRegistryFixture>[0] = {}): TestToolRegistryFixture {
  const created = createTestToolRegistryFixture(options);
  fixtures.push(created);
  return created;
}

function context(
  toolName: string,
  effectfulAttempt: NonNullable<ToolExecutionContext["onToolAttempt"]> = mock(async () => undefined),
) {
  const workspaceRoot = join(tmpdir(), `archcode-registry-context-${workspaceIndex++}-${crypto.randomUUID()}`);
  contextRoots.push(workspaceRoot);
  mkdirSync(workspaceRoot, { recursive: true });
  const store = storeManager.create(`registry-${crypto.randomUUID()}`, workspaceRoot, { agentName: "engineer" });
  return createToolExecutionContext({
    store,
    storeManager,
    toolName,
    toolCallId: `${toolName}-${crypto.randomUUID()}`,
    input: {},
    step: 0,
    abort: new AbortController().signal,
    startedAt: Date.now(),
    allowedTools: new Set([toolName]),
    agentSkills: [],
    skillService: skills,
    projectContext: createTestProjectContext(workspaceRoot),
    cwd: workspaceRoot,
    onToolAttempt: effectfulAttempt,
  });
}

function descriptor(overrides: Partial<ToolDescriptor> = {}): ToolDescriptor {
  return {
    name: "echo",
    description: "echo",
    inputSchema: z.object({}).strict(),
    outputPolicy: { kind: "inline", previewDirection: "head" },
    traits: { readOnly: true, destructive: false, concurrencySafe: true },
    execute: async () => ({ isError: false, draft: { kind: "text", text: "ok" } }),
    ...overrides,
  };
}

describe("ToolRegistry hard-cut lifecycle", () => {
  test("blocked permission calls execute/finalize zero times", async () => {
    const execute = mock(async () => ({ isError: false, draft: { kind: "text" as const, text: "forbidden" } }));
    const created = fixture({
      descriptors: [descriptor({
        permissions: [async () => ({ outcome: "ask", reason: "approval required" })],
        execute,
      })],
    });
    const finalized = mock(async () => undefined);
    created.registry.globalHooks.finalized.push(finalized);
    const ctx = context("echo");

    const outcome = await created.registry.execute(
      { toolName: "echo", toolCallId: ctx.toolCallId, input: {} },
      ctx,
    );

    expect(outcome.kind).toBe("blocked");
    expect(execute).not.toHaveBeenCalled();
    expect(finalized).not.toHaveBeenCalled();
  });

  test("settled calls finalize and run finalized hooks exactly once", async () => {
    const created = fixture({ descriptors: [descriptor()] });
    const finalized = mock(async () => undefined);
    created.registry.globalHooks.finalized.push(finalized);
    const ctx = context("echo");

    const outcome = await created.registry.execute(
      { toolName: "echo", toolCallId: ctx.toolCallId, input: {} },
      ctx,
    );

    expect(outcome.kind).toBe("settled");
    expect(outcome.kind === "settled" ? outcome.result.output.preview : "").toBe("ok");
    expect(finalized).toHaveBeenCalledTimes(1);
  });

  test("creates artifact capture before effectful execute", async () => {
    let captureWasPresent = false;
    const attempt = mock(async () => undefined);
    const created = fixture({
      descriptors: [descriptor({
        outputPolicy: { kind: "artifact", previewDirection: "head-tail" },
        traits: { readOnly: false, destructive: false, concurrencySafe: false },
        execute: async (_input, ctx) => {
          captureWasPresent = ctx.outputCapture !== undefined;
          await ctx.outputCapture?.write("captured output");
          return { isError: false, draft: { kind: "capture" } };
        },
      })],
    });
    await created.artifactStore.ready();
    const ctx = context("echo", attempt);
    const outcome = await created.registry.execute(
      { toolName: "echo", toolCallId: ctx.toolCallId, input: {} },
      ctx,
    );

    expect(captureWasPresent).toBe(true);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(outcome.kind === "settled" ? outcome.result.output.preview : "").toBe("captured output");
  });

  test("distinguishes pre-attempt capture failure from post-attempt finalizer failure", async () => {
    const created = fixture({
      descriptors: [descriptor({
        outputPolicy: { kind: "artifact", previewDirection: "head-tail" },
        traits: { readOnly: false, destructive: false, concurrencySafe: false },
      })],
    });
    const attempt = mock(async () => undefined);
    const beginCapture = spyOn(created.finalizer, "beginCapture").mockRejectedValueOnce(new Error("sink failed"));
    const firstCtx = context("echo", attempt);
    const beforeAttempt = await created.registry.execute(
      { toolName: "echo", toolCallId: firstCtx.toolCallId, input: {} },
      firstCtx,
    );
    expect(attempt).not.toHaveBeenCalled();
    expect(beforeAttempt.kind === "settled" ? beforeAttempt.result.details?.unknownResult : true).toBeUndefined();
    beginCapture.mockRestore();

    const finalize = spyOn(created.finalizer, "finalize").mockRejectedValueOnce(new Error("finalizer failed"));
    const secondCtx = context("echo", attempt);
    const afterAttempt = await created.registry.execute(
      { toolName: "echo", toolCallId: secondCtx.toolCallId, input: {} },
      secondCtx,
    );
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(afterAttempt.kind === "settled" ? afterAttempt.result.details?.unknownResult : false).toBe(true);
    finalize.mockRestore();
  });

  test("redacts raw exceptions before finalized output or logs", async () => {
    const secret = "runtime-literal-secret";
    const logFields: unknown[] = [];
    const logger: Logger = {
      debug: (_event, fields) => logFields.push(fields),
      info: (_event, fields) => logFields.push(fields),
      warn: (_event, fields) => logFields.push(fields),
      error: (_event, fields) => logFields.push(fields),
      child: () => logger,
    };
    const created = fixture({
      logger,
      secretLiterals: [secret],
      descriptors: [descriptor({ execute: async () => { throw new Error(`boom ${secret}`); } })],
    });
    const ctx = context("echo");
    const outcome = await created.registry.execute(
      { toolName: "echo", toolCallId: ctx.toolCallId, input: {} },
      ctx,
    );
    const serialized = JSON.stringify({ outcome, logFields });
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain("[REDACTED:SECRET]");
  });
});

describe("ToolRegistry registration and resolution", () => {
  test("registers and retrieves one descriptor", () => {
    const created = fixture();
    const tool = descriptor();
    created.registry.register(tool);
    expect(created.registry.get("echo")).toBe(tool);
  });

  test("rejects duplicate names", () => {
    const created = fixture({ descriptors: [descriptor()] });
    expect(() => created.registry.register(descriptor())).toThrow(DuplicateToolError);
  });

  test("rejects destructive descriptors without permission policy", () => {
    const created = fixture();
    const tool = descriptor({ traits: { readOnly: false, destructive: true, concurrencySafe: false } });
    expect(() => created.registry.register(tool)).toThrow(DestructiveToolPermissionError);
  });

  test("accepts destructive descriptors with a permission policy", () => {
    const created = fixture();
    const tool = descriptor({
      name: "delete",
      traits: { readOnly: false, destructive: true, concurrencySafe: false },
      permissions: [async () => ({ outcome: "allow" })],
    });
    created.registry.register(tool);
    expect(created.registry.get("delete")).toBe(tool);
  });

  test("registerAll and getAll preserve registration order", () => {
    const created = fixture();
    const tools = [descriptor({ name: "first" }), descriptor({ name: "second" })];
    created.registry.registerAll(tools);
    expect(created.registry.getAll()).toEqual(tools);
  });

  test("listByPrefix returns only matching descriptors in order", () => {
    const created = fixture({
      descriptors: [descriptor({ name: "mcp__docs__read" }), descriptor({ name: "file_read" }), descriptor({ name: "mcp__docs__find" })],
    });
    expect(created.registry.listByPrefix("mcp__docs__").map(({ name }) => name)).toEqual([
      "mcp__docs__read",
      "mcp__docs__find",
    ]);
    expect(created.registry.listByPrefix("missing")).toEqual([]);
  });

  test("resolveForAgent handles missing, empty, and ordered names", () => {
    const created = fixture({ descriptors: [descriptor({ name: "one" }), descriptor({ name: "two" })] });
    expect(created.registry.resolveForAgent().descriptors).toEqual([]);
    expect(created.registry.resolveForAgent([]).descriptors).toEqual([]);
    expect(created.registry.resolveForAgent(["two", "one"]).descriptors.map(({ name }) => name)).toEqual(["two", "one"]);
  });

  test("resolveForAgent warns and omits unknown names", () => {
    const warnings: unknown[] = [];
    const logger: Logger = {
      debug: () => {}, info: () => {}, error: () => {},
      warn: (event, fields) => warnings.push({ event, fields }),
      child: () => logger,
    };
    const created = fixture({ logger, descriptors: [descriptor()] });
    expect(created.registry.resolveForAgent(["missing", "echo"]).descriptors.map(({ name }) => name)).toEqual(["echo"]);
    expect(warnings).toEqual([expect.objectContaining({ event: "tool.resolve.unknown" })]);
  });

  test("ResolvedToolSet exposes descriptors and model-visible schemas only", () => {
    const aiInputSchema = z.object({ query: z.string() });
    const tool = descriptor({ aiInputSchema });
    const resolved = new ResolvedToolSet([tool]);
    expect(resolved.has("echo")).toBe(true);
    expect(resolved.has("missing")).toBe(false);
    expect(resolved.get("echo")).toBe(tool);
    expect(resolved.get("missing")).toBeUndefined();
    expect(resolved.toAITools()).toEqual({ echo: { description: "echo", inputSchema: aiInputSchema } });
    expect("execute" in resolved.toAITools().echo).toBe(false);
  });

  test("ResolvedToolSet falls back to the runtime input schema", () => {
    const tool = descriptor();
    expect(new ResolvedToolSet([tool]).toAITools().echo.inputSchema).toBe(tool.inputSchema);
  });

  test("createRegistry registers initial descriptors", () => {
    const backing = fixture();
    const tool = descriptor();
    const registry = createRegistry({ finalizer: backing.finalizer, hitlCodec: backing.hitlCodec }, [tool]);
    expect(registry.getAll()).toEqual([tool]);
    expect(registry.globalHooks).toEqual({ before: [], finalized: [] });
    expect(registry.globalPermissions).toEqual([]);
  });
});

describe("ToolRegistry strict execution pipeline", () => {
  test("unknown tools settle as TOOL_UNKNOWN without throwing", async () => {
    const created = fixture();
    const result = expectSettledResult(await created.registry.execute(
      { toolName: "missing", toolCallId: "missing-call", input: {} },
      context("missing"),
    ));
    expect(result.isError).toBe(true);
    expect(result.details?.error?.code).toBe("TOOL_UNKNOWN");
  });

  test("schema failures settle before descriptor execution", async () => {
    const execute = mock(async () => createTextToolResult("unreachable"));
    const created = fixture({ descriptors: [descriptor({ inputSchema: z.object({ value: z.string() }).strict(), execute })] });
    const result = expectSettledResult(await created.registry.execute(
      { toolName: "echo", toolCallId: "schema-call", input: { value: 1 } },
      context("echo"),
    ));
    expect(result.details?.error?.code).toBe("TOOL_SCHEMA_INVALID_INPUT");
    expect(execute).not.toHaveBeenCalled();
  });

  test("successful execution returns a finalized result", async () => {
    const created = fixture({ descriptors: [descriptor()] });
    const result = expectSettledResult(await created.registry.execute(
      { toolName: "echo", toolCallId: "success-call", input: {} },
      context("echo"),
    ));
    expect(result).toMatchObject({ isError: false, output: { preview: "ok", completeness: "complete" } });
  });

  test("executor exceptions become redacted settled errors", async () => {
    const created = fixture({ descriptors: [descriptor({ execute: async () => { throw new Error("boom"); } })] });
    const result = expectSettledResult(await created.registry.execute(
      { toolName: "echo", toolCallId: "throw-call", input: {} },
      context("echo"),
    ));
    expect(result.isError).toBe(true);
    expect(result.details?.error?.kind).toBe("execution");
    expect(result.output.preview).toContain("boom");
  });

  test("prepareInput runs before schema parsing and updates resolved input", async () => {
    let received: unknown;
    const created = fixture({ descriptors: [descriptor({
      inputSchema: z.object({ value: z.string() }).strict(),
      prepareInput: () => ({ value: "prepared" }),
      execute: async (input) => { received = input; return createTextToolResult("ok"); },
    })] });
    await created.registry.execute({ toolName: "echo", toolCallId: "prepare-call", input: null }, context("echo"));
    expect(received).toEqual({ value: "prepared" });
  });

  test("prepareInput exceptions settle as TOOL_PREPARE_INPUT_FAILED", async () => {
    const created = fixture({ descriptors: [descriptor({ prepareInput: () => { throw new Error("prepare failed"); } })] });
    const result = expectSettledResult(await created.registry.execute(
      { toolName: "echo", toolCallId: "prepare-fail", input: {} }, context("echo"),
    ));
    expect(result.details?.error?.code).toBe("TOOL_PREPARE_INPUT_FAILED");
  });

  test("global and descriptor before hooks mutate and re-parse input", async () => {
    let received: unknown;
    const created = fixture({ descriptors: [descriptor({
      inputSchema: z.object({ value: z.string() }).strict(),
      hooks: { before: [(input) => ({ value: `${(input as { value: string }).value}-tool` })] },
      execute: async (input) => { received = input; return createTextToolResult("ok"); },
    })] });
    created.registry.globalHooks.before.push(() => ({ value: "global" }));
    await created.registry.execute({ toolName: "echo", toolCallId: "before-call", input: { value: "initial" } }, context("echo"));
    expect(received).toEqual({ value: "global-tool" });
  });

  test("invalid before-hook mutation settles as TOOL_BEFORE_HOOK_INVALID_INPUT", async () => {
    const created = fixture({ descriptors: [descriptor({
      inputSchema: z.object({ value: z.string() }).strict(),
      hooks: { before: [() => ({ value: 1 })] },
    })] });
    const result = expectSettledResult(await created.registry.execute(
      { toolName: "echo", toolCallId: "before-invalid", input: { value: "ok" } }, context("echo"),
    ));
    expect(result.details?.error?.code).toBe("TOOL_BEFORE_HOOK_INVALID_INPUT");
  });

  test("descriptor after hooks mutate Raw results before finalization", async () => {
    const created = fixture({ descriptors: [descriptor({
      hooks: { after: [(result) => ({ ...result, draft: { kind: "text", text: "after" } })] },
    })] });
    const result = expectSettledResult(await created.registry.execute(
      { toolName: "echo", toolCallId: "after-call", input: {} }, context("echo"),
    ));
    expect(result.output.preview).toBe("after");
  });

  test("after-hook exceptions settle with unknownResult after effectful execution", async () => {
    const created = fixture({ descriptors: [descriptor({
      traits: { readOnly: false, destructive: false, concurrencySafe: false },
      hooks: { after: [() => { throw new Error("after failed"); }] },
    })] });
    const result = expectSettledResult(await created.registry.execute(
      { toolName: "echo", toolCallId: "after-fail", input: {} }, context("echo"),
    ));
    expect(result.details?.error?.kind).toBe("after-hook");
    expect(result.details?.unknownResult).toBe(true);
  });

  test("pipeline ordering is global before, tool before, execute, tool after, finalized", async () => {
    const order: string[] = [];
    const created = fixture({ descriptors: [descriptor({
      hooks: {
        before: [() => { order.push("tool-before"); }],
        after: [() => { order.push("tool-after"); }],
      },
      execute: async () => { order.push("execute"); return createTextToolResult("ok"); },
    })] });
    created.registry.globalHooks.before.push(() => { order.push("global-before"); });
    created.registry.globalHooks.finalized.push(() => { order.push("finalized"); });
    await created.registry.execute({ toolName: "echo", toolCallId: "order-call", input: {} }, context("echo"));
    expect(order).toEqual(["global-before", "tool-before", "execute", "tool-after", "finalized"]);
  });

  test("execution context receives call identity, parsed input, traits, and original abort signal", async () => {
    let observed: ToolExecutionContext | undefined;
    const controller = new AbortController();
    const created = fixture({ descriptors: [descriptor({ execute: async (_input, ctx) => { observed = ctx; return createTextToolResult("ok"); } })] });
    const ctx = context("echo");
    ctx.abort = controller.signal;
    await created.registry.execute({ toolName: "echo", toolCallId: "identity-call", input: {} }, ctx);
    expect(observed).toBe(ctx);
    expect(observed).toMatchObject({ toolName: "echo", toolCallId: "identity-call", input: {}, toolTraits: descriptor().traits });
    expect(observed?.abort).toBe(controller.signal);
  });

  test("registered but disallowed tools settle before permissions and execution", async () => {
    const permission = mock(async () => ({ outcome: "allow" as const }));
    const execute = mock(async () => createTextToolResult("unreachable"));
    const created = fixture({ descriptors: [descriptor({ permissions: [permission], execute })] });
    const ctx = context("echo");
    ctx.allowedTools = new Set();
    const result = expectSettledResult(await created.registry.execute(
      { toolName: "echo", toolCallId: "disallowed-call", input: {} }, ctx,
    ));
    expect(result.details?.error?.code).toBe("TOOL_NOT_ALLOWED");
    expect(permission).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("ToolRegistry permission and durable HITL boundary", () => {
  test("global permissions run before descriptor permissions", async () => {
    const order: string[] = [];
    const created = fixture({ descriptors: [descriptor({ permissions: [async () => { order.push("tool"); return { outcome: "allow" }; }] })] });
    created.registry.globalPermissions.push(async () => { order.push("global"); return { outcome: "allow" }; });
    await created.registry.execute({ toolName: "echo", toolCallId: "permission-order", input: {} }, context("echo"));
    expect(order).toEqual(["global", "tool"]);
  });

  test("permission deny runs after input hooks, skips execution, and preserves structured kind/code", async () => {
    const before = mock(async () => undefined);
    const execute = mock(async () => createTextToolResult("unreachable"));
    const created = fixture({ descriptors: [descriptor({
      permissions: [async () => ({ outcome: "deny", reason: "blocked", errorKind: "workspace", errorCode: "PATH_OUTSIDE_WORKSPACE" })],
      hooks: { before: [before] }, execute,
    })] });
    const ctx = context("echo");
    const result = expectSettledResult(await created.registry.execute(
      { toolName: "echo", toolCallId: "deny-call", input: {} }, ctx,
    ));
    expect(result.details?.error).toMatchObject({ kind: "workspace", code: "PATH_OUTSIDE_WORKSPACE" });
    expect(ctx.permissionOutcome).toBe("deny");
    expect(before).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });

  test("ask creates a redacted blocked request with a stable fingerprint", async () => {
    const created = fixture({ descriptors: [descriptor({ permissions: [async () => ({
      outcome: "ask",
      reason: "approval needed",
      approval: { eligible: false, display: "Echo", reason: "Approval needed" },
    })] })] });
    const ctx = context("echo");
    const first = expectBlockedRequest(await created.registry.execute(
      { toolName: "echo", toolCallId: ctx.toolCallId, input: {} }, ctx,
    ));
    expect(first.source).toEqual({ type: "tool_permission", toolCallId: ctx.toolCallId, toolName: "echo" });
    expect("permissionFingerprint" in first && first.permissionFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(first.displayPayload.redacted).toBe(true);
    expect(ctx.permissionOutcome).toBe("ask");
  });

  test("approve_once resumes the exact blocked call and executes once", async () => {
    const execute = mock(async () => createTextToolResult("approved"));
    const created = fixture({ descriptors: [descriptor({
      permissions: [async () => ({ outcome: "ask", approval: { eligible: false, display: "Echo", reason: "Approve" } })],
      execute,
    })] });
    const ctx = context("echo");
    const toolCall = { toolName: "echo", toolCallId: ctx.toolCallId, input: {} };
    const blocked = expectBlockedOutcome(await created.registry.execute(toolCall, ctx));
    const result = expectSettledResult(await created.registry.resumeBlocked({
      toolCall,
      request: blocked.request,
      requestKey: blocked.requestKey,
      response: { type: "permission_decision", decision: "approve_once" },
      context: ctx,
    }));
    expect(result.output.preview).toBe("approved");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(ctx.permissionOutcome).toBe("allow");
  });

  test("deny response settles without executing", async () => {
    const execute = mock(async () => createTextToolResult("unreachable"));
    const created = fixture({ descriptors: [descriptor({ permissions: [async () => ({ outcome: "ask" })], execute })] });
    const ctx = context("echo");
    const toolCall = { toolName: "echo", toolCallId: ctx.toolCallId, input: {} };
    const blocked = expectBlockedOutcome(await created.registry.execute(toolCall, ctx));
    const result = expectSettledResult(await created.registry.resumeBlocked({
      toolCall,
      request: blocked.request,
      requestKey: blocked.requestKey,
      response: { type: "permission_decision", decision: "deny" },
      context: ctx,
    }));
    expect(result.details?.error?.code).toBe("TOOL_PERMISSION_CONFIRMATION_DENIED");
    expect(execute).not.toHaveBeenCalled();
  });

  test("validateBlockedResponse rejects mismatched response shapes", async () => {
    const created = fixture({ descriptors: [descriptor({ permissions: [async () => ({ outcome: "ask" })] })] });
    const ctx = context("echo");
    const request = expectBlockedRequest(await created.registry.execute(
      { toolName: "echo", toolCallId: ctx.toolCallId, input: {} }, ctx,
    ));
    expect(() => created.registry.validateBlockedResponse(request, { type: "question_answer", answers: ["yes"] })).toThrow();
    expect(created.registry.validateBlockedResponse(request, { type: "permission_decision", decision: "approve_once" })).toEqual({ type: "permission_decision", decision: "approve_once" });
  });

  test("cancel response settles as TOOL_CANCELLED", async () => {
    const created = fixture({ descriptors: [descriptor({ permissions: [async () => ({ outcome: "ask" })] })] });
    const ctx = context("echo");
    const toolCall = { toolName: "echo", toolCallId: ctx.toolCallId, input: {} };
    const blocked = expectBlockedOutcome(await created.registry.execute(toolCall, ctx));
    const result = expectSettledResult(await created.registry.resumeBlocked({
      toolCall,
      request: blocked.request,
      requestKey: blocked.requestKey,
      response: { type: "cancel", reason: "stop" },
      context: ctx,
    }));
    expect(result.details?.error?.code).toBe("TOOL_CANCELLED");
  });

  test("permission exceptions settle as permission-denied without execution", async () => {
    const execute = mock(async () => createTextToolResult("unreachable"));
    const created = fixture({ descriptors: [descriptor({
      permissions: [async () => { throw new Error("policy failed"); }], execute,
    })] });
    const result = expectSettledResult(await created.registry.execute(
      { toolName: "echo", toolCallId: "policy-throw", input: {} }, context("echo"),
    ));
    expect(result.details?.error?.kind).toBe("permission-denied");
    expect(execute).not.toHaveBeenCalled();
  });

  test("oversize permission requests settle once without executing", async () => {
    const execute = mock(async () => createTextToolResult("unreachable"));
    const created = fixture({ descriptors: [descriptor({
      description: "ordinary description words ".repeat(220),
      permissions: [async () => ({ outcome: "ask", reason: "approve" })],
      execute,
    })] });
    const finalized = mock(async () => undefined);
    created.registry.globalHooks.finalized.push(finalized);

    const result = expectSettledResult(await created.registry.execute(
      { toolName: "echo", toolCallId: "oversize-permission", input: {} },
      context("echo"),
    ));

    expect(result.isError).toBe(true);
    expect(result.details?.error?.kind).toBe("permission-denied");
    expect(finalized).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });

  test("approval lookup and persistence failures settle once without escaping", async () => {
    const scope = { kind: "tool-operation" as const, toolName: "echo", operation: "run", target: "fixture" };
    const permission = async () => ({
      outcome: "ask" as const,
      approval: { eligible: true as const, scope, display: "Run echo", reason: "Approve" },
    });

    const lookupFixture = fixture({ descriptors: [descriptor({ permissions: [permission] })] });
    const lookupContext = context("echo");
    const lookupFinalized = mock(async () => undefined);
    lookupFixture.registry.globalHooks.finalized.push(lookupFinalized);
    const hasApproval = spyOn(lookupContext.projectContext.approvals, "hasApproval")
      .mockImplementation(() => { throw new Error("lookup-secret"); });
    const lookupResult = expectSettledResult(await lookupFixture.registry.execute(
      { toolName: "echo", toolCallId: lookupContext.toolCallId, input: {} },
      lookupContext,
    ));
    expect(lookupResult.details?.error?.kind).toBe("permission-denied");
    expect(lookupFinalized).toHaveBeenCalledTimes(1);
    hasApproval.mockRestore();

    const persistFixture = fixture({ descriptors: [descriptor({ permissions: [permission] })] });
    const persistContext = context("echo");
    const toolCall = { toolName: "echo", toolCallId: persistContext.toolCallId, input: {} };
    const blocked = expectBlockedOutcome(await persistFixture.registry.execute(toolCall, persistContext));
    const persistFinalized = mock(async () => undefined);
    persistFixture.registry.globalHooks.finalized.push(persistFinalized);
    const addApproval = spyOn(persistContext.projectContext.approvals, "addApproval")
      .mockRejectedValue(new Error("persist-secret"));
    const persistResult = expectSettledResult(await persistFixture.registry.resumeBlocked({
      toolCall,
      request: blocked.request,
      requestKey: blocked.requestKey,
      response: { type: "permission_decision", decision: "approve_always" },
      context: persistContext,
    }));
    expect(persistResult.details?.error?.kind).toBe("permission-denied");
    expect(persistFinalized).toHaveBeenCalledTimes(1);
    addApproval.mockRestore();
  });

  test("approve_always is rejected for an ineligible request", async () => {
    const created = fixture({ descriptors: [descriptor({ permissions: [async () => ({ outcome: "ask" })] })] });
    const ctx = context("echo");
    const toolCall = { toolName: "echo", toolCallId: ctx.toolCallId, input: {} };
    const blocked = expectBlockedOutcome(await created.registry.execute(toolCall, ctx));
    const result = expectSettledResult(await created.registry.resumeBlocked({
      toolCall,
      request: blocked.request,
      requestKey: blocked.requestKey,
      response: { type: "permission_decision", decision: "approve_always" },
      context: ctx,
    }));
    expect(result.details?.error?.code).toBe("TOOL_PERMISSION_CONFIRMATION_DENIED");
  });

  test("approve_always persists an exact eligible scope and satisfies future asks", async () => {
    const scope = { kind: "tool-operation" as const, toolName: "echo", operation: "run", target: "fixture" };
    const execute = mock(async () => createTextToolResult("approved"));
    const created = fixture({ descriptors: [descriptor({
      permissions: [async () => ({
        outcome: "ask",
        approval: { eligible: true, scope, display: "Run echo", reason: "Fixture approval" },
      })],
      execute,
    })] });
    const ctx = context("echo");
    await ctx.projectContext.approvals.load(ctx.projectContext.project.workspaceRoot);
    const toolCall = { toolName: "echo", toolCallId: ctx.toolCallId, input: {} };
    const blocked = expectBlockedOutcome(await created.registry.execute(toolCall, ctx));
    expectSettledResult(await created.registry.resumeBlocked({
      toolCall,
      request: blocked.request,
      requestKey: blocked.requestKey,
      response: { type: "permission_decision", decision: "approve_always" },
      context: ctx,
    }));
    expect(ctx.projectContext.approvals.hasApproval(scope)).toBe(true);
    const second = expectSettledResult(await created.registry.execute(toolCall, ctx));
    expect(second.output.preview).toBe("approved");
    expect(execute).toHaveBeenCalledTimes(2);
  });

  test("deny execution control leaves persistence through the runtime-only sidecar", async () => {
    const created = fixture({ descriptors: [descriptor({ permissions: [async () => ({
      outcome: "deny",
      reason: "stop",
      executionControl: { action: "stop_session_family", reason: "goal_cancelled" },
    })] })] });
    const outcome = await created.registry.execute(
      { toolName: "echo", toolCallId: "sidecar-deny", input: {} }, context("echo"),
    );
    expect(outcome.kind).toBe("settled");
    expect(outcome.kind === "settled" ? outcome.sidecar : undefined).toEqual({
      executionControl: { action: "stop_session_family", reason: "goal_cancelled" },
    });
  });

  test("resumeBlocked rejects a request belonging to another call", async () => {
    const created = fixture({ descriptors: [descriptor({ permissions: [async () => ({ outcome: "ask" })] })] });
    const ctx = context("echo");
    const toolCall = { toolName: "echo", toolCallId: ctx.toolCallId, input: {} };
    const blocked = expectBlockedOutcome(await created.registry.execute(toolCall, ctx));
    const result = expectSettledResult(await created.registry.resumeBlocked({
      toolCall: { ...toolCall, toolCallId: "different-call" },
      request: blocked.request,
      requestKey: blocked.requestKey,
      response: { type: "permission_decision", decision: "approve_once" },
      context: ctx,
    }));
    expect(result.details?.error?.code).toBe("TOOL_BLOCKED_RESPONSE_INVALID");
  });

  test("invalid resume request, response, and requestKey each settle as a bounded error", async () => {
    const created = fixture({ descriptors: [descriptor({ permissions: [async () => ({ outcome: "ask" })] })] });
    const ctx = context("echo");
    const toolCall = { toolName: "echo", toolCallId: ctx.toolCallId, input: {} };
    const blocked = expectBlockedOutcome(await created.registry.execute(toolCall, ctx));

    for (const input of [
      {
        request: { ...blocked.request, displayPayload: { ...blocked.request.displayPayload, redacted: false } } as any,
        requestKey: blocked.requestKey,
        response: { type: "permission_decision", decision: "approve_once" },
      },
      {
        request: blocked.request,
        requestKey: blocked.requestKey,
        response: { type: "question_answer", answers: ["yes"] },
      },
      {
        request: blocked.request,
        requestKey: "tool:wrong",
        response: { type: "permission_decision", decision: "approve_once" },
      },
    ]) {
      const result = expectSettledResult(await created.registry.resumeBlocked({
        toolCall,
        request: input.request,
        requestKey: input.requestKey,
        response: input.response,
        context: ctx,
      }));
      expect(result.details?.error?.code).toBe("TOOL_BLOCKED_RESPONSE_INVALID");
      expect(new TextEncoder().encode(result.output.preview).byteLength).toBeLessThan(50 * 1024);
    }
  });

  test("recomputed keys cannot authorize tampered permission or ask-user requests", async () => {
    const execute = mock(async () => createTextToolResult("unreachable"));
    const permissionFixture = fixture({ descriptors: [descriptor({
      permissions: [async () => ({ outcome: "ask", reason: "Approve" })],
      execute,
    })] });
    const permissionContext = context("echo");
    const permissionCall = { toolName: "echo", toolCallId: permissionContext.toolCallId, input: {} };
    const permissionBlocked = expectBlockedOutcome(await permissionFixture.registry.execute(permissionCall, permissionContext));
    if (permissionBlocked.request.source.type !== "tool_permission") throw new Error("Expected permission request");
    const tamperedPermission = {
      ...permissionBlocked.request,
      displayPayload: { ...permissionBlocked.request.displayPayload, title: "Tampered permission" },
    };
    const tamperedPermissionKey = permissionFixture.hitlCodec.createToolRequestKey({
      sessionId: permissionContext.store.getState().sessionId,
      toolCallId: permissionCall.toolCallId,
      toolName: permissionCall.toolName,
      request: tamperedPermission,
    });
    const permissionResult = expectSettledResult(await permissionFixture.registry.resumeBlocked({
      toolCall: permissionCall,
      request: tamperedPermission,
      requestKey: tamperedPermissionKey,
      response: { type: "permission_decision", decision: "approve_once" },
      context: permissionContext,
    }));
    expect(permissionResult.details?.error?.code).toBe("TOOL_BLOCKED_RESPONSE_INVALID");
    expect(execute).not.toHaveBeenCalled();

    const askFixture = fixture({ descriptors: [askUserTool] });
    const askContext = context("ask_user");
    const askCall = {
      toolName: "ask_user",
      toolCallId: askContext.toolCallId,
      input: { questions: [{ question: "Continue?", header: "Decision", options: [], custom: true }] },
    };
    const askBlocked = expectBlockedOutcome(await askFixture.registry.execute(askCall, askContext));
    if (askBlocked.request.source.type !== "ask_user") throw new Error("Expected ask-user request");
    const tamperedAsk = {
      ...askBlocked.request,
      displayPayload: { ...askBlocked.request.displayPayload, summary: "Tampered question" },
    };
    const tamperedAskKey = askFixture.hitlCodec.createToolRequestKey({
      sessionId: askContext.store.getState().sessionId,
      toolCallId: askCall.toolCallId,
      toolName: askCall.toolName,
      request: tamperedAsk,
    });
    const askResult = expectSettledResult(await askFixture.registry.resumeBlocked({
      toolCall: askCall,
      request: tamperedAsk,
      requestKey: tamperedAskKey,
      response: { type: "question_answer", answers: ["Yes"] },
      context: askContext,
    }));
    expect(askResult.details?.error?.code).toBe("TOOL_BLOCKED_RESPONSE_INVALID");
  });
});

describe("ToolRegistry current lifecycle callbacks", () => {
  test("onInputResolved receives the redacted parsed input", async () => {
    const secret = "runtime-secret-value";
    const created = fixture({ secretLiterals: [secret], descriptors: [descriptor({
      inputSchema: z.object({ value: z.string() }).strict(),
    })] });
    const onInputResolved = mock(() => undefined);
    const ctx = context("echo");
    ctx.onInputResolved = onInputResolved;
    await created.registry.execute(
      { toolName: "echo", toolCallId: "resolved-input", input: { value: secret } }, ctx,
    );
    expect(onInputResolved).toHaveBeenCalledWith({ value: "[REDACTED:SECRET]" });
  });

  test("effectful attempt recording is awaited before execute", async () => {
    const order: string[] = [];
    const created = fixture({ descriptors: [descriptor({
      traits: { readOnly: false, destructive: false, concurrencySafe: false },
      execute: async () => { order.push("execute"); return createTextToolResult("ok"); },
    })] });
    const ctx = context("echo", async () => { await Bun.sleep(1); order.push("attempt"); });
    await created.registry.execute({ toolName: "echo", toolCallId: "attempt-call", input: {} }, ctx);
    expect(order).toEqual(["attempt", "execute"]);
  });

  test("read-only descriptors do not record an effectful attempt", async () => {
    const attempt = mock(async () => undefined);
    const created = fixture({ descriptors: [descriptor()] });
    await created.registry.execute(
      { toolName: "echo", toolCallId: "read-call", input: {} }, context("echo", attempt),
    );
    expect(attempt).not.toHaveBeenCalled();
  });

  test("a failing finalized hook cannot prevent later finalized hooks", async () => {
    const order: string[] = [];
    const created = fixture({ descriptors: [descriptor()] });
    created.registry.globalHooks.finalized.push(() => { order.push("first"); throw new Error("hook failed"); });
    created.registry.globalHooks.finalized.push(() => { order.push("second"); });
    const result = expectSettledResult(await created.registry.execute(
      { toolName: "echo", toolCallId: "finalized-hooks", input: {} }, context("echo"),
    ));
    expect(result.output.preview).toBe("ok");
    expect(order).toEqual(["first", "second"]);
  });

  test("settleSystem finalizes strict Raw text and runs finalized hooks", async () => {
    const finalized = mock(async () => undefined);
    const created = fixture();
    created.registry.globalHooks.finalized.push(finalized);
    const settled = await created.registry.settleSystem(
      { toolName: "system", toolCallId: "system-call", input: {} },
      context("system"),
      createTextToolResult("system output"),
    );
    expect(settled.result.output.preview).toBe("system output");
    expect(finalized).toHaveBeenCalledTimes(1);
  });
});
