import { describe, expect, it } from "bun:test";
import { DelegateTargetNotAllowedError, SubAgentError } from "../../agents/errors";
import type { ChildExecutionRequest } from "../../delegation/types";
import { storeManager } from "../../store/store";
import type { ToolExecutionContext, ToolExecutionResult } from "../types";
import { TOOL_ERROR_META_KEY } from "../errors";
import { DelegateInputSchema, executeDelegate } from "./delegate";
import { createTestProjectContext } from "../test-project-context";

class ToolStubExecutor {
  lastRequest: ChildExecutionRequest | undefined;
  readonly store = storeManager.create(`delegate-child-${crypto.randomUUID()}`);

  async start(request: ChildExecutionRequest) {
    this.lastRequest = request;
    this.store.getState().setParentSessionId(request.parentStore.getState().sessionId);
    this.store.getState().append({ type: "execution-start", executionId: "delegate-run" });
    this.store.getState().append({ type: "text-start" });
    this.store.getState().append({ type: "text-delta", text: "delegated output" });
    this.store.getState().append({ type: "text-end" });
    if (request.background !== true) {
      this.store.getState().append({ type: "execution-end", status: "completed" });
    }
    return {
      sessionId: this.store.getState().sessionId,
      store: this.store,
      result: Promise.resolve({ text: "delegated output", steps: 1 }),
      abort: () => {},
    };
  }
}

class FailingChildExecutor extends ToolStubExecutor {
  async start(request: ChildExecutionRequest) {
    this.lastRequest = request;
    const state = this.store.getState();
    state.setParentSessionId(request.parentStore.getState().sessionId);
    state.append({ type: "execution-start", executionId: "delegate-run" });
    state.append({ type: "text-start" });
    state.append({ type: "text-delta", text: "delegated output" });
    state.append({ type: "text-end" });
    if (request.background !== true) state.append({ type: "execution-end", status: "failed", error: "child failed" });
    return {
      sessionId: state.sessionId,
      store: this.store,
      result: Promise.reject(new SubAgentError("child failed")),
      abort: () => {},
    };
  }
}

function makeContext(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return { store: storeManager.create(`delegate-parent-${crypto.randomUUID()}`),
  toolName: "delegate",
  toolCallId: "delegate-call",
  input: {},
  step: 0,
  abort: new AbortController().signal,
  startedAt: 0,
  allowedTools: new Set(["delegate"]),
  workspaceRoot: import.meta.dir,
  storeManager,
    projectContext: createTestProjectContext(import.meta.dir),
  agentName: "orchestrator", ...overrides,  };
}

describe("delegate tool", () => {
  it("accepts any non-empty agent_type string in the input schema", () => {
    expect(DelegateInputSchema.safeParse({ agent_type: "custom", prompt: "inspect", skills: [] }).success).toBe(true);
    expect(DelegateInputSchema.safeParse({ agent_type: "", prompt: "inspect", skills: [] }).success).toBe(false);
    expect(DelegateInputSchema.safeParse({ agent_type: "custom", prompt: "inspect", skills: "codemap" }).success).toBe(false);
  });

  it("rejects input that omits the required skills field", () => {
    expect(DelegateInputSchema.safeParse({ agent_type: "custom", prompt: "inspect" }).success).toBe(false);
  });

  it("rejects invalid skill names in the input schema", () => {
    for (const invalidName of ["../x", "Git-Master", ""]) {
      expect(DelegateInputSchema.safeParse({ agent_type: "custom", prompt: "inspect", skills: [invalidName] }).success).toBe(false);
    }
  });

  it("sync delegation waits and returns a plain formatted result", async () => {
    const executor = new ToolStubExecutor();
    const parentStore = storeManager.create(`delegate-parent-${crypto.randomUUID()}`);
    const result = await executeDelegate(
      { agent_type: "explore", prompt: "inspect", skills: [], description: "Scan", background: false },
      makeContext({ startChildExecution: (request) => executor.start(request), currentDepth: 1, store: parentStore }),
    );

    expect((result as string).startsWith("Sub-agent result: completed.\n")).toBe(true);
    expect(result).toContain("Agent type: explore");
    expect(result).toContain(`Session ID: ${executor.store.getState().sessionId}`);
    expect(result).toContain("Status: completed");
    expect(result).toContain("Duration: ");
    expect(result).toContain("Result:\ndelegated output");
    expect(result).not.toContain("delegate_metadata");
    expect(executor.lastRequest?.parentSessionId).toBe(parentStore.getState().sessionId);
    expect(executor.lastRequest?.parentToolCallId).toBe("delegate-call");
    expect(executor.lastRequest?.toolName).toBe("delegate");
    expect(executor.lastRequest?.targetAgentName).toBe("explore");
    expect(executor.lastRequest?.prompt).toBe("inspect");
    expect(executor.lastRequest?.skills).toEqual([]);
    expect(executor.lastRequest?.currentDepth).toBe(1);
    expect(executor.lastRequest?.background).toBe(false);
  });

  it("async delegation returns launch guidance without metadata", async () => {
    const executor = new ToolStubExecutor();
    const parentStore = storeManager.create(`delegate-parent-${crypto.randomUUID()}`);
    const result = await executeDelegate(
      { agent_type: "explore", prompt: "inspect", skills: ["codemap"], description: "Scan", background: true },
      makeContext({ startChildExecution: (request) => executor.start(request), store: parentStore }),
    );

    expect((result as string).startsWith("Sub-agent started.\n")).toBe(true);
    expect(result).toContain("Agent type: explore");
    expect(result).toContain(`Session ID: ${executor.store.getState().sessionId}`);
    expect(result).toContain("Status: running");
    expect(result).toContain(`Use background_output(session_id="${executor.store.getState().sessionId}") to read the result.`);
    expect(result).not.toContain("delegate_metadata");
    expect(executor.lastRequest?.description).toBe("Scan");
    expect(executor.lastRequest?.background).toBe(true);
    expect(executor.lastRequest?.skills).toEqual(["codemap"]);
  });

  it("sync delegation formats child terminal failures instead of returning a tool error", async () => {
    const executor = new FailingChildExecutor();
    const result = await executeDelegate(
      { agent_type: "explore", prompt: "inspect", skills: [], description: "Scan", background: false },
      makeContext({ startChildExecution: (request) => executor.start(request) }),
    );

    expect(typeof result).toBe("string");
    expect((result as string).includes('"code":"TOOL_DELEGATE_FAILED"')).toBe(false);
    expect((result as string).startsWith("Sub-agent result: failed.\n")).toBe(true);
    expect(result).toContain("Status: failed");
    expect(result).toContain("Error: child failed");
    expect(result).toContain("Result:\ndelegated output");
    expect(result).not.toContain("delegate_metadata");
  });

  it("returns structured error when child execution context is missing", async () => {
    const result = await executeDelegate(
      { agent_type: "explore", prompt: "inspect", skills: [], background: false },
      makeContext(),
    );

    const errorResult = result as ToolExecutionResult;
    expect(errorResult.isError).toBe(true);
    expect(errorResult.meta?.[TOOL_ERROR_META_KEY]).toBeDefined();
    expect(JSON.parse(errorResult.output)).toMatchObject({
      name: "SubAgentError",
      code: "TOOL_DELEGATE_EXECUTOR_UNAVAILABLE",
      message: "Child execution is not available in this execution context",
      details: { ok: false, session_id: "" },
    });
  });

  it("returns structured error when child execution rejects a disallowed target", async () => {
    const startChildExecution = async () => {
      throw new DelegateTargetNotAllowedError("orchestrator", "writer", 0);
    };

    const result = await executeDelegate(
      { agent_type: "writer", prompt: "inspect", skills: [], background: false },
      makeContext({ startChildExecution }),
    );

    const errorResult = result as ToolExecutionResult;
    expect(errorResult.isError).toBe(true);
    expect(errorResult.meta?.[TOOL_ERROR_META_KEY]).toBeDefined();
    expect(JSON.parse(errorResult.output)).toMatchObject({
      name: "DelegateTargetNotAllowedError",
      code: "TOOL_DELEGATE_FAILED",
      message: 'Agent "orchestrator" cannot delegate to "writer" at depth 0',
      details: {
        ok: false,
        session_id: "",
        error: {
          name: "DelegateTargetNotAllowedError",
          message: 'Agent "orchestrator" cannot delegate to "writer" at depth 0',
        },
      },
    });
  });

  it("forwards title and description to child execution", async () => {
    const executor = new ToolStubExecutor();
    const parentAbort = new AbortController();
    const parentStore = storeManager.create(`delegate-parent-${crypto.randomUUID()}`);

    await executeDelegate(
      {
        agent_type: "explore",
        prompt: "inspect",
        skills: ["research-docs"],
        title: "Custom Title",
        description: "Scan repository",
        background: false,
      },
      makeContext({ startChildExecution: (request) => executor.start(request), store: parentStore, abort: parentAbort.signal, agentName: "explore" }),
    );

    expect(executor.lastRequest).toMatchObject({
      parentStore,
      parentSessionId: parentStore.getState().sessionId,
      parentToolCallId: "delegate-call",
      toolName: "delegate",
      targetAgentName: "explore",
      prompt: "inspect",
      skills: ["research-docs"],
      title: "Custom Title",
      description: "Scan repository",
      background: false,
      currentDepth: 0,
      parentAbort: parentAbort.signal,
    });
  });

  it("uses description as delegated title when title is omitted", async () => {
    const executor = new ToolStubExecutor();

    await executeDelegate(
      { agent_type: "explore", prompt: "inspect", skills: [], description: "Fallback Title", background: false },
      makeContext({ startChildExecution: (request) => executor.start(request) }),
    );

    expect(executor.lastRequest?.title).toBe("Fallback Title");
  });
});
