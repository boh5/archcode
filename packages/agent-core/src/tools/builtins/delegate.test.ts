import { describe, expect, it, mock } from "bun:test";
import {
  AgentRunningError,
  ChildSessionAgentMismatchError,
  ChildSessionNotFoundError,
  DelegateTargetNotAllowedError,
  SubAgentError,
} from "../../agents/errors";
import type { ChildExecutionRequest, ResumeChildRequest } from "../../delegation/types";
import { storeManager } from "../../store/store";
import type { ToolExecutionContext, ToolExecutionOrigin, ToolExecutionResult } from "../types";
import { TOOL_ERROR_META_KEY } from "../errors";
import { DelegateInputSchema, delegateTool, executeDelegate } from "./delegate";
import { createTestProjectContext } from "../test-project-context";

const WORKSPACE_ROOT = import.meta.dir;

class ToolStubExecutor {
  lastRequest: ChildExecutionRequest | undefined;
  readonly store = storeManager.create(`delegate-child-${crypto.randomUUID()}`, WORKSPACE_ROOT, { agentName: "engineer" });

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
  return { store: storeManager.create(`delegate-parent-${crypto.randomUUID()}`, WORKSPACE_ROOT, { agentName: "engineer" }),
  toolName: "delegate",
  toolCallId: "delegate-call",
  input: {},
  step: 0,
  abort: new AbortController().signal,
  startedAt: 0,
  allowedTools: new Set(["delegate"]),
  cwd: import.meta.dir,
  storeManager,
    projectContext: createTestProjectContext(import.meta.dir),
  agentName: "engineer", ...overrides,  };
}

const LOOP_ORIGIN: ToolExecutionOrigin = {
  kind: "loop",
  loopId: "loop-delegate-origin",
  runId: "run-delegate-origin",
  trigger: "manual",
  approvalPolicy: "interactive",
};

describe("delegate tool", () => {
  it("publishes the complete prompt envelope, background collection, resume, and authority contract", () => {
    for (const field of [
      "Task",
      "Expected outcome",
      "Context and evidence",
      "Scope ownership and non-goals",
      "Must do / must not do",
      "Verification and output",
    ]) {
      expect(delegateTool.description).toContain(field);
    }
    expect(delegateTool.description).toContain("background=true");
    expect(delegateTool.description).toContain("terminal result");
    expect(delegateTool.description).toContain("reminder is only a terminal notification");
    expect(delegateTool.description).toContain("blocking background_output");
    expect(delegateTool.description).toContain("same agent_type");
    expect(delegateTool.description).toContain("stopped child");
    expect(delegateTool.description).toContain("cannot expand");
  });

  it("accepts any non-empty agent_type plus task/context fields in the input schema", () => {
    expect(DelegateInputSchema.safeParse({ agent_type: "custom", task: "inspect", context: "repo", skills: [] }).success).toBe(true);
    expect(DelegateInputSchema.safeParse({ agent_type: "", task: "inspect", skills: [] }).success).toBe(false);
    expect(DelegateInputSchema.safeParse({ agent_type: "custom", task: "inspect", skills: "codemap" }).success).toBe(false);
  });

  it("rejects input that omits the required skills field", () => {
    expect(DelegateInputSchema.safeParse({ agent_type: "custom", task: "inspect" }).success).toBe(false);
  });

  it("rejects invalid skill names in the input schema", () => {
    for (const invalidName of ["../x", "Git-Master", ""]) {
      expect(DelegateInputSchema.safeParse({ agent_type: "custom", task: "inspect", skills: [invalidName] }).success).toBe(false);
    }
  });

  it("accepts optional persona but rejects the removed artifact reference field", () => {
    const removedArtifactField = "available" + "_artifacts";
    const parsed = DelegateInputSchema.safeParse({
      agent_type: "plan",
      persona: "product manager",
      task: "shape scope",
      context: "Goal draft",
      skills: [],
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toMatchObject({
        agent_type: "plan",
        persona: "product manager",
        task: "shape scope",
        context: "Goal draft",
      });
    }
    expect(DelegateInputSchema.safeParse({
      agent_type: "explore",
      task: "inspect",
      skills: [],
      [removedArtifactField]: [],
    }).success).toBe(false);
  });

  it("forwards persona and formatted task prompt to child execution without changing tool policy", async () => {
    const executor = new ToolStubExecutor();

    await executeDelegate(
      { agent_type: "plan", persona: "spec writer", task: "inspect", context: "Goal draft", skills: [], background: false },
      makeContext({ startChildExecution: (request) => executor.start(request) }),
    );

    expect(executor.lastRequest?.persona).toBe("spec writer");
    expect(executor.lastRequest?.prompt).toContain("Persona: spec writer");
    expect(executor.lastRequest?.prompt).toContain("Task:\ninspect");
    expect(executor.lastRequest?.prompt).toContain("Context:\nGoal draft");
    expect("tools" in executor.lastRequest!).toBe(false);
  });

  it("forwards the Loop execution origin when starting a child", async () => {
    const executor = new ToolStubExecutor();

    await executeDelegate(
      { agent_type: "explore", task: "inspect", skills: [], background: false },
      makeContext({
        origin: LOOP_ORIGIN,
        startChildExecution: (request) => executor.start(request),
      }),
    );

    expect(executor.lastRequest?.origin).toEqual(LOOP_ORIGIN);
  });

  it("sync delegation waits and returns a plain formatted result", async () => {
    const executor = new ToolStubExecutor();
    const parentStore = storeManager.create(`delegate-parent-${crypto.randomUUID()}`, WORKSPACE_ROOT, { agentName: "engineer" });
    const result = await executeDelegate(
      { agent_type: "explore", task: "inspect", skills: [], description: "Scan", background: false },
      makeContext({ startChildExecution: (request) => executor.start(request), currentDepth: 1, store: parentStore }),
    );

    expect((result as string).startsWith("Sub-agent result: completed.\n")).toBe(true);
    expect(result).toContain("Agent type: explore");
    expect(result).toContain(`Session ID: ${executor.store.getState().sessionId}`);
    expect(result).toContain("Status: completed");
    expect(result).toContain("Duration: ");
    expect(result).toContain("Result:\ndelegated output");
    expect(executor.lastRequest?.parentSessionId).toBe(parentStore.getState().sessionId);
    expect(executor.lastRequest?.parentToolCallId).toBe("delegate-call");
    expect(executor.lastRequest?.toolName).toBe("delegate");
    expect(executor.lastRequest?.targetAgentName).toBe("explore");
    expect(executor.lastRequest?.prompt).toBe("Task:\ninspect");
    expect(executor.lastRequest?.skills).toEqual([]);
    expect(executor.lastRequest?.currentDepth).toBe(1);
    expect(executor.lastRequest?.background).toBe(false);
  });

  it("async delegation returns launch guidance without metadata", async () => {
    const executor = new ToolStubExecutor();
    const parentStore = storeManager.create(`delegate-parent-${crypto.randomUUID()}`, WORKSPACE_ROOT, { agentName: "engineer" });
    const result = await executeDelegate(
      { agent_type: "explore", task: "inspect", skills: ["codemap"], description: "Scan", background: true },
      makeContext({ startChildExecution: (request) => executor.start(request), store: parentStore }),
    );

    expect((result as string).startsWith("Sub-agent started.\n")).toBe(true);
    expect(result).toContain("Agent type: explore");
    expect(result).toContain(`Session ID: ${executor.store.getState().sessionId}`);
    expect(result).toContain("Status: running");
    expect(result).toContain(`Use background_output(session_id="${executor.store.getState().sessionId}") to read the result.`);
    expect(executor.lastRequest?.description).toBe("Scan");
    expect(executor.lastRequest?.background).toBe(true);
    expect(executor.lastRequest?.skills).toEqual(["codemap"]);
  });

  it("treats empty session_id values as new delegation requests", async () => {
    for (const sessionId of ["", "  "]) {
      const executor = new ToolStubExecutor();
      const resumeChildSession = mock(() => {
        throw new Error("resume should not be called for empty session_id values");
      });

      const result = await executeDelegate(
        { agent_type: "plan", task: "inspect", skills: [], background: false, session_id: sessionId },
        makeContext({
          startChildExecution: (request) => executor.start(request),
          resumeChildSession,
        }),
      );

      expect(resumeChildSession).not.toHaveBeenCalled();
      expect(executor.lastRequest?.targetAgentName).toBe("plan");
      expect(result).toContain("Sub-agent result: completed.");
    }
  });

  it("sync delegation formats child terminal failures instead of returning a tool error", async () => {
    const executor = new FailingChildExecutor();
    const result = await executeDelegate(
      { agent_type: "explore", task: "inspect", skills: [], description: "Scan", background: false },
      makeContext({ startChildExecution: (request) => executor.start(request) }),
    );

    expect(typeof result).toBe("string");
    expect((result as string).includes('"code":"TOOL_DELEGATE_FAILED"')).toBe(false);
    expect((result as string).startsWith("Sub-agent result: failed.\n")).toBe(true);
    expect(result).toContain("Status: failed");
    expect(result).toContain("Error: child failed");
    expect(result).toContain("Result:\ndelegated output");
  });

  it("returns structured error when child execution context is missing", async () => {
    const result = await executeDelegate(
      { agent_type: "explore", task: "inspect", skills: [], background: false },
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
      throw new DelegateTargetNotAllowedError("engineer", "writer", 0);
    };

    const result = await executeDelegate(
      { agent_type: "writer", task: "inspect", skills: [], background: false },
      makeContext({ startChildExecution }),
    );

    const errorResult = result as ToolExecutionResult;
    expect(errorResult.isError).toBe(true);
    expect(errorResult.meta?.[TOOL_ERROR_META_KEY]).toBeDefined();
    expect(JSON.parse(errorResult.output)).toMatchObject({
      name: "DelegateTargetNotAllowedError",
      code: "TOOL_DELEGATE_FAILED",
      message: 'Agent "engineer" cannot delegate to "writer" at depth 0',
      details: {
        ok: false,
        session_id: "",
        error: {
          name: "DelegateTargetNotAllowedError",
          message: 'Agent "engineer" cannot delegate to "writer" at depth 0',
        },
      },
    });
  });

  it("forwards title and description to child execution", async () => {
    const executor = new ToolStubExecutor();
    const parentAbort = new AbortController();
    const parentStore = storeManager.create(`delegate-parent-${crypto.randomUUID()}`, WORKSPACE_ROOT, { agentName: "engineer" });

    await executeDelegate(
      {
        agent_type: "explore",
        task: "inspect",
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
      prompt: "Task:\ninspect",
      persona: undefined,
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
      { agent_type: "explore", task: "inspect", skills: [], description: "Fallback Title", background: false },
      makeContext({ startChildExecution: (request) => executor.start(request) }),
    );

    expect(executor.lastRequest?.title).toBe("Fallback Title");
  });

  describe("resume mode (session_id provided)", () => {
    const RESUME_SESSION_ID = "resume-child-session-id";

    function makeResumeHandle(
      sessionId: string = RESUME_SESSION_ID,
      result: Promise<{ text: string; steps: number }> = Promise.resolve({ text: "resumed output", steps: 1 }),
    ) {
      const store = storeManager.create(`delegate-resume-${crypto.randomUUID()}`, WORKSPACE_ROOT, { agentName: "engineer" });
      store.getState().setParentSessionId("parent-id");
      store.getState().append({ type: "execution-start", executionId: "resume-run" });
      store.getState().append({ type: "text-start" });
      store.getState().append({ type: "text-delta", text: "resumed output" });
      store.getState().append({ type: "text-end" });
      store.getState().append({ type: "execution-end", status: "completed" });
      return {
        sessionId,
        store,
        result,
        abort: () => {},
      };
    }

    it("accepts optional session_id in the input schema", () => {
      expect(
        DelegateInputSchema.safeParse({
          agent_type: "explore",
          task: "continue",
          skills: [],
          session_id: RESUME_SESSION_ID,
        }).success,
      ).toBe(true);
      expect(
        DelegateInputSchema.safeParse({
          agent_type: "explore",
          task: "continue",
          skills: [],
        }).success,
      ).toBe(true);
    });

    it("calls resumeChildSession when session_id is provided and returns formatted result", async () => {
      const handle = makeResumeHandle();
      const resumeChildSession = mock(
        (_workspaceRoot: string, _request: ResumeChildRequest) => Promise.resolve(handle),
      );
      const parentStore = storeManager.create(`delegate-parent-${crypto.randomUUID()}`, WORKSPACE_ROOT, { agentName: "engineer" });
      const parentAbort = new AbortController();

      const result = await executeDelegate(
        { agent_type: "explore", task: "continue work", skills: [], background: false, session_id: RESUME_SESSION_ID },
        makeContext({ resumeChildSession, store: parentStore, abort: parentAbort.signal, currentDepth: 2 }),
      );

      expect(resumeChildSession).toHaveBeenCalledTimes(1);
      const [workspaceRoot, request] = resumeChildSession.mock.calls[0]!;
      expect(workspaceRoot).toBe(import.meta.dir);
      expect(request).toMatchObject({
        parentStore,
        parentSessionId: parentStore.getState().sessionId,
        parentToolCallId: "delegate-call",
        toolName: "delegate",
      sessionId: RESUME_SESSION_ID,
      targetAgentName: "explore",
        prompt: "Task:\ncontinue work",
        currentDepth: 2,
        parentAbort: parentAbort.signal,
      });

      const output = result as string;
      expect(output.startsWith("Sub-agent result: completed.\n")).toBe(true);
      expect(output).toContain(`Session ID: ${RESUME_SESSION_ID}`);
      expect(output).toContain("Status: completed");
      expect(output).toContain("Result:\nresumed output");
    });

    it("forwards the Loop execution origin when resuming a child", async () => {
      const handle = makeResumeHandle();
      const resumeChildSession = mock(
        (_workspaceRoot: string, _request: ResumeChildRequest) => Promise.resolve(handle),
      );

      await executeDelegate(
        { agent_type: "explore", task: "continue", skills: [], background: false, session_id: RESUME_SESSION_ID },
        makeContext({ origin: LOOP_ORIGIN, resumeChildSession }),
      );

      expect(resumeChildSession.mock.calls[0]?.[1].origin).toEqual(LOOP_ORIGIN);
    });

    it("returns structured error when resumeChildSession is unavailable", async () => {
      const result = await executeDelegate(
        { agent_type: "explore", task: "continue", skills: [], background: false, session_id: RESUME_SESSION_ID },
        makeContext(),
      );

      const errorResult = result as ToolExecutionResult;
      expect(errorResult.isError).toBe(true);
      expect(errorResult.meta?.[TOOL_ERROR_META_KEY]).toBeDefined();
      expect(JSON.parse(errorResult.output)).toMatchObject({
        name: "SubAgentError",
        code: "TOOL_DELEGATE_EXECUTOR_UNAVAILABLE",
        message: "Child session resume is not available in this execution context",
        details: { ok: false, session_id: RESUME_SESSION_ID },
      });
    });

    it("returns structured error when resumeChildSession throws ChildSessionNotFoundError", async () => {
      const resumeChildSession = mock(() => {
        throw new ChildSessionNotFoundError(import.meta.dir, RESUME_SESSION_ID);
      });

      const result = await executeDelegate(
        { agent_type: "explore", task: "continue", skills: [], background: false, session_id: RESUME_SESSION_ID },
        makeContext({ resumeChildSession }),
      );

      const errorResult = result as ToolExecutionResult;
      expect(errorResult.isError).toBe(true);
      expect(JSON.parse(errorResult.output)).toMatchObject({
        name: "ChildSessionNotFoundError",
        code: "TOOL_DELEGATE_FAILED",
        details: {
          ok: false,
          session_id: RESUME_SESSION_ID,
          error: { name: "ChildSessionNotFoundError" },
        },
      });
    });

    it("returns structured error when resumeChildSession throws AgentRunningError", async () => {
      const resumeChildSession = mock(() => {
        throw new AgentRunningError();
      });

      const result = await executeDelegate(
        { agent_type: "explore", task: "continue", skills: [], background: false, session_id: RESUME_SESSION_ID },
        makeContext({ resumeChildSession }),
      );

      const errorResult = result as ToolExecutionResult;
      expect(errorResult.isError).toBe(true);
      expect(JSON.parse(errorResult.output)).toMatchObject({
        name: "AgentRunningError",
        code: "TOOL_DELEGATE_FAILED",
        details: {
          ok: false,
          session_id: RESUME_SESSION_ID,
          error: { name: "AgentRunningError" },
        },
      });
    });

    it("returns structured error when resumeChildSession throws ChildSessionAgentMismatchError", async () => {
      const resumeChildSession = mock(() => {
        throw new ChildSessionAgentMismatchError(RESUME_SESSION_ID, "explore", "builder");
      });

      const result = await executeDelegate(
        { agent_type: "explore", task: "continue", skills: [], background: false, session_id: RESUME_SESSION_ID },
        makeContext({ resumeChildSession }),
      );

      const errorResult = result as ToolExecutionResult;
      expect(errorResult.isError).toBe(true);
      expect(JSON.parse(errorResult.output)).toMatchObject({
        name: "ChildSessionAgentMismatchError",
        code: "TOOL_DELEGATE_FAILED",
        details: {
          ok: false,
          session_id: RESUME_SESSION_ID,
          error: { name: "ChildSessionAgentMismatchError" },
        },
      });
    });

    it("supports background execution when session_id is provided", async () => {
      const resumedRun = Promise.resolve({ text: "resumed later", steps: 1 });
      const handle = makeResumeHandle(RESUME_SESSION_ID, resumedRun);
      const resumeChildSession = mock(() => Promise.resolve(handle));

      const result = await executeDelegate(
        { agent_type: "explore", task: "continue", skills: [], background: true, session_id: RESUME_SESSION_ID },
        makeContext({ resumeChildSession }),
      );

      expect(resumeChildSession).toHaveBeenCalledTimes(1);
      expect(result).toContain("Sub-agent started.");
      expect(result).toContain(`Session ID: ${RESUME_SESSION_ID}`);
      expect(result).toContain(`Use background_output(session_id="${RESUME_SESSION_ID}") to read the result.`);
    });

    it("does not call startChildExecution when session_id is provided", async () => {
      const handle = makeResumeHandle();
      const resumeChildSession = mock(() => Promise.resolve(handle));
      const startChildExecution = mock(() => Promise.resolve(handle));

      await executeDelegate(
        { agent_type: "explore", task: "continue", skills: [], background: false, session_id: RESUME_SESSION_ID },
        makeContext({ resumeChildSession, startChildExecution }),
      );

      expect(startChildExecution).not.toHaveBeenCalled();
      expect(resumeChildSession).toHaveBeenCalledTimes(1);
    });
  });
});
