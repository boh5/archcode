import { homedir } from "node:os";
import { join } from "node:path";
import type { StoreApi } from "zustand";
import type { BackgroundTaskManager } from "../background/manager";
import { BackgroundTaskManager as DefaultBackgroundTaskManager } from "../background/manager";
import { CommandRegistry, createCompactCommand } from "../commands/index";
import type { CommandResult } from "../commands/types";
import type { ModelCallOptions } from "../config/index";
import type { MemoryRoots } from "../memory";
import { ProjectContextResolver } from "../projects/context-resolver";
import type { ProjectContext } from "../projects/types";
import type { Registry as ProviderRegistry } from "../provider/index";
import type { ModelInfo } from "../provider/model";
import { buildSystemPrompt, loadAgentsMd } from "../prompt/index";
import type { PromptContext, PromptEnv } from "../prompt/index";
import { createSessionStore } from "../store/store";
import { BusyError } from "../store/types";
import type { SessionStoreState } from "../store/types";
import type { AskUserCallback, ToolConfirmationCallback, ToolRegistry } from "../tools/index";
import { TOOL_OUTPUT_DIR, enforceQuota } from "../tools/index";
import { AgentRunningError, MissingProjectContextError } from "./errors";
import type { AgentFactoryLike } from "../delegation/types";
import type { AgentDefinition } from "./factory-types";
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
  readonly modelInfo: ModelInfo;
  readonly modelOptions?: ModelCallOptions;
  readonly toolRegistry: ToolRegistry;
  readonly store?: StoreApi<SessionStoreState>;
  readonly confirmPermission?: ToolConfirmationCallback;
  readonly askUser?: AskUserCallback;
  readonly workspaceRoot?: string;
  readonly depth?: number;
  readonly backgroundTaskManager?: BackgroundTaskManager;
  readonly projectContextResolver?: ProjectContextResolver;
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
  private readonly toolRegistry: ToolRegistry;
  private readonly modelInfo: ModelInfo;
  private readonly modelOptions: ModelCallOptions | undefined;
  private readonly confirmPermission: ToolConfirmationCallback | undefined;
  private readonly askUserDefault: AskUserCallback | undefined;
  private readonly workspaceRoot: string;
  private readonly projectContextResolver: ProjectContextResolver;
  private readonly depth: number;
  private readonly memoryRoots: MemoryRoots;
  private readonly commandRegistry: CommandRegistry;
  private readonly autoCompactHook = createAutoCompactHook();
  private readonly backgroundTaskManager: BackgroundTaskManager;
  private readonly ownsBackgroundTaskManager: boolean;
  private readonly resolveAllowedTools: (definition: AgentDefinition, depth: number) => readonly string[];
  private readonly agentFactory: AgentFactoryLike | undefined;
  private readonly quotaEnforcer: (directory: string) => Promise<void>;
  private agentsMd: string | undefined;
  private agentsMdLoaded = false;
  private running = false;
  private disposed = false;

  constructor(options: ConfiguredAgentOptions) {
    this.definition = options.definition;
    this.toolRegistry = options.toolRegistry;
    this.modelInfo = options.modelInfo;
    this.modelOptions = options.modelOptions;
    this.confirmPermission = options.confirmPermission;
    this.askUserDefault = options.askUser;
    this.store = options.store ?? createSessionStore(crypto.randomUUID());
    if (options.workspaceRoot === undefined) {
      throw new MissingProjectContextError("ConfiguredAgent requires options.workspaceRoot");
    }
    this.workspaceRoot = options.workspaceRoot;
    this.projectContextResolver = options.projectContextResolver ?? new ProjectContextResolver();
    this.depth = options.depth ?? 0;
    this.backgroundTaskManager = options.backgroundTaskManager ?? new DefaultBackgroundTaskManager();
    this.ownsBackgroundTaskManager = options.backgroundTaskManager === undefined;
    this.resolveAllowedTools = options.resolveAllowedTools;
    this.agentFactory = options.agentFactory;
    this.quotaEnforcer = options.quotaEnforcer ?? (async (directory) => {
      await enforceQuota(directory);
    });
    this.memoryRoots = {
      project: join(this.workspaceRoot, ".specra", "memory"),
      user: join(homedir(), ".specra", "memory"),
    };

    this.commandRegistry = new CommandRegistry();
    this.commandRegistry.register(
      createCompactCommand(
        this.store,
        this.modelInfo,
        this.autoCompactHook.circuitBreaker,
        this.modelOptions,
      ),
    );
  }

  async run(
    userMessage: string,
    abortOrOptions?: AbortSignal | AgentRunOptions,
    confirmPermission?: ToolConfirmationCallback,
  ): Promise<AgentResult> {
    if (this.disposed) {
      throw new Error("Agent has been disposed");
    }

    const { abort, confirm, askUser } = this.parseRunOptions(abortOrOptions, confirmPermission);

    if (this.running) {
      throw new AgentRunningError();
    }

    this.running = true;
    const btm = this.backgroundTaskManager;
    const shouldDrainBackgroundTasks = this.ownsBackgroundTaskManager || this.definition.enforceToolOutputQuota === true;

    try {
      await this.enforceToolOutputQuotaIfNeeded();
      await this.ensureAgentsMd();

      const allowedTools = [...this.resolveAllowedTools(this.definition, this.depth)];
      const projectContext: ProjectContext = await this.projectContextResolver.resolve(this.workspaceRoot);
      const promptContext: PromptContext = {
        allowedTools,
        workspaceRoot: this.workspaceRoot,
        agentId: this.definition.promptAgentId,
        rolePrompt: this.definition.rolePrompt,
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
            modelOptions: this.modelOptions,
            toolRegistry: this.toolRegistry,
            allowedTools,
            projectContext,
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

  async dispatchCommand(name: string, args?: string): Promise<CommandResult> {
    if (this.disposed) {
      throw new Error("Agent has been disposed");
    }

    const descriptor = this.commandRegistry.get(name);
    if (!descriptor) {
      return { success: false, message: `Unknown command: ${name}` };
    }

    return descriptor.handler(
      {
        store: this.store,
        modelInfo: this.modelInfo,
        modelOptions: this.modelOptions,
        abort: undefined,
      },
      args,
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.ownsBackgroundTaskManager) {
      this.backgroundTaskManager.cancelAll();
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
    const isCancelled = () => this.disposed;

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
      beforeModelCall.push(createTitleGenerationHook(btm, this.workspaceRoot, isCancelled));
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
      afterLoopEnd.push(createTranscriptSaveHook(btm, this.workspaceRoot, isCancelled));
    }
    if (policy.memoryExtraction) {
      afterLoopEnd.push(createMemoryExtractionHook(btm, this.memoryRoots, isCancelled));
    }
    if (policy.memoryConsolidation) {
      afterLoopEnd.push(createMemoryConsolidationHook(btm, this.memoryRoots, isCancelled));
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
