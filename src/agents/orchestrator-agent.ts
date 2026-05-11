import { join } from "node:path";
import { homedir } from "node:os";
import type { StoreApi } from "zustand";
import type { Registry as ProviderRegistry } from "../provider/index";
import type { ModelInfo } from "../provider/model";
import { CommandRegistry, createCompactCommand } from "../commands/index";
import { buildSystemPrompt, loadAgentsMd } from "../prompt/index";
import type { PromptContext, PromptEnv } from "../prompt/index";
import { createSessionStore } from "../store/store";
import { BusyError } from "../store/types";
import type { SessionStoreState } from "../store/types";
import type { ToolRegistry } from "../tools/index";
import type { AskUserCallback, ToolConfirmationCallback } from "../tools/index";
import { BackgroundTaskManager } from "../background/manager";
import type { SpecraConfig } from "../config/schema";
import { enforceQuota, TOOL_OUTPUT_DIR } from "../tools/index";
import { createAgentRegistry } from "./agent-registry";
import { runQueryLoop } from "./query/loop";
import {
  createAutoInjectReminderHook,
  createTodoContinuationHook,
  createTranscriptSaveHook,
  createTitleGenerationHook,
  createMemoryExtractionHook,
  createMemoryConsolidationHook,
  createAutoCompactHook,
} from "./query/hooks";
import { SubAgentManager } from "./sub-agent-manager";

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

export interface OrchestratorAgentOptions {
  readonly providerRegistry: ProviderRegistry;
  readonly toolRegistry: ToolRegistry;
  readonly confirmPermission?: ToolConfirmationCallback;
  readonly askUser?: AskUserCallback;
  readonly workspaceRoot?: string;
  readonly config?: SpecraConfig;
}

function buildEnv(workspaceRoot: string): PromptEnv {
  return {
    platform: process.platform,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
    cwd: workspaceRoot,
    date: new Date().toISOString().slice(0, 10),
  };
}

export class OrchestratorAgent implements Agent {
  readonly store: StoreApi<SessionStoreState>;
  private providerRegistry: ProviderRegistry;
  private toolRegistry: ToolRegistry;
  private modelInfo: ModelInfo;
  private confirmPermission: ToolConfirmationCallback | undefined;
  private askUserDefault: AskUserCallback | undefined;
  private workspaceRoot: string;
  private agentsMd: string | undefined;
  private agentsMdLoaded = false;
  private running = false;
  private subAgentManager: SubAgentManager;
  private config: SpecraConfig;
  private memoryRoots: { project: string; user: string };
  private autoCompactHook = createAutoCompactHook();
  private commandRegistry: CommandRegistry;

  constructor(options: OrchestratorAgentOptions) {
    this.providerRegistry = options.providerRegistry;
    this.toolRegistry = options.toolRegistry;
    this.confirmPermission = options.confirmPermission;
    this.askUserDefault = options.askUser;

    const modelIds = this.providerRegistry.modelIds;
    if (modelIds.length === 0) {
      throw new NoModelsConfiguredError();
    }

    this.modelInfo = this.providerRegistry.getModel(modelIds[0]);
    this.store = createSessionStore(crypto.randomUUID());
    this.workspaceRoot = options.workspaceRoot ?? process.cwd();
    this.config = options.config ?? { provider: {} } as SpecraConfig;
    this.memoryRoots = {
      project: join(this.workspaceRoot, ".specra", "memory"),
      user: join(homedir(), ".specra", "memory"),
    };
    this.commandRegistry = new CommandRegistry();
    this.commandRegistry.register(createCompactCommand(this.store, this.modelInfo, this.autoCompactHook.circuitBreaker));
    this.subAgentManager = new SubAgentManager({
      parentStore: this.store,
      providerRegistry: this.providerRegistry,
      toolRegistry: this.toolRegistry,
      workspaceRoot: this.workspaceRoot,
      registry: createAgentRegistry(),
    });
  }

  private async ensureAgentsMd(): Promise<void> {
    if (this.agentsMdLoaded) return;
    this.agentsMd = (await loadAgentsMd(this.workspaceRoot)) ?? undefined;
    this.agentsMdLoaded = true;
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
      await enforceQuota(TOOL_OUTPUT_DIR);
    } catch (error) {
      console.warn(
        `[OrchestratorAgent] Failed to enforce tool output cache quota: ${error instanceof Error ? error.message : error}`,
      );
    }
    const btm = new BackgroundTaskManager();
    try {
      await this.ensureAgentsMd();
      const allToolNames = this.toolRegistry.getAll().map((d) => d.name);

      const ctx: PromptContext = {
        allowedTools: allToolNames,
        workspaceRoot: this.workspaceRoot,
        agentId: "default",
        agentsMd: this.agentsMd,
        env: buildEnv(this.workspaceRoot),
        memoryRoots: this.memoryRoots,
      };

      const systemPrompt = await buildSystemPrompt(ctx);

      const result = await runQueryLoop(
        {
          modelInfo: this.modelInfo,
          toolRegistry: this.toolRegistry,
          allowedTools: allToolNames,
          confirmPermission: confirm,
          askUser,
          abort,
          systemPrompt,
          store: this.store,
          commandRegistry: this.commandRegistry,
          subAgentManager: this.subAgentManager,
          currentDepth: 0,
          hooks: {
            beforeModelBuild: [this.autoCompactHook.hook],
            beforeModelCall: [createAutoInjectReminderHook()],
            afterStepEnd: [
              createTodoContinuationHook({ subAgentManager: this.subAgentManager }),
              createTitleGenerationHook(btm, this.providerRegistry),
            ],
            afterLoopEnd: [
              createTranscriptSaveHook(),
              createMemoryExtractionHook(btm, this.providerRegistry, this.memoryRoots),
              createMemoryConsolidationHook(btm, this.providerRegistry, this.memoryRoots),
            ],
          },
        },
        userMessage,
      );
      return { text: result.text, steps: result.steps };
    } catch (error) {
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
      await btm.drain(60000);
    }
  }
}
