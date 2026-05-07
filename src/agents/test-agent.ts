import { randomUUID } from "node:crypto";
import type { StoreApi } from "zustand";
import type { Registry as ProviderRegistry } from "../provider/index";
import type { ModelInfo } from "../provider/model";
import { createSessionStore } from "../store/store";
import { BusyError } from "../store/types";
import type { SessionStoreState } from "../store/types";
import type { ToolRegistry } from "../tools/index";
import { runQueryLoop } from "./query/loop";

export interface Agent {
  readonly store: StoreApi<SessionStoreState>;
  run(userMessage: string, abort?: AbortSignal): Promise<AgentResult>;
}

export interface AgentResult {
  readonly text: string;
  readonly steps: number;
}

const DEFAULT_SYSTEM_PROMPT = "You are a helpful coding assistant.";

export class NoModelsConfiguredError extends Error {
  constructor() {
    super("No models configured in .specra.json");
    this.name = "NoModelsConfiguredError";
  }
}

export class AgentRunningError extends Error {
  constructor() {
    super("Agent is already running");
    this.name = "AgentRunningError";
  }
}

export interface TestAgentOptions {
  readonly providerRegistry: ProviderRegistry;
  readonly toolRegistry: ToolRegistry;
}

export class TestAgent implements Agent {
  readonly store: StoreApi<SessionStoreState>;
  private providerRegistry: ProviderRegistry;
  private toolRegistry: ToolRegistry;
  private modelInfo: ModelInfo;
  private running = false;

  constructor(options: TestAgentOptions) {
    this.providerRegistry = options.providerRegistry;
    this.toolRegistry = options.toolRegistry;

    const modelIds = this.providerRegistry.modelIds;
    if (modelIds.length === 0) {
      throw new NoModelsConfiguredError();
    }

    this.modelInfo = this.providerRegistry.getModel(modelIds[0]);
    this.store = createSessionStore(randomUUID());
  }

  async run(userMessage: string, abort?: AbortSignal): Promise<AgentResult> {
    if (this.running) {
      throw new AgentRunningError();
    }

    this.running = true;
    try {
      const result = await runQueryLoop(
        {
          model: this.modelInfo.model,
          toolRegistry: this.toolRegistry,
          // TODO: define allowed tool names once builtin tools are implemented
          agentTools: [],
          abort,
          systemPrompt: DEFAULT_SYSTEM_PROMPT,
          store: this.store,
        },
        userMessage,
      );
      return { text: result.text, steps: result.steps };
    } catch (error) {
      // Don't pollute an active session's store with loop-error on BusyError
      if (!(error instanceof BusyError)) {
        this.store.getState().append({
          type: "loop-error",
          step: -1,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    } finally {
      this.running = false;
    }
  }
}
