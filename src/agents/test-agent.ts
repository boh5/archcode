import { randomUUID } from "node:crypto";
import type { StoreApi } from "zustand";
import type { Registry as ProviderRegistry } from "../provider/index";
import type { ModelInfo } from "../provider/model";
import { createSessionStore } from "../store/store";
import { BusyError } from "../store/types";
import type { SessionStoreState } from "../store/types";
import type { ToolRegistry } from "../tools/index";
import type { AskUserCallback, ToolConfirmationCallback } from "../tools/index";
import { runQueryLoop } from "./query/loop";

export interface AgentRunOptions {
  abort?: AbortSignal;
  confirmPermission?: ToolConfirmationCallback;
  askUser?: AskUserCallback;
}

export interface Agent {
  readonly store: StoreApi<SessionStoreState>;
  run(
    userMessage: string,
    abort?: AbortSignal,
    confirmPermission?: ToolConfirmationCallback,
  ): Promise<AgentResult>;
  run(userMessage: string, options?: AgentRunOptions): Promise<AgentResult>;
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
  readonly confirmPermission?: ToolConfirmationCallback;
  readonly askUser?: AskUserCallback;
}

export class TestAgent implements Agent {
  readonly store: StoreApi<SessionStoreState>;
  private providerRegistry: ProviderRegistry;
  private toolRegistry: ToolRegistry;
  private modelInfo: ModelInfo;
  private confirmPermission: ToolConfirmationCallback | undefined;
  private askUserDefault: AskUserCallback | undefined;
  private running = false;

  constructor(options: TestAgentOptions) {
    this.providerRegistry = options.providerRegistry;
    this.toolRegistry = options.toolRegistry;
    this.confirmPermission = options.confirmPermission;
    this.askUserDefault = options.askUser;

    const modelIds = this.providerRegistry.modelIds;
    if (modelIds.length === 0) {
      throw new NoModelsConfiguredError();
    }

    this.modelInfo = this.providerRegistry.getModel(modelIds[0]);
    this.store = createSessionStore(randomUUID());
  }

  async run(
    userMessage: string,
    abortOrOptions?: AbortSignal | AgentRunOptions,
    confirmPermission?: ToolConfirmationCallback,
  ): Promise<AgentResult> {
    let abort: AbortSignal | undefined;
    let confirm: ToolConfirmationCallback | undefined;
    let askUser: AskUserCallback | undefined;

    if (abortOrOptions && typeof abortOrOptions === "object" && abortOrOptions instanceof AbortSignal) {
      abort = abortOrOptions;
      confirm = confirmPermission ?? this.confirmPermission;
      askUser = this.askUserDefault;
    } else if (abortOrOptions && typeof abortOrOptions === "object") {
      const opts = abortOrOptions as AgentRunOptions;
      abort = opts.abort;
      confirm = opts.confirmPermission ?? this.confirmPermission;
      askUser = opts.askUser ?? this.askUserDefault;
    } else {
      abort = undefined;
      confirm = confirmPermission ?? this.confirmPermission;
      askUser = this.askUserDefault;
    }

    if (this.running) {
      throw new AgentRunningError();
    }

    this.running = true;
    try {
    const allToolNames = this.toolRegistry.getAll().map((d) => d.name);

    const result = await runQueryLoop(
      {
        model: this.modelInfo.model,
        toolRegistry: this.toolRegistry,
        allowedTools: allToolNames,
        confirmPermission: confirm,
        askUser,
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
