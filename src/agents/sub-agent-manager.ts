import type { StoreApi } from "zustand";
import type { Registry as ProviderRegistry } from "../provider/index";
import { createSessionStore } from "../store/store";
import type { Reminder, ReminderSource, SessionStoreState } from "../store/types";
import type { ToolRegistry } from "../tools/index";
import type { AgentRegistry, AgentType } from "./agent-registry";
import type { Agent, AgentResult } from "./orchestrator-agent";
import { ConcurrentLimitError, DepthLimitError } from "./errors";

export const DEFAULT_SUB_AGENT_TIMEOUT_MS = 20 * 60 * 1000;
export const MAX_SUB_AGENT_DEPTH = 2;
export const MAX_CONCURRENT_SUB_AGENTS = 10;

export type SubAgentTerminalStatus = "completed" | "failed" | "timed_out" | "cancelled";

export interface SubAgentRunHandle {
  readonly sessionId: string;
  readonly agent: Agent;
  readonly store: StoreApi<SessionStoreState>;
  readonly result: Promise<AgentResult>;
  readonly abortController: AbortController;
}

export interface CreateSubAgentOptions {
  readonly currentDepth?: number;
  readonly parentAbort?: AbortSignal;
  readonly description?: string;
  readonly background?: boolean;
}

interface ActiveChild {
  agent: Agent;
  store: StoreApi<SessionStoreState>;
  abortController: AbortController;
}

export interface SubAgentManagerOptions {
  readonly parentStore: StoreApi<SessionStoreState>;
  readonly providerRegistry: ProviderRegistry;
  readonly toolRegistry: ToolRegistry;
  readonly workspaceRoot: string;
  readonly registry: AgentRegistry;
  readonly timeoutMs?: number;
}

export class SubAgentManager {
  private readonly parentStore: StoreApi<SessionStoreState>;
  private readonly providerRegistry: ProviderRegistry;
  private readonly toolRegistry: ToolRegistry;
  private readonly workspaceRoot: string;
  private readonly registry: AgentRegistry;
  private readonly timeoutMs: number;
  private readonly activeChildren = new Map<string, ActiveChild>();

  constructor(options: SubAgentManagerOptions) {
    this.parentStore = options.parentStore;
    this.providerRegistry = options.providerRegistry;
    this.toolRegistry = options.toolRegistry;
    this.workspaceRoot = options.workspaceRoot;
    this.registry = options.registry;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_SUB_AGENT_TIMEOUT_MS;
  }

  get activeCount(): number {
    return this.activeChildren.size;
  }

  hasRunningSubAgents(): boolean {
    return this.activeCount > 0;
  }

  createAgent(agentType: AgentType, prompt: string, options: CreateSubAgentOptions = {}): SubAgentRunHandle {
    const currentDepth = options.currentDepth ?? 0;
    if (currentDepth >= MAX_SUB_AGENT_DEPTH) {
      throw new DepthLimitError(currentDepth);
    }
    if (this.activeCount >= MAX_CONCURRENT_SUB_AGENTS) {
      throw new ConcurrentLimitError(this.activeCount);
    }

    const sessionId = crypto.randomUUID();
    const childStore = createSessionStore(sessionId);
    childStore.setState({ parentSessionId: this.parentStore.getState().sessionId });

    const factory = this.registry.getFactory(agentType);
    const childAbortController = new AbortController();
    const timeout = setTimeout(() => childAbortController.abort(new Error("Sub-agent timed out")), this.timeoutMs);
    const removeParentAbort = wireAbortCascade(options.parentAbort, childAbortController);

    const childAgent = factory({
      store: childStore,
      providerRegistry: this.providerRegistry,
      toolRegistry: this.toolRegistry,
      workspaceRoot: this.workspaceRoot,
      abortSignal: childAbortController.signal,
      depth: currentDepth + 1,
    });

    this.parentStore.setState((state) => {
      const childSessionIds = new Set(state.childSessionIds);
      childSessionIds.add(sessionId);
      const subAgentDescriptions = new Map(state.subAgentDescriptions);
      if (options.description !== undefined) {
        subAgentDescriptions.set(sessionId, options.description);
      }
      return { childSessionIds, subAgentDescriptions };
    });

    this.activeChildren.set(sessionId, {
      agent: childAgent,
      store: childStore,
      abortController: childAbortController,
    });

    const result = runWithAbort(childAgent.run(prompt, { abort: childAbortController.signal }), childAbortController.signal).finally(() => {
      clearTimeout(timeout);
      removeParentAbort();
      this.activeChildren.delete(sessionId);
    });

    if (options.background === true) {
      result.then(
        () => this.appendTerminalReminder(sessionId, "completed"),
        (error) => this.appendTerminalReminder(sessionId, classifyTerminalStatus(error, childAbortController.signal)),
      );
    }

    return {
      sessionId,
      agent: childAgent,
      store: childStore,
      result,
      abortController: childAbortController,
    };
  }

  private appendTerminalReminder(sessionId: string, status: SubAgentTerminalStatus): void {
    const source = terminalSource(status, sessionId);
    const reminder: Reminder = {
      id: crypto.randomUUID(),
      source,
      delivery: "on_demand",
      sessionId,
      terminalState: status,
      content: `Sub-agent ${sessionId} ${formatStatus(status)}. Use background_output with this session_id to read the result.`,
      createdAt: Date.now(),
      consumedAt: null,
      targetSessionId: this.parentStore.getState().sessionId,
    };
    this.parentStore.getState().append({ type: "reminder", reminder });
  }
}

function runWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReasonToError(signal.reason));

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReasonToError(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function abortReasonToError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  if (reason !== undefined) return new Error(String(reason));
  return new Error("Sub-agent aborted");
}

function wireAbortCascade(parentAbort: AbortSignal | undefined, childController: AbortController): () => void {
  if (parentAbort === undefined) return () => {};
  const onAbort = () => childController.abort(parentAbort.reason);
  if (parentAbort.aborted) {
    onAbort();
    return () => {};
  }
  parentAbort.addEventListener("abort", onAbort, { once: true });
  return () => parentAbort.removeEventListener("abort", onAbort);
}

function classifyTerminalStatus(error: unknown, signal: AbortSignal): SubAgentTerminalStatus {
  if (signal.aborted) {
    const reason = signal.reason;
    if (reason instanceof Error && /timed out/i.test(reason.message)) return "timed_out";
    return "cancelled";
  }
  if (error instanceof Error && /timed out/i.test(error.message)) return "timed_out";
  return "failed";
}

function terminalSource(status: SubAgentTerminalStatus, sessionId: string): ReminderSource {
  if (status === "completed") return { type: "subagent_completed", sessionId };
  if (status === "timed_out") return { type: "subagent_timed_out", sessionId };
  if (status === "cancelled") return { type: "subagent_cancelled", sessionId };
  return { type: "subagent_failed", sessionId };
}

function formatStatus(status: SubAgentTerminalStatus): string {
  if (status === "timed_out") return "timed out";
  return status;
}
