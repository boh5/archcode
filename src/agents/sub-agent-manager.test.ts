import { describe, expect, it } from "bun:test";
import type { StoreApi } from "zustand";
import { createSessionStore, getSessionStore } from "../store/store";
import type { SessionStoreState } from "../store/types";
import type { Registry as ProviderRegistry } from "../provider/index";
import type { ToolRegistry } from "../tools/index";
import type { AgentRegistry } from "./agent-registry";
import type { Agent, AgentResult } from "./orchestrator-agent";
import { ConcurrentLimitError, DepthLimitError } from "./errors";
import { SubAgentManager } from "./sub-agent-manager";

class StubAgent implements Agent {
  readonly store: StoreApi<SessionStoreState>;
  readonly signal: AbortSignal | undefined;
  private readonly behavior: "resolve" | "reject" | "hang" | "abort-aware";

  constructor(store: StoreApi<SessionStoreState>, signal: AbortSignal | undefined, behavior: "resolve" | "reject" | "hang" | "abort-aware") {
    this.store = store;
    this.signal = signal;
    this.behavior = behavior;
  }

  async run(userMessage: string): Promise<AgentResult> {
    this.store.getState().append({ type: "user-message", content: userMessage });
    if (this.behavior === "reject") throw new Error("boom");
    if (this.behavior === "hang") return new Promise(() => {});
    if (this.behavior === "abort-aware") {
      await new Promise<void>((resolve, reject) => {
        const signal = this.signal;
        if (signal?.aborted) {
          reject(new Error("aborted"));
          return;
        }
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        setTimeout(resolve, 50);
      });
    }
    this.store.getState().append({ type: "text-start" });
    this.store.getState().append({ type: "text-delta", text: "child result" });
    this.store.getState().append({ type: "text-end" });
    return { text: "child result", steps: 1 };
  }
}

function makeRegistry(behavior: "resolve" | "reject" | "hang" | "abort-aware" = "resolve"): AgentRegistry {
  return {
    list: () => ["explore"],
    getFactory: (agentType) => {
      expect(agentType).toBe("explore");
      return (options) => new StubAgent(options.store, options.abortSignal, behavior);
    },
  };
}

function makeManager(behavior: "resolve" | "reject" | "hang" | "abort-aware" = "resolve", timeoutMs = 50) {
  const parentStore = createSessionStore(`parent-${crypto.randomUUID()}`);
  const manager = new SubAgentManager({
    parentStore,
    providerRegistry: {} as ProviderRegistry,
    toolRegistry: {} as ToolRegistry,
    workspaceRoot: import.meta.dir,
    registry: makeRegistry(behavior),
    timeoutMs,
  });
  return { parentStore, manager };
}

describe("SubAgentManager", () => {
  it("creates explore agents through registry and links child sessions", async () => {
    const { parentStore, manager } = makeManager();

    const handle = manager.createAgent("explore", "inspect", { description: "Inspect files" });

    expect(manager.activeCount).toBe(1);
    expect(parentStore.getState().childSessionIds.has(handle.sessionId)).toBe(true);
    expect(parentStore.getState().subAgentDescriptions.get(handle.sessionId)).toBe("Inspect files");
    expect(getSessionStore(handle.sessionId)).toBe(handle.store);
    await handle.result;
    expect(manager.activeCount).toBe(0);
  });

  it("throws DepthLimitError at depth 2", () => {
    const { manager } = makeManager();
    expect(() => manager.createAgent("explore", "too deep", { currentDepth: 2 })).toThrow(DepthLimitError);
  });

  it("throws ConcurrentLimitError for the 11th active child", () => {
    const { manager } = makeManager("hang", 1000);
    const handles = [];
    for (let i = 0; i < 10; i += 1) {
      const handle = manager.createAgent("explore", `job ${i}`);
      handle.result.catch(() => {});
      handles.push(handle);
    }
    expect(manager.activeCount).toBe(10);
    try {
      manager.createAgent("explore", "job 11");
      throw new Error("expected limit");
    } catch (error) {
      expect(error).toBeInstanceOf(ConcurrentLimitError);
      expect((error as ConcurrentLimitError).activeCount).toBe(10);
    }
    for (const handle of handles) {
      handle.abortController.abort(new Error("test cleanup"));
    }
  });

  it("cascades parent abort and cleans active count", async () => {
    const { manager } = makeManager("abort-aware", 1000);
    const parentAbort = new AbortController();
    const handle = manager.createAgent("explore", "abort", { parentAbort: parentAbort.signal });

    parentAbort.abort();
    await expect(handle.result).rejects.toThrow("aborted");
    expect(handle.abortController.signal.aborted).toBe(true);
    expect(manager.activeCount).toBe(0);
  });

  it("writes terminal reminders for async success and failure", async () => {
    const success = makeManager("resolve");
    const successHandle = success.manager.createAgent("explore", "ok", { background: true });
    await successHandle.result;
    expect(success.parentStore.getState().reminders.at(-1)?.source.type).toBe("subagent_completed");

    const failure = makeManager("reject");
    const failureHandle = failure.manager.createAgent("explore", "fail", { background: true });
    await expect(failureHandle.result).rejects.toThrow("boom");
    expect(failure.parentStore.getState().reminders.at(-1)?.source.type).toBe("subagent_failed");
    expect(failure.manager.activeCount).toBe(0);
  });

  it("times out sub-agents and cleans active count", async () => {
    const { parentStore, manager } = makeManager("hang", 10);
    const handle = manager.createAgent("explore", "timeout", { background: true });
    handle.result.catch(() => {});

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(handle.abortController.signal.aborted).toBe(true);
    expect(manager.activeCount).toBe(0);
    expect(parentStore.getState().reminders.at(-1)?.source.type).toBe("subagent_timed_out");
  });
});
