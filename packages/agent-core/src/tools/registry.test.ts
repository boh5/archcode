import { afterAll, describe, expect, mock, spyOn, test } from "bun:test";
import { MAX_EVENTS } from "@archcode/protocol";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { z } from "zod";

import { SkillService } from "../skills";
import { storeManager } from "../store/store";
import { createMockStore } from "../store/test-helpers";
import { LiveToolOutputPublisher } from "../tool-output/live-publisher";
import type { Logger } from "../logger";
import { createTestProjectContext } from "./test-project-context";
import { createTestToolRegistryFixture, type TestToolRegistryFixture } from "./test-registry";
import { deferTestApprovalReviewer } from "./test-approval-reviewer";
import { expectBlockedOutcome, expectBlockedRequest, expectSettledResult } from "./test-results";
import { createTextToolResult } from "./results";
import { askUserTool } from "./builtins/ask-user";
import { TOOL_SEARCH_REDACTED_QUERY, toolSearchTool } from "./builtins/tool-search";
import { createAuditHook, type AuditEvent } from "./hooks/audit";
import { createRegistry, ResolvedToolSet } from "./registry";
import {
  createToolExecutionContext,
  DestructiveToolPermissionError,
  DuplicateToolError,
  type AnyToolDescriptor,
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
  const store = storeManager.create(`registry-${crypto.randomUUID()}`, workspaceRoot, { source: { kind: "direct" }, agentName: "lead" });
  return createToolExecutionContext({
    store,
    storeManager,
    toolName,
    toolCallId: `${toolName}-${crypto.randomUUID()}`,
    input: {},
    step: 0,
    executionId: "execution-1",
    runOrdinal: 0,
    toolBatchId: "batch-1",
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

function descriptor(overrides: Partial<AnyToolDescriptor> = {}): AnyToolDescriptor {
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

describe("ToolRegistry lifecycle", () => {
  test("defers a synchronous child without finalization and settles it once after terminal", async () => {
    const ctx = context("delegate");
    const dependency = {
      parentExecutionId: ctx.executionId,
      runOrdinal: ctx.runOrdinal,
      toolBatchId: ctx.toolBatchId,
      toolCallId: ctx.toolCallId,
      childSessionId: "child-session",
      childExecutionId: "child-execution",
    };
    const created = fixture({
      descriptors: [descriptor({
        name: "delegate",
        execute: async () => ({ kind: "child_deferred" as const, dependency }),
        resumeChildDependency: async () => createTextToolResult("child done"),
      })],
    });
    const finalized = mock(async () => undefined);
    created.registry.globalHooks.finalized.push(finalized);
    const toolCall = { toolName: "delegate", toolCallId: ctx.toolCallId, input: {} };

    expect(await created.registry.execute(toolCall, ctx)).toEqual({
      kind: "child_deferred",
      dependency,
    });
    expect(finalized).toHaveBeenCalledTimes(0);

    const resumed = await created.registry.resumeChildDependency({
      toolCall,
      dependency,
      outcome: {
        outcome: "terminal",
        executionId: dependency.childExecutionId,
        executionStatus: "completed",
        output: "child done",
      },
      context: { ...ctx, runOrdinal: ctx.runOrdinal + 1 },
    });
    expect(expectSettledResult(resumed).output.preview).toContain("child done");
    expect(finalized).toHaveBeenCalledTimes(1);
  });

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

  test("audits prepared safe input when a registered tool is disallowed", async () => {
    const events: AuditEvent[] = [];
    const created = fixture({ descriptors: [toolSearchTool] });
    created.registry.globalHooks.finalized.push(createAuditHook({
      sink: (event) => { events.push(event); },
    }));
    const ctx = context("tool_search");
    ctx.allowedTools = new Set();
    const secret = "api_key=sk_test_1234567890abcdef";

    const outcome = await created.registry.execute(
      { toolName: "tool_search", toolCallId: ctx.toolCallId, input: { query: secret } },
      ctx,
    );

    expect(expectSettledResult(outcome).details?.error?.code).toBe("TOOL_NOT_ALLOWED");
    expect(events).toHaveLength(1);
    expect(events[0]?.input).toEqual({ query: TOOL_SEARCH_REDACTED_QUERY, limit: 5 });
    expect(JSON.stringify(events)).not.toContain(secret);
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

  test("deferred, throwing, and exhausted live publishers never block capture or the authoritative final", async () => {
    const cases = ["deferred", "throwing", "exhausted"] as const;

    for (const mode of cases) {
      const created = fixture({
        descriptors: [descriptor({
          outputPolicy: { kind: "artifact", previewDirection: "head-tail" },
          execute: async (_input, ctx) => {
            await ctx.outputCapture?.write(`canonical-${mode}`, { source: "bash-live" });
            return { isError: false, draft: { kind: "capture" } };
          },
        })],
      });
      await created.artifactStore.ready();

      const projectionStore = createMockStore(mode === "exhausted"
        ? { nextEventId: MAX_EVENTS, publishableNextEventId: 0 }
        : undefined);
      if (mode === "throwing") {
        projectionStore.getState().append = () => {
          throw new Error("projection unavailable");
        };
      }
      const livePublisher = new LiveToolOutputPublisher({
        store: projectionStore,
        toolCallId: `live-${mode}`,
        intervalMs: 60_000,
        timer: {
          setTimeout: () => 1,
          clearTimeout: () => undefined,
        },
      });
      const ctx = context("echo");
      ctx.liveToolOutput = livePublisher;

      const outcome = await created.registry.execute(
        { toolName: "echo", toolCallId: ctx.toolCallId, input: {} },
        ctx,
      );

      expect(outcome.kind).toBe("settled");
      expect(outcome.kind === "settled" ? outcome.result : undefined).toMatchObject({
        isError: false,
        output: { preview: `canonical-${mode}`, completeness: "complete" },
      });
      expect(ctx.outputCapture).toBeUndefined();
      expect(livePublisher.stopped).toBe(true);
      if (mode === "deferred") {
        expect(projectionStore.getState().events).toHaveLength(1);
      } else {
        expect(projectionStore.getState().events).toHaveLength(0);
      }
    }
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

  test("preserves raw exceptions in finalized tool output", async () => {
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
      descriptors: [descriptor({ execute: async () => { throw new Error(`boom ${secret}`); } })],
    });
    const ctx = context("echo");
    const outcome = await created.registry.execute(
      { toolName: "echo", toolCallId: ctx.toolCallId, input: {} },
      ctx,
    );
    const serialized = JSON.stringify({ outcome, logFields });
    expect(serialized).toContain(secret);
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
    const registry = createRegistry({
      finalizer: backing.finalizer,
      hitlCodec: backing.hitlCodec,
      approvalReviewer: deferTestApprovalReviewer,
    }, [tool]);
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

  test("executor exceptions become structured settled errors", async () => {
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

  test("executeResolved runs the same full pipeline without registry rebinding a run-local descriptor", async () => {
    const order: string[] = [];
    const pipelineDescriptor = (label: string): AnyToolDescriptor => descriptor({
      prepareInput: (input) => { order.push(`${label}:prepare`); return input; },
      hooks: {
        before: [() => { order.push(`${label}:before`); }],
        after: [() => { order.push(`${label}:after`); }],
      },
      permissions: [async () => { order.push(`${label}:permission`); return { outcome: "allow" as const }; }],
      execute: async () => { order.push(`${label}:execute`); return createTextToolResult(label); },
    });
    const registered = pipelineDescriptor("registered");
    const resolved = pipelineDescriptor("resolved");
    const created = fixture({ descriptors: [registered] });
    created.registry.globalHooks.before.push(() => { order.push("global-before"); });
    created.registry.globalHooks.finalized.push(() => { order.push("finalized"); });
    const finalize = spyOn(created.finalizer, "finalize");

    const staticResult = expectSettledResult(await created.registry.execute(
      { toolName: "echo", toolCallId: "static-call", input: {} },
      context("echo"),
    ));
    const resolvedResult = expectSettledResult(await created.registry.executeResolved(
      resolved,
      { toolName: "echo", toolCallId: "resolved-call", input: {} },
      context("echo"),
    ));

    expect(created.registry.get("echo")).toBe(registered);
    expect(staticResult.output.preview).toBe("registered");
    expect(resolvedResult.output.preview).toBe("resolved");
    expect(finalize).toHaveBeenCalledTimes(2);
    expect(order).toEqual([
      "registered:prepare", "global-before", "registered:before", "registered:permission",
      "registered:execute", "registered:after", "finalized",
      "resolved:prepare", "global-before", "resolved:before", "resolved:permission",
      "resolved:execute", "resolved:after", "finalized",
    ]);
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

  test("Reviewer is skipped for allow, deny, and an existing project approval", async () => {
    const review = mock(async (_request: unknown) => ({ outcome: "approved" as const }));

    const allowed = fixture({
      approvalReviewer: { review },
      descriptors: [descriptor({ permissions: [async () => ({ outcome: "allow" })] })],
    });
    expectSettledResult(await allowed.registry.execute(
      { toolName: "echo", toolCallId: "allowed-without-review", input: {} },
      context("echo"),
    ));

    const denied = fixture({
      approvalReviewer: { review },
      descriptors: [descriptor({ permissions: [async () => ({ outcome: "deny", reason: "blocked" })] })],
    });
    expectSettledResult(await denied.registry.execute(
      { toolName: "echo", toolCallId: "denied-without-review", input: {} },
      context("echo"),
    ));

    const scope = { kind: "tool-operation" as const, toolName: "echo", operation: "run", target: "approved" };
    const approved = fixture({
      approvalReviewer: { review },
      descriptors: [descriptor({ permissions: [async () => ({
        outcome: "ask",
        approval: { eligible: true, scope, display: "Run echo", reason: "Approve" },
      })] })],
    });
    const approvedContext = context("echo");
    await approvedContext.projectContext.approvals.load(approvedContext.projectContext.project.workspaceRoot);
    await approvedContext.projectContext.approvals.addApproval(scope, {
      display: "Run echo",
      reason: "Existing approval",
      grantedBy: {},
    });
    expectSettledResult(await approved.registry.execute(
      { toolName: "echo", toolCallId: approvedContext.toolCallId, input: {} },
      approvedContext,
    ));

    expect(review).not.toHaveBeenCalled();
  });

  test("Reviewer approves only the exact post-hook action without persisting approval", async () => {
    const review = mock(async (_request: unknown) => ({ outcome: "approved" as const }));
    const execute = mock(async (input: unknown) => createTextToolResult(JSON.stringify(input)));
    const created = fixture({
      approvalReviewer: { review },
      descriptors: [descriptor({
        inputSchema: z.object({ value: z.string() }).strict(),
        hooks: { before: [async () => ({ value: "post-hook" })] },
        permissions: [async () => ({
          outcome: "ask",
          source: "tool-guard",
          ruleId: "EFFECT_REVIEW",
          reason: "Exact rule reason",
          prompt: "Human-facing prompt",
          approval: { eligible: false, display: "Echo", reason: "Review echo" },
        })],
        execute,
      })],
    });
    const ctx = context("echo");
    const addApproval = spyOn(ctx.projectContext.approvals, "addApproval");

    const result = expectSettledResult(await created.registry.execute(
      { toolName: "echo", toolCallId: ctx.toolCallId, input: { value: "original" } },
      ctx,
    ));

    expect(result.output.preview).toBe('{"value":"post-hook"}');
    expect(review).toHaveBeenCalledTimes(1);
    expect(review.mock.calls[0]?.[0]).toMatchObject({
      context: ctx,
      input: { value: "post-hook" },
      permission: {
        outcome: "ask",
        source: "tool-guard",
        ruleId: "EFFECT_REVIEW",
        reason: "Exact rule reason",
        prompt: "Human-facing prompt",
      },
    });
    expect(execute).toHaveBeenCalledWith({ value: "post-hook" }, ctx);
    expect(addApproval).not.toHaveBeenCalled();
    expect(ctx.permissionOutcome).toBe("allow");
    addApproval.mockRestore();
  });

  test("Reviewer defer preserves the existing HITL request and human resume skips re-review", async () => {
    const review = mock(async () => ({ outcome: "deferred" as const, reason: "ask_user" as const }));
    const execute = mock(async () => createTextToolResult("approved by user"));
    const created = fixture({
      approvalReviewer: { review },
      descriptors: [descriptor({
        permissions: [async () => ({ outcome: "ask", reason: "approval needed" })],
        execute,
      })],
    });
    const ctx = context("echo");
    const toolCall = { toolName: "echo", toolCallId: ctx.toolCallId, input: {} };
    const blocked = expectBlockedOutcome(await created.registry.execute(toolCall, ctx));
    expect(blocked.request.source.type).toBe("tool_permission");

    const result = expectSettledResult(await created.registry.resumeBlocked({
      toolCall,
      request: blocked.request,
      requestKey: blocked.requestKey,
      response: { type: "permission_decision", decision: "approve_once" },
      context: ctx,
    }));

    expect(result.output.preview).toBe("approved by user");
    expect(review).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  test("human resume rejects changed or newly allowed facts and preserves a new deny without re-review", async () => {
    const review = mock(async () => ({ outcome: "deferred" as const, reason: "ask_user" as const }));
    let target = "first";
    let outcome: "ask" | "allow" | "deny" = "ask";
    const created = fixture({
      approvalReviewer: { review },
      descriptors: [descriptor({ permissions: [async () => {
        if (outcome === "allow") return { outcome: "allow" };
        if (outcome === "deny") return { outcome: "deny", reason: "Policy now denies" };
        return {
          outcome: "ask",
          approval: {
            eligible: true,
            scope: { kind: "tool-operation", toolName: "echo", operation: "run", target },
            display: "Run echo",
            reason: "Approve",
          },
        };
      }] })],
    });
    const ctx = context("echo");
    const toolCall = { toolName: "echo", toolCallId: ctx.toolCallId, input: {} };
    const first = expectBlockedOutcome(await created.registry.execute(toolCall, ctx));
    target = "changed";
    const changed = expectSettledResult(await created.registry.resumeBlocked({
      toolCall,
      request: first.request,
      requestKey: first.requestKey,
      response: { type: "permission_decision", decision: "approve_once" },
      context: ctx,
    }));
    expect(changed.details?.error?.code).toBe("TOOL_BLOCKED_RESPONSE_INVALID");

    target = "first";
    const second = expectBlockedOutcome(await created.registry.execute(toolCall, ctx));
    outcome = "allow";
    const nowAllowed = expectSettledResult(await created.registry.resumeBlocked({
      toolCall,
      request: second.request,
      requestKey: second.requestKey,
      response: { type: "permission_decision", decision: "approve_once" },
      context: ctx,
    }));
    expect(nowAllowed.details?.error?.code).toBe("TOOL_BLOCKED_RESPONSE_INVALID");

    outcome = "ask";
    const third = expectBlockedOutcome(await created.registry.execute(toolCall, ctx));
    outcome = "deny";
    const nowDenied = expectSettledResult(await created.registry.resumeBlocked({
      toolCall,
      request: third.request,
      requestKey: third.requestKey,
      response: { type: "permission_decision", decision: "approve_once" },
      context: ctx,
    }));
    expect(nowDenied.details?.error?.code).toBe("TOOL_PERMISSION_DENIED");
    expect(review).toHaveBeenCalledTimes(3);
  });

  test("Reviewer failures defer to HITL unless the Session signal is aborted", async () => {
    for (const failure of [
      new DOMException("Provider cancelled its own request", "AbortError"),
      new Error("Unexpected Reviewer failure"),
    ]) {
      const review = mock(async () => { throw failure; });
      const created = fixture({
        approvalReviewer: { review },
        descriptors: [descriptor({ permissions: [async () => ({ outcome: "ask" })] })],
      });
      const ctx = context("echo");

      expectBlockedOutcome(await created.registry.execute(
        { toolName: "echo", toolCallId: ctx.toolCallId, input: {} },
        ctx,
      ));
      expect(review).toHaveBeenCalledTimes(1);
    }

    const controller = new AbortController();
    const sessionAbort = new DOMException("Session cancelled", "AbortError");
    const review = mock(async () => { throw sessionAbort; });
    const created = fixture({
      approvalReviewer: { review },
      descriptors: [descriptor({ permissions: [async () => ({ outcome: "ask" })] })],
    });
    const ctx = context("echo");
    ctx.abort = controller.signal;
    controller.abort(sessionAbort);

    await expect(created.registry.execute(
      { toolName: "echo", toolCallId: ctx.toolCallId, input: {} },
      ctx,
    )).rejects.toBe(sessionAbort);
    expect(review).toHaveBeenCalledTimes(1);
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
  test("onInputResolved receives the parsed input used for execution", async () => {
    const secret = "runtime-secret-value";
    const created = fixture({ descriptors: [descriptor({
      inputSchema: z.object({ value: z.string() }).strict(),
    })] });
    const onInputResolved = mock(() => undefined);
    const ctx = context("echo");
    ctx.onInputResolved = onInputResolved;
    await created.registry.execute(
      { toolName: "echo", toolCallId: "resolved-input", input: { value: secret } }, ctx,
    );
    expect(onInputResolved).toHaveBeenCalledWith({ value: secret });
  });

  test("effectful attempt recording is awaited before execute", async () => {
    const order: string[] = [];
    const created = fixture({ descriptors: [descriptor({
      traits: { readOnly: false, destructive: false, concurrencySafe: false },
      execute: async () => { order.push("execute"); return createTextToolResult("ok"); },
    })] });
    const ctx = context("echo", async () => { await Promise.resolve(); order.push("attempt"); });
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
