import { describe, expect, it } from "bun:test";
import type { StoreApi } from "zustand";
import { createSessionStore } from "../../store/store";
import type { SessionStoreState } from "../../store/types";
import type { AgentType } from "../../agents/agent-registry";
import type { CreateSubAgentOptions, SubAgentRunHandle } from "../../agents/sub-agent-manager";
import type { Agent, AgentResult } from "../../agents/types";
import type { SubAgentManagerLike, ToolExecutionContext } from "../types";
import { executeDelegate } from "./delegate";

class ToolStubAgent implements Agent {
  constructor(readonly store: StoreApi<SessionStoreState>) {}
  async run(): Promise<AgentResult> {
    return { text: "", steps: 1 };
  }
}

class ToolStubManager implements SubAgentManagerLike {
  readonly activeCount = 0;
  lastOptions: CreateSubAgentOptions | undefined;
  readonly store = createSessionStore(`delegate-child-${crypto.randomUUID()}`);

  createAgent(agentType: AgentType, prompt: string, options?: CreateSubAgentOptions): SubAgentRunHandle {
    expect(agentType).toBe("explore");
    expect(prompt).toBe("inspect");
    this.lastOptions = options;
    this.store.getState().append({ type: "text-start" });
    this.store.getState().append({ type: "text-delta", text: "delegated output" });
    this.store.getState().append({ type: "text-end" });
    const abortController = new AbortController();
    return {
      sessionId: this.store.getState().sessionId,
      agent: new ToolStubAgent(this.store),
      store: this.store,
      result: Promise.resolve({ text: "delegated output", steps: 1 }),
      abortController,
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
    ...overrides,
  };
}

describe("delegate tool", () => {
  it("sync delegation waits and returns last assistant text", async () => {
    const manager = new ToolStubManager();
    const result = await executeDelegate(
      { agent_type: "explore", prompt: "inspect", background: false },
      makeContext({ subAgentManager: manager, currentDepth: 1 }),
    );

    expect(result).toBe("delegated output");
    expect(manager.lastOptions?.currentDepth).toBe(1);
    expect(manager.lastOptions?.background).toBe(false);
  });

  it("async delegation returns session_id immediately", async () => {
    const manager = new ToolStubManager();
    const result = await executeDelegate(
      { agent_type: "explore", prompt: "inspect", description: "Scan", background: true },
      makeContext({ subAgentManager: manager }),
    );

    expect(JSON.parse(result)).toEqual({ ok: true, session_id: manager.store.getState().sessionId });
    expect(manager.lastOptions?.description).toBe("Scan");
    expect(manager.lastOptions?.background).toBe(true);
  });

  it("returns structured sync errors with sessionId", async () => {
    const manager: SubAgentManagerLike = {
      activeCount: 0,
      createAgent() {
        throw new Error("cannot delegate");
      },
    };

    const result = await executeDelegate(
      { agent_type: "explore", prompt: "inspect", background: false },
      makeContext({ subAgentManager: manager }),
    );

    expect(JSON.parse(result)).toEqual({
      ok: false,
      sessionId: "",
      error: { name: "Error", message: "cannot delegate" },
    });
  });
});
