import { describe, expect, it } from "bun:test";
import type { StoreApi } from "zustand";
import { DelegateTargetNotAllowedError } from "../../agents/errors";
import type { AgentFactoryLike, DelegateAgentOptions } from "../../agents/factory-types";
import { createSessionStore } from "../../store/store";
import type { SessionStoreState } from "../../store/types";
import type { ToolExecutionContext } from "../types";
import { DelegateInputSchema, executeDelegate } from "./delegate";

class ToolStubFactory implements AgentFactoryLike {
  lastOptions: DelegateAgentOptions | undefined;
  readonly store = createSessionStore(`delegate-child-${crypto.randomUUID()}`);

  delegate(options: DelegateAgentOptions) {
    this.lastOptions = options;
    this.store.getState().append({ type: "text-start" });
    this.store.getState().append({ type: "text-delta", text: "delegated output" });
    this.store.getState().append({ type: "text-end" });
    return {
      sessionId: this.store.getState().sessionId,
      store: this.store,
      result: Promise.resolve({ text: "delegated output", steps: 1 }),
      abort: () => {},
    };
  }
}

function makeContext(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    store: createSessionStore(`delegate-parent-${crypto.randomUUID()}`),
    toolName: "delegate",
    toolCallId: "delegate-call",
    input: {},
    step: 0,
    abort: new AbortController().signal,
    startedAt: 0,
    allowedTools: new Set(["delegate"]),
    workspaceRoot: import.meta.dir,
    agentName: "orchestrator",
    ...overrides,
  };
}

describe("delegate tool", () => {
  it("accepts any non-empty agent_type string in the input schema", () => {
    expect(DelegateInputSchema.safeParse({ agent_type: "custom", prompt: "inspect" }).success).toBe(true);
    expect(DelegateInputSchema.safeParse({ agent_type: "", prompt: "inspect" }).success).toBe(false);
  });

  it("sync delegation waits and returns last assistant text", async () => {
    const factory = new ToolStubFactory();
    const result = await executeDelegate(
      { agent_type: "explore", prompt: "inspect", background: false },
      makeContext({ agentFactory: factory, currentDepth: 1 }),
    );

    expect(result).toBe("delegated output");
    expect(factory.lastOptions?.parentAgentName).toBe("orchestrator");
    expect(factory.lastOptions?.targetAgentName).toBe("explore");
    expect(factory.lastOptions?.prompt).toBe("inspect");
    expect(factory.lastOptions?.currentDepth).toBe(1);
    expect(factory.lastOptions?.background).toBe(false);
  });

  it("async delegation returns session_id immediately", async () => {
    const factory = new ToolStubFactory();
    const result = await executeDelegate(
      { agent_type: "explore", prompt: "inspect", description: "Scan", background: true },
      makeContext({ agentFactory: factory }),
    );

    expect(JSON.parse(result)).toEqual({ ok: true, session_id: factory.store.getState().sessionId });
    expect(factory.lastOptions?.description).toBe("Scan");
    expect(factory.lastOptions?.background).toBe(true);
  });

  it("returns structured error when factory context is missing", async () => {
    const result = await executeDelegate(
      { agent_type: "explore", prompt: "inspect", background: false },
      makeContext(),
    );

    expect(JSON.parse(result)).toEqual({
      ok: false,
      sessionId: "",
      error: { name: "SubAgentError", message: "AgentFactory is not available in this execution context" },
    });
  });

  it("returns structured error when factory rejects a disallowed target", async () => {
    const factory: AgentFactoryLike = {
      delegate() {
        throw new DelegateTargetNotAllowedError("orchestrator", "writer", 0);
      },
    };

    const result = await executeDelegate(
      { agent_type: "writer", prompt: "inspect", background: false },
      makeContext({ agentFactory: factory }),
    );

    expect(JSON.parse(result)).toEqual({
      ok: false,
      sessionId: "",
      error: {
        name: "DelegateTargetNotAllowedError",
        message: 'Agent "orchestrator" cannot delegate to "writer" at depth 0',
      },
    });
  });

  it("forwards title and description to the factory", async () => {
    const factory = new ToolStubFactory();
    const parentAbort = new AbortController();
    const parentStore = createSessionStore(`delegate-parent-${crypto.randomUUID()}`);

    await executeDelegate(
      {
        agent_type: "explore",
        prompt: "inspect",
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
      { agent_type: "explore", prompt: "inspect", description: "Fallback Title", background: false },
      makeContext({ agentFactory: factory }),
    );

    expect(factory.lastOptions?.title).toBe("Fallback Title");
  });
});
