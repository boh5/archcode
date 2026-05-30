import { describe, expect, it } from "bun:test";
import { DelegateTargetNotAllowedError, SubAgentError } from "../../agents/errors";
import type { AgentFactoryLike, DelegateAgentOptions } from "../../delegation/types";
import { storeManager } from "../../store/store";
import type { ToolExecutionContext, ToolExecutionResult } from "../types";
import { TOOL_ERROR_META_KEY } from "../errors";
import { DelegateInputSchema, executeDelegate } from "./delegate";
import { createTestProjectContext } from "../test-project-context";

class ToolStubFactory implements AgentFactoryLike {
  lastOptions: DelegateAgentOptions | undefined;
  readonly store = storeManager.create(`delegate-child-${crypto.randomUUID()}`);

  async delegate(options: DelegateAgentOptions) {
    this.lastOptions = options;
    this.store.getState().setParentSessionId(options.parentStore.getState().sessionId);
    this.store.getState().append({ type: "run-start", runId: "delegate-run" });
    this.store.getState().append({ type: "text-start" });
    this.store.getState().append({ type: "text-delta", text: "delegated output" });
    this.store.getState().append({ type: "text-end" });
    if (options.background !== true) {
      this.store.getState().append({ type: "run-end", status: "completed" });
    }
    return {
      sessionId: this.store.getState().sessionId,
      store: this.store,
      result: Promise.resolve({ text: "delegated output", steps: 1 }),
      abort: () => {},
    };
  }
}

class FailingChildFactory extends ToolStubFactory {
  async delegate(options: DelegateAgentOptions) {
    this.lastOptions = options;
    const state = this.store.getState();
    state.setParentSessionId(options.parentStore.getState().sessionId);
    state.append({ type: "run-start", runId: "delegate-run" });
    state.append({ type: "text-start" });
    state.append({ type: "text-delta", text: "delegated output" });
    state.append({ type: "text-end" });
    if (options.background !== true) state.append({ type: "run-end", status: "failed", error: "child failed" });
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

function metadataBlock(output: string): string {
  const matches = output.match(/<delegate_metadata>\n[\s\S]*?\n<\/delegate_metadata>/g) ?? [];
  expect(matches).toHaveLength(1);
  return matches[0]!;
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

  it("sync delegation waits and returns formatted result with metadata", async () => {
    const factory = new ToolStubFactory();
    const parentStore = storeManager.create(`delegate-parent-${crypto.randomUUID()}`);
    const result = await executeDelegate(
      { agent_type: "explore", prompt: "inspect", skills: [], description: "Scan", background: false },
      makeContext({ agentFactory: factory, currentDepth: 1, store: parentStore }),
    );

    expect((result as string).startsWith("Sub-agent completed.\n")).toBe(true);
    expect(result).toContain("Agent type: explore");
    expect(result).toContain(`Session ID: ${factory.store.getState().sessionId}`);
    expect(result).toContain("Status: completed");
    expect(result).toContain("Duration: ");
    expect(result).toContain("Result:\ndelegated output");
    expect(metadataBlock(result as string)).toContain(`session_id: ${factory.store.getState().sessionId}`);
    expect(metadataBlock(result as string)).toContain(`parent_session_id: ${parentStore.getState().sessionId}`);
    expect(metadataBlock(result as string)).toContain("agent_type: explore");
    expect(metadataBlock(result as string)).toContain("description: Scan");
    expect(metadataBlock(result as string)).toContain("status: completed");
    expect(metadataBlock(result as string)).toContain("background: false");
    expect(metadataBlock(result as string)).toContain("started_at: ");
    expect(metadataBlock(result as string)).toContain("ended_at: ");
    expect(metadataBlock(result as string)).toContain("duration_ms: ");
    expect(factory.lastOptions?.parentAgentName).toBe("orchestrator");
    expect(factory.lastOptions?.targetAgentName).toBe("explore");
    expect(factory.lastOptions?.prompt).toBe("inspect");
    expect(factory.lastOptions?.skills).toEqual([]);
    expect(factory.lastOptions?.currentDepth).toBe(1);
    expect(factory.lastOptions?.background).toBe(false);
  });

  it("async delegation returns launch text with metadata", async () => {
    const factory = new ToolStubFactory();
    const parentStore = storeManager.create(`delegate-parent-${crypto.randomUUID()}`);
    const result = await executeDelegate(
      { agent_type: "explore", prompt: "inspect", skills: ["codemap"], description: "Scan", background: true },
      makeContext({ agentFactory: factory, store: parentStore }),
    );

    expect((result as string).startsWith("Sub-agent started.\n")).toBe(true);
    expect(result).toContain("Agent type: explore");
    expect(result).toContain(`Session ID: ${factory.store.getState().sessionId}`);
    expect(result).toContain("Status: running");
    expect(result).toContain(`Use background_output(session_id="${factory.store.getState().sessionId}") to read the result.`);
    expect(metadataBlock(result as string)).toContain(`session_id: ${factory.store.getState().sessionId}`);
    expect(metadataBlock(result as string)).toContain(`parent_session_id: ${parentStore.getState().sessionId}`);
    expect(metadataBlock(result as string)).toContain("agent_type: explore");
    expect(metadataBlock(result as string)).toContain("description: Scan");
    expect(metadataBlock(result as string)).toContain("status: running");
    expect(metadataBlock(result as string)).toContain("background: true");
    expect(metadataBlock(result as string)).toContain("ended_at: ");
    expect(metadataBlock(result as string)).toContain("duration_ms: ");
    expect(factory.lastOptions?.description).toBe("Scan");
    expect(factory.lastOptions?.background).toBe(true);
    expect(factory.lastOptions?.skills).toEqual(["codemap"]);
  });

  it("sync delegation formats child terminal failures instead of returning a tool error", async () => {
    const factory = new FailingChildFactory();
    const result = await executeDelegate(
      { agent_type: "explore", prompt: "inspect", skills: [], description: "Scan", background: false },
      makeContext({ agentFactory: factory }),
    );

    expect(typeof result).toBe("string");
    expect((result as string).includes('"code":"TOOL_DELEGATE_FAILED"')).toBe(false);
    expect((result as string).startsWith("Sub-agent failed.\n")).toBe(true);
    expect(result).toContain("Status: failed");
    expect(result).toContain("Result:\ndelegated output");
    expect(metadataBlock(result as string)).toContain("status: failed");
    expect(metadataBlock(result as string)).toContain("background: false");
  });

  it("returns structured error when factory context is missing", async () => {
    const result = await executeDelegate(
      { agent_type: "explore", prompt: "inspect", skills: [], background: false },
      makeContext(),
    );

    const errorResult = result as ToolExecutionResult;
    expect(errorResult.isError).toBe(true);
    expect(errorResult.meta?.[TOOL_ERROR_META_KEY]).toBeDefined();
    expect(JSON.parse(errorResult.output)).toMatchObject({
      name: "SubAgentError",
      code: "TOOL_DELEGATE_FACTORY_UNAVAILABLE",
      message: "AgentFactory is not available in this execution context",
      details: { ok: false, session_id: "" },
    });
  });

  it("returns structured error when factory rejects a disallowed target", async () => {
    const factory: AgentFactoryLike = {
      async delegate() {
        throw new DelegateTargetNotAllowedError("orchestrator", "writer", 0);
      },
    };

    const result = await executeDelegate(
      { agent_type: "writer", prompt: "inspect", skills: [], background: false },
      makeContext({ agentFactory: factory }),
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

  it("forwards title and description to the factory", async () => {
    const factory = new ToolStubFactory();
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
      makeContext({ agentFactory: factory, store: parentStore, abort: parentAbort.signal, agentName: "explore" }),
    );

    expect(factory.lastOptions).toMatchObject({
      parentStore,
      parentAgentName: "explore",
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
    const factory = new ToolStubFactory();

    await executeDelegate(
      { agent_type: "explore", prompt: "inspect", skills: [], description: "Fallback Title", background: false },
      makeContext({ agentFactory: factory }),
    );

    expect(factory.lastOptions?.title).toBe("Fallback Title");
  });
});
