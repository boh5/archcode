import { randomUUID } from "node:crypto";
import type { StoreApi } from "zustand";
import type { SpecraConfig } from "../config/index";
import { createRegistry } from "../provider/registry";
import type { ModelInfo } from "../provider/model";
import { createSessionStore } from "../store/store";
import { BusyError } from "../store/types";
import type { SessionStoreState } from "../store/types";
import { runQueryLoop } from "./query/loop";

export interface Agent {
  readonly store: StoreApi<SessionStoreState>;
  run(userMessage: string): Promise<AgentResult>;
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

export class TestAgent implements Agent {
  readonly store: StoreApi<SessionStoreState>;
  private registry: ReturnType<typeof createRegistry>;
  private modelInfo: ModelInfo;
  private running = false;

  constructor(config: SpecraConfig) {
    this.registry = createRegistry(config.provider);

    const modelIds = this.registry.modelIds;
    if (modelIds.length === 0) {
      throw new NoModelsConfiguredError();
    }

    this.modelInfo = this.registry.getModel(modelIds[0]);
    this.store = createSessionStore(randomUUID());
  }

  async run(userMessage: string): Promise<AgentResult> {
    if (this.running) {
      throw new AgentRunningError();
    }

    this.running = true;
    try {
      const result = await runQueryLoop(
        {
          model: this.modelInfo.model,
          tools: {},
          toolExecutors: {},
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
