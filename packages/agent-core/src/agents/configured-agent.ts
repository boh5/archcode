import { homedir } from "node:os";
import { join } from "node:path";
import { PROJECT_STATE_DIR_NAME, USER_DATA_DIR_NAME } from "@archcode/protocol";
import type { StoreApi } from "zustand";
import type { BackgroundTaskManager } from "../background/manager";
import { BackgroundTaskManager as DefaultBackgroundTaskManager } from "../background/manager";
import { CommandRegistry, createCompactCommand, createSkillCommand } from "../commands/index";
import type { SlashCommandResult } from "../commands/types";
import type { MemoryExtractionConfig, ModelCallOptions } from "../config/index";
import type { MemoryRoots } from "../memory";
import type { ProjectContextResolver } from "../projects/context-resolver";
import type { ProjectContext } from "../projects/types";
import { createGoalBudgetEnforcementHooks } from "../goals/budget-enforcement";
import { createLoopBudgetEnforcementHooks } from "../loops/budget-hooks";
import type { ProviderRegistry } from "../provider/index";
import type { ModelInfo } from "../provider/model";
import type { SkillService } from "../skills";
import type { ResolvedSkill } from "../skills/types";
import { buildSystemPrompt, loadAgentsMd } from "../prompt/index";
import type { PromptContext, PromptEnv } from "../prompt/index";
import type { SessionStoreManager } from "../store/session-store-manager";
import { BusyError } from "../store/types";
import type { SessionStoreState } from "../store/types";
import type { Logger } from "../logger";
import type { AskUserCallback, ToolConfirmationCallback, ToolRegistry } from "../tools/index";
import { TOOL_OUTPUT_DIR, enforceQuota } from "../tools/index";
import { TOOL_WORKTREE_ENTER, TOOL_WORKTREE_EXIT } from "../tools/names";
import { AgentRunningError } from "./errors";
import type { ChildExecutionHandle, ChildExecutionRequest, ResumeChildRequest } from "../delegation/types";
import type { AgentDefinition } from "./factory-types";
import {
  createAutoInjectReminderHook,
  createHybridCompressionHook,
  createMemoryConsolidationHook,
  createMemoryExtractionHook,
  createTitleGenerationHook,
  createTodoContinuationHook,
} from "./query/hooks";
import type { QueryLoopHooks } from "./query/loop-hooks";
import { runQueryLoop } from "./query/loop";
import type { Agent, AgentResult, AgentRunOptions } from "./types";

export class UnknownExtraToolError extends Error {
  constructor(public readonly toolName: string) {
    super(`Unknown extra tool "${toolName}". Register the tool before passing it through AgentRunOptions.extraTools.`);
    this.name = "UnknownExtraToolError";
  }
}

export class IneligibleSessionWorktreeToolError extends Error {
  constructor(public readonly toolName: string) {
    super(`Session worktree tool "${toolName}" is not eligible for this Agent context.`);
    this.name = "IneligibleSessionWorktreeToolError";
  }
}

export interface ConfiguredAgentOptions {
  readonly definition: AgentDefinition;
  readonly providerRegistry: ProviderRegistry;
  readonly modelInfo: ModelInfo;
  readonly modelOptions?: ModelCallOptions;
  readonly toolRegistry: ToolRegistry;
  readonly skillService: SkillService;
  readonly storeManager: SessionStoreManager;
  readonly activeSkills?: readonly ResolvedSkill[];
  readonly store: StoreApi<SessionStoreState>;
  readonly confirmPermission?: ToolConfirmationCallback;
  readonly askUser?: AskUserCallback;
  /** Canonical project root used for persistent project/session state. */
  readonly projectRoot: string;
  /** Current Session execution directory used by prompts and filesystem tools. */
  readonly cwd: string;
  readonly depth?: number;
  readonly backgroundTaskManager?: BackgroundTaskManager;
  readonly projectContextResolver: ProjectContextResolver;
  readonly resolveAllowedTools: (definition: AgentDefinition, depth: number) => readonly string[];
  readonly startChildExecution?: (request: ChildExecutionRequest) => Promise<ChildExecutionHandle>;
  readonly cancelChildSession?: (workspaceRoot: string, parentSessionId: string, childSessionId: string) => boolean;
  readonly resumeChildSession?: (workspaceRoot: string, request: ResumeChildRequest) => Promise<ChildExecutionHandle>;
  readonly abortSessionExecutionAndWait?: (workspaceRoot: string, sessionId: string) => Promise<void>;
  readonly acquireSessionCwdTransition?: (workspaceRoot: string, sessionId: string) => () => void;
  readonly quotaEnforcer?: (directory: string) => Promise<void>;
  readonly memoryConfig?: MemoryExtractionConfig;
  readonly logger: Logger;
}

function buildEnv(projectRoot: string, cwd: string): PromptEnv {
  return {
    platform: process.platform,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
    projectRoot,
    cwd,
    date: new Date().toISOString().slice(0, 10),
  };
}

export class ConfiguredAgent implements Agent {
  readonly store: StoreApi<SessionStoreState>;
  readonly activeSkills: readonly ResolvedSkill[];
  private readonly definition: AgentDefinition;
  private readonly toolRegistry: ToolRegistry;
  private readonly skillService: SkillService;
  private readonly storeManager: SessionStoreManager;
  private readonly modelInfo: ModelInfo;
  private readonly modelOptions: ModelCallOptions | undefined;
  private readonly confirmPermission: ToolConfirmationCallback | undefined;
  private readonly askUserDefault: AskUserCallback | undefined;
  private readonly projectRoot: string;
  readonly cwd: string;
  private readonly projectContextResolver: ProjectContextResolver;
  private readonly depth: number;
  private readonly memoryRoots: MemoryRoots;
  private readonly commandRegistry: CommandRegistry;
  private readonly hybridCompressionHook: ReturnType<typeof createHybridCompressionHook>;
  private readonly backgroundTaskManager: BackgroundTaskManager;
  private readonly ownsBackgroundTaskManager: boolean;
  private readonly resolveAllowedTools: (definition: AgentDefinition, depth: number) => readonly string[];
  private readonly startChildExecution: ((request: ChildExecutionRequest) => Promise<ChildExecutionHandle>) | undefined;
  private readonly cancelChildSession: ((workspaceRoot: string, parentSessionId: string, childSessionId: string) => boolean) | undefined;
  private readonly resumeChildSession: ((workspaceRoot: string, request: ResumeChildRequest) => Promise<ChildExecutionHandle>) | undefined;
  private readonly abortSessionExecutionAndWait: ((workspaceRoot: string, sessionId: string) => Promise<void>) | undefined;
  private readonly acquireSessionCwdTransition: ((workspaceRoot: string, sessionId: string) => () => void) | undefined;
  private readonly quotaEnforcer: (directory: string) => Promise<void>;
  private readonly memoryConfig: MemoryExtractionConfig | undefined;
  private readonly logger: Logger;
  private agentsMd: string | undefined;
  private agentsMdLoaded = false;
  private running = false;
  private disposed = false;

  constructor(options: ConfiguredAgentOptions) {
    this.logger = options.logger.child({
      module: "agents.configured-agent",
      context: { agentName: options.definition.name },
    });
    this.hybridCompressionHook = createHybridCompressionHook(this.logger.child({ module: "compression.hybrid" }));
    this.definition = options.definition;
    this.toolRegistry = options.toolRegistry;
    this.skillService = options.skillService;
    this.storeManager = options.storeManager;
    this.activeSkills = options.activeSkills ?? [];
    this.modelInfo = options.modelInfo;
    this.modelOptions = options.modelOptions;
    this.confirmPermission = options.confirmPermission;
    this.askUserDefault = options.askUser;
    if (!options.store) throw new Error("ConfiguredAgent requires an explicit store");
    this.store = options.store;
    this.projectRoot = options.projectRoot;
    this.cwd = options.cwd;
    this.projectContextResolver = options.projectContextResolver;
    this.depth = options.depth ?? 0;
    this.backgroundTaskManager = options.backgroundTaskManager ?? new DefaultBackgroundTaskManager({
      logger: this.logger.child({ module: "background.manager" }),
    });
    this.ownsBackgroundTaskManager = options.backgroundTaskManager === undefined;
    this.resolveAllowedTools = options.resolveAllowedTools;
    this.startChildExecution = options.startChildExecution;
    this.cancelChildSession = options.cancelChildSession;
    this.resumeChildSession = options.resumeChildSession;
    this.abortSessionExecutionAndWait = options.abortSessionExecutionAndWait;
    this.acquireSessionCwdTransition = options.acquireSessionCwdTransition;
    this.memoryConfig = options.memoryConfig;
    this.quotaEnforcer = options.quotaEnforcer ?? (async (directory) => {
      await enforceQuota(directory, { logger: this.logger.child({ module: "tool.output.cache" }) });
    });
    this.memoryRoots = {
      project: join(this.projectRoot, PROJECT_STATE_DIR_NAME, "memory"),
      user: join(homedir(), USER_DATA_DIR_NAME, "memory"),
    };

    this.commandRegistry = new CommandRegistry();
    this.commandRegistry.register(
      createCompactCommand(
        this.store,
        this.modelInfo,
        this.hybridCompressionHook.circuitBreaker,
        this.modelOptions,
        this.logger.child({ module: "compact.command" }),
      ),
    );
    this.commandRegistry.register(
      createSkillCommand(),
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

    const { abort, confirm, askUser, maxSteps, origin, extraTools } = this.parseRunOptions(abortOrOptions, confirmPermission);

    if (this.running) {
      throw new AgentRunningError();
    }

    this.running = true;
    const btm = this.backgroundTaskManager;
    const shouldDrainBackgroundTasks = this.ownsBackgroundTaskManager || this.definition.enforceToolOutputQuota === true;

    try {
      await this.enforceToolOutputQuotaIfNeeded();
      await this.ensureAgentsMd();

      const definitionAllowedTools = [
        ...this.resolveAllowedTools(this.definition, this.depth),
        ...this.resolveSessionWorktreeTools(),
      ];
      const allowedTools = this.resolveEffectiveTools(definitionAllowedTools, extraTools);
      const agentSkills = this.definition.skills;
      const projectContext: ProjectContext = await this.projectContextResolver.resolve(this.projectRoot);
      const availableSkills = await this.skillService.listForAgent(this.cwd, agentSkills);
      const storeState = this.store.getState();
      const promptContext: PromptContext = {
        allowedTools,
        promptProfileId: this.definition.promptProfileId,
        rolePrompt: this.definition.rolePrompt,
        agentsMd: this.agentsMd,
        env: buildEnv(this.projectRoot, this.cwd),
        availableSkills,
        ...(this.activeSkills.length > 0 ? { activeSkills: this.activeSkills } : {}),
        ...(this.definition.includeMemoryInPrompt
          ? {
            memoryRoots: this.memoryRoots,
            ...(storeState.goalId === undefined ? {} : { goalId: storeState.goalId }),
            ...(storeState.sessionRole === undefined ? {} : { sessionRole: storeState.sessionRole }),
          }
          : {}),
      };
      const systemPrompt = await buildSystemPrompt(promptContext);
      const hooks = this.buildHooks(btm, origin);
      let currentUserMessage = userMessage;

      while (true) {
        const result = await runQueryLoop(
          {
            modelInfo: this.modelInfo,
            logger: this.logger,
            modelOptions: this.modelOptions,
            toolRegistry: this.toolRegistry,
            allowedTools,
            agentSkills,
            skillService: this.skillService,
            storeManager: this.storeManager,
            projectContext,
            cwd: this.cwd,
            confirmPermission: confirm,
            askUser,
            abort,
            systemPrompt,
            store: this.store,
            commandRegistry: this.commandRegistry,
            startChildExecution: this.startChildExecution,
            cancelChildSession: this.cancelChildSession,
            resumeChildSession: this.resumeChildSession,
            abortSessionExecutionAndWait: this.abortSessionExecutionAndWait,
            acquireSessionCwdTransition: this.acquireSessionCwdTransition,
            agentName: this.definition.name,
            currentDepth: this.depth,
            hooks,
            ...(maxSteps === undefined ? {} : { maxSteps }),
            ...(origin === undefined ? {} : { origin }),
          },
          currentUserMessage,
        );

        if (this.store.getState().blockedByHitlIds?.length) {
          return result;
        }

        if (result.cwdChanged !== undefined) return result;
        if (result.executionControl !== undefined) return result;

        if (!this.hasUnconsumedTodoContinuation() || abort?.aborted) {
          return result;
        }

        currentUserMessage = "";
      }
    } catch (error) {
      if (!(error instanceof BusyError)) {
        this.logger.error("agent.run.fatal", {
          error: error instanceof Error ? error.message : String(error),
        });
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

  async dispatchCommand(name: string, args?: string): Promise<SlashCommandResult> {
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
        cwd: this.cwd,
        agentName: this.definition.name,
        agentSkills: this.definition.skills,
        skillService: this.skillService,
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
    maxSteps: number | undefined;
    origin: AgentRunOptions["origin"];
    extraTools: readonly string[] | undefined;
  } {
    if (abortOrOptions && typeof abortOrOptions === "object" && abortOrOptions instanceof AbortSignal) {
      return {
        abort: abortOrOptions,
        confirm: confirmPermission ?? this.confirmPermission,
        askUser: this.askUserDefault,
        maxSteps: undefined,
        origin: undefined,
        extraTools: undefined,
      };
    }

    if (abortOrOptions && typeof abortOrOptions === "object") {
      const opts = abortOrOptions as AgentRunOptions;
      return {
        abort: opts.abort,
        confirm: opts.confirmPermission ?? this.confirmPermission,
        askUser: opts.askUser ?? this.askUserDefault,
        maxSteps: opts.maxSteps,
        origin: opts.origin,
        extraTools: opts.extraTools,
      };
    }

    return {
      abort: undefined,
      confirm: confirmPermission ?? this.confirmPermission,
      askUser: this.askUserDefault,
      maxSteps: undefined,
      origin: undefined,
      extraTools: undefined,
    };
  }

  private async ensureAgentsMd(): Promise<void> {
    if (this.agentsMdLoaded) return;
    this.agentsMd = (await loadAgentsMd(this.cwd)) ?? undefined;
    this.agentsMdLoaded = true;
  }

  private async enforceToolOutputQuotaIfNeeded(): Promise<void> {
    if (this.definition.enforceToolOutputQuota !== true) return;

    try {
      await this.quotaEnforcer(TOOL_OUTPUT_DIR);
    } catch (error) {
      this.logger.warn("tool.output.quota.failed", {
        error,
        meta: { directory: TOOL_OUTPUT_DIR },
      });
    }
  }

  private buildHooks(btm: BackgroundTaskManager, origin: AgentRunOptions["origin"]): QueryLoopHooks {
    const hooks: QueryLoopHooks = {};
    const policy = this.definition.hooks;
    const isCancelled = () => this.disposed;

    if (policy.autoCompact) {
      hooks.beforeModelBuild = [this.hybridCompressionHook.beforeModelBuild];
    }

    const beforeModelCall = [];
    if (policy.autoInjectReminder) {
      beforeModelCall.push(createAutoInjectReminderHook());
    }
    if (policy.autoCompact) {
      beforeModelCall.push(this.hybridCompressionHook.beforeModelCall);
    }
    if (
      policy.titleGeneration === "enabled" ||
      (policy.titleGeneration === "unless-supplied" && !this.store.getState().title?.trim())
    ) {
      beforeModelCall.push(createTitleGenerationHook(btm, this.projectRoot, isCancelled));
    }
    const budgetEnforcement = createGoalBudgetEnforcementHooks();
    const loopBudgetEnforcement = createLoopBudgetEnforcementHooks({
      origin,
      abortSessionExecutionAndWait: this.abortSessionExecutionAndWait,
    });
    beforeModelCall.push(budgetEnforcement.beforeModelCall);
    beforeModelCall.push(loopBudgetEnforcement.beforeModelCall);
    if (beforeModelCall.length > 0) {
      hooks.beforeModelCall = beforeModelCall;
    }

    const afterLoopEnd = [];
    if (policy.todoContinuation) {
      const todoContinuation = createTodoContinuationHook();
      hooks.afterStepEnd = [budgetEnforcement.afterStepEnd, loopBudgetEnforcement.afterStepEnd, todoContinuation.afterStepEnd];
      afterLoopEnd.push(todoContinuation.afterLoopEnd);
    } else {
      hooks.afterStepEnd = [budgetEnforcement.afterStepEnd, loopBudgetEnforcement.afterStepEnd];
    }
    // Memory hooks only run on the root orchestrator (depth 0).
    // Sub-agents at depth > 0 must not write to project/user memory independently.
    const isRootAgent = this.depth === 0;
    const memoryEnabled = this.memoryConfig?.enabled ?? true;
    if (memoryEnabled && policy.memoryExtraction && isRootAgent) {
      afterLoopEnd.push(createMemoryExtractionHook(btm, this.memoryRoots, isCancelled, this.memoryConfig));
    }
    if (memoryEnabled && policy.memoryConsolidation && isRootAgent) {
      afterLoopEnd.push(createMemoryConsolidationHook(btm, this.memoryRoots, isCancelled, this.memoryConfig));
    }
    if (afterLoopEnd.length > 0) {
      hooks.afterLoopEnd = afterLoopEnd;
    }

    return hooks;
  }

  private resolveEffectiveTools(
    definitionAllowedTools: readonly string[],
    extraTools: readonly string[] | undefined,
  ): string[] {
    const seen = new Set<string>();
    const eligible = new Set(definitionAllowedTools);
    const merged: string[] = [];

    for (const toolName of definitionAllowedTools) {
      if (seen.has(toolName)) continue;
      seen.add(toolName);
      merged.push(toolName);
    }

    for (const toolName of extraTools ?? []) {
      if (
        (toolName === TOOL_WORKTREE_ENTER || toolName === TOOL_WORKTREE_EXIT)
        && !eligible.has(toolName)
      ) {
        throw new IneligibleSessionWorktreeToolError(toolName);
      }
      if (this.toolRegistry.get(toolName) === undefined) {
        throw new UnknownExtraToolError(toolName);
      }
      if (seen.has(toolName)) continue;
      seen.add(toolName);
      merged.push(toolName);
    }

    return merged;
  }

  private resolveSessionWorktreeTools(): string[] {
    const state = this.store.getState();
    if (
      this.depth !== 0
      || this.definition.name !== "orchestrator"
      || state.parentSessionId !== undefined
      || state.goalId !== undefined
      || state.loopId !== undefined
    ) return [];

    const toolName = this.cwd === this.projectRoot ? TOOL_WORKTREE_ENTER : TOOL_WORKTREE_EXIT;
    return this.toolRegistry.get(toolName) === undefined ? [] : [toolName];
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
