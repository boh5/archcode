import { homedir } from "node:os";
import { join } from "node:path";
import type { StoreApi } from "zustand";
import type { BackgroundTaskManager } from "../background/manager";
import { BackgroundTaskManager as DefaultBackgroundTaskManager } from "../background/manager";
import { CommandRegistry, createCompactCommand } from "../commands/index";
import type { SpecraConfig } from "../config/schema";
import type { MemoryRoots } from "../memory";
import type { Registry as ProviderRegistry } from "../provider/index";
import type { ModelInfo } from "../provider/model";
import { buildSystemPrompt, loadAgentsMd } from "../prompt/index";
import type { PromptContext, PromptEnv } from "../prompt/index";
import { createSessionStore } from "../store/store";
import { BusyError } from "../store/types";
import type { SessionStoreState } from "../store/types";
import type { AskUserCallback, ToolConfirmationCallback, ToolRegistry } from "../tools/index";
import { TOOL_OUTPUT_DIR, enforceQuota } from "../tools/index";
import { AgentRunningError, NoModelsConfiguredError } from "./errors";
import type { AgentDefinition, AgentFactoryLike } from "./factory-types";
import {
  createAutoCompactHook,
  createAutoInjectReminderHook,
  createMemoryConsolidationHook,
  createMemoryExtractionHook,
  createTitleGenerationHook,
  createTodoContinuationHook,
  createTranscriptSaveHook,
} from "./query/hooks";
import type { QueryLoopHooks } from "./query/loop-hooks";
import { runQueryLoop } from "./query/loop";
import type { Agent, AgentResult, AgentRunOptions } from "./types";

export interface ConfiguredAgentOptions {
  readonly definition: AgentDefinition;
  readonly providerRegistry: ProviderRegistry;
  readonly toolRegistry: ToolRegistry;
  readonly store?: StoreApi<SessionStoreState>;
  readonly confirmPermission?: ToolConfirmationCallback;
  readonly askUser?: AskUserCallback;
  readonly workspaceRoot?: string;
  readonly config?: SpecraConfig;
  readonly depth?: number;
  readonly backgroundTaskManager?: BackgroundTaskManager;
  readonly resolveAllowedTools: (definition: AgentDefinition, depth: number) => readonly string[];
  readonly agentFactory?: AgentFactoryLike;
  readonly quotaEnforcer?: (directory: string) => Promise<void>;
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

export class ConfiguredAgent implements Agent {
  readonly store: StoreApi<SessionStoreState>;
  private readonly definition: AgentDefinition;
  private readonly providerRegistry: ProviderRegistry;
  private readonly toolRegistry: ToolRegistry;
  private readonly modelInfo: ModelInfo;
  private readonly confirmPermission: ToolConfirmationCallback | undefined;
  private readonly askUserDefault: AskUserCallback | undefined;
  private readonly workspaceRoot: string;
  private readonly depth: number;
  private readonly memoryRoots: MemoryRoots;
  private readonly commandRegistry: CommandRegistry;
  private readonly autoCompactHook = createAutoCompactHook();
  private readonly backgroundTaskManager: BackgroundTaskManager | undefined;
  private readonly resolveAllowedTools: (definition: AgentDefinition, depth: number) => readonly string[];
  private readonly agentFactory: AgentFactoryLike | undefined;
  private readonly quotaEnforcer: (directory: string) => Promise<void>;
  private agentsMd: string | undefined;
  private agentsMdLoaded = false;
  private running = false;

  constructor(options: ConfiguredAgentOptions) {
    this.definition = options.definition;
    this.providerRegistry = options.providerRegistry;
    this.toolRegistry = options.toolRegistry;
    this.confirmPermission = options.confirmPermission;
    this.askUserDefault = options.askUser;
    this.store = options.store ?? createSessionStore(crypto.randomUUID());
    this.workspaceRoot = options.workspaceRoot ?? process.cwd();
    this.depth = options.depth ?? 0;
    this.backgroundTaskManager = options.backgroundTaskManager;
    this.resolveAllowedTools = options.resolveAllowedTools;
    this.agentFactory = options.agentFactory;
    this.quotaEnforcer = options.quotaEnforcer ?? (async (directory) => {
      await enforceQuota(directory);
    });
    this.memoryRoots = {
      project: join(this.workspaceRoot, ".specra", "memory"),
      user: join(homedir(), ".specra", "memory"),
    };

    const modelIds = this.providerRegistry.modelIds;
    if (modelIds.length === 0) {
      throw new NoModelsConfiguredError();
    }
    this.modelInfo = this.providerRegistry.getModel(modelIds[0]);

    this.commandRegistry = new CommandRegistry();
    this.commandRegistry.register(createCompactCommand(this.store, this.modelInfo, this.autoCompactHook.circuitBreaker));
  }

  async run(
    userMessage: string,
    abortOrOptions?: AbortSignal | AgentRunOptions,
    confirmPermission?: ToolConfirmationCallback,
  ): Promise<AgentResult> {
    const { abort, confirm, askUser } = this.parseRunOptions(abortOrOptions, confirmPermission);

    if (this.running) {
      throw new AgentRunningError();
    }

    this.running = true;
    const btm = this.backgroundTaskManager ?? new DefaultBackgroundTaskManager();
    const shouldDrainBackgroundTasks = this.backgroundTaskManager === undefined || this.definition.enforceToolOutputQuota === true;

    try {
      await this.enforceToolOutputQuotaIfNeeded();
      await this.ensureAgentsMd();

      const allowedTools = [...this.resolveAllowedTools(this.definition, this.depth)];
      const promptContext: PromptContext = {
        allowedTools,
        workspaceRoot: this.workspaceRoot,
        agentId: this.definition.promptAgentId,
        agentsMd: this.agentsMd,
        env: buildEnv(this.workspaceRoot),
        ...(this.definition.includeMemoryInPrompt ? { memoryRoots: this.memoryRoots } : {}),
      };
      const systemPrompt = await buildSystemPrompt(promptContext);
      const hooks = this.buildHooks(btm);
      let currentUserMessage = userMessage;

      while (true) {
        const result = await runQueryLoop(
          {
            modelInfo: this.modelInfo,
            toolRegistry: this.toolRegistry,
            allowedTools,
            workspaceRoot: this.workspaceRoot,
            confirmPermission: confirm,
            askUser,
            abort,
            systemPrompt,
            store: this.store,
            commandRegistry: this.commandRegistry,
            agentFactory: this.agentFactory,
            agentName: this.definition.name,
            currentDepth: this.depth,
            hooks,
          },
          currentUserMessage,
        );

        if (!this.hasUnconsumedTodoContinuation() || abort?.aborted) {
          return { text: result.text, steps: result.steps };
        }

        currentUserMessage = "";
      }
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
      if (shouldDrainBackgroundTasks) {
        await btm.drain(60000);
      }
    }
  }

  private parseRunOptions(
    abortOrOptions: AbortSignal | AgentRunOptions | undefined,
    confirmPermission: ToolConfirmationCallback | undefined,
  ): {
    abort: AbortSignal | undefined;
    confirm: ToolConfirmationCallback | undefined;
    askUser: AskUserCallback | undefined;
  } {
    if (abortOrOptions && typeof abortOrOptions === "object" && abortOrOptions instanceof AbortSignal) {
      return {
        abort: abortOrOptions,
        confirm: confirmPermission ?? this.confirmPermission,
        askUser: this.askUserDefault,
      };
    }

    if (abortOrOptions && typeof abortOrOptions === "object") {
      const opts = abortOrOptions as AgentRunOptions;
      return {
        abort: opts.abort,
        confirm: opts.confirmPermission ?? this.confirmPermission,
        askUser: opts.askUser ?? this.askUserDefault,
      };
    }

    return {
      abort: undefined,
      confirm: confirmPermission ?? this.confirmPermission,
      askUser: this.askUserDefault,
    };
  }

  private async ensureAgentsMd(): Promise<void> {
    if (this.agentsMdLoaded) return;
    this.agentsMd = (await loadAgentsMd(this.workspaceRoot)) ?? undefined;
    this.agentsMdLoaded = true;
  }

  private async enforceToolOutputQuotaIfNeeded(): Promise<void> {
    if (this.definition.enforceToolOutputQuota !== true) return;

    try {
      await this.quotaEnforcer(TOOL_OUTPUT_DIR);
    } catch (error) {
      console.warn(
        `[ConfiguredAgent] Failed to enforce tool output cache quota: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  private buildHooks(btm: BackgroundTaskManager): QueryLoopHooks {
    const hooks: QueryLoopHooks = {};
    const policy = this.definition.hooks;

    if (policy.autoCompact) {
      hooks.beforeModelBuild = [this.autoCompactHook.hook];
    }

    const beforeModelCall = [];
    if (policy.autoInjectReminder) {
      beforeModelCall.push(createAutoInjectReminderHook());
    }
    if (
      policy.titleGeneration === "enabled" ||
      (policy.titleGeneration === "unless-supplied" && !this.store.getState().title?.trim())
    ) {
      beforeModelCall.push(createTitleGenerationHook(btm));
    }
    if (beforeModelCall.length > 0) {
      hooks.beforeModelCall = beforeModelCall;
    }

    const afterLoopEnd = [];
    if (policy.todoContinuation) {
      const todoContinuation = createTodoContinuationHook();
      hooks.afterStepEnd = [todoContinuation.afterStepEnd];
      afterLoopEnd.push(todoContinuation.afterLoopEnd);
    }
    if (policy.transcriptSave) {
      afterLoopEnd.push(createTranscriptSaveHook(btm));
    }
    if (policy.memoryExtraction) {
      afterLoopEnd.push(createMemoryExtractionHook(btm, this.memoryRoots));
    }
    if (policy.memoryConsolidation) {
      afterLoopEnd.push(createMemoryConsolidationHook(btm, this.memoryRoots));
    }
    if (afterLoopEnd.length > 0) {
      hooks.afterLoopEnd = afterLoopEnd;
    }

    return hooks;
  }

  private hasUnconsumedTodoContinuation(): boolean {
    return this.store
      .getState()
      .reminders.some(
        (reminder) =>
          reminder.source.type === "todo_loop_continuation" &&
          reminder.delivery === "auto_inject" &&
          reminder.consumedAt === null,
      );
  }
}
