import { homedir } from "node:os";
import { join } from "node:path";
import {
  PROJECT_STATE_DIR_NAME,
  USER_DATA_DIR_NAME,
  type McpServerStatus,
  type ProjectTodo,
  type PromptTraceSnapshot,
} from "@archcode/protocol";
import type { StoreApi } from "zustand";
import type { BackgroundTaskManager } from "../background/manager";
import { BackgroundTaskManager as DefaultBackgroundTaskManager } from "../background/manager";
import { CommandRegistry, createCompactCommand, createSkillCommand } from "../commands/index";
import type { MemoryExtractionConfig } from "../config/index";
import type { ExecutionModelBinding } from "../models";
import type { MemoryRoots } from "../memory";
import { MemoryFileManager } from "../memory/file-manager";
import type { ProjectContextResolver } from "../projects/context-resolver";
import { projectRuntimePath } from "../projects/runtime-path";
import type { ProjectContext } from "../projects/types";
import { SkillNotFoundError, type SkillService } from "../skills";
import type { ResolvedSkill } from "../skills/types";
import { AgentsMdLoadError, PromptContractCompiler, createFailedPromptTrace, loadAgentsMd } from "../prompt/index";
import type { CompiledPromptContract, PromptContractV2, PromptEnv, PromptMemorySnapshot, PromptSource, RuntimePromptEnvelope } from "../prompt/index";
import type { SessionStoreManager } from "../store/session-store-manager";
import { BusyError } from "../store/types";
import type { SessionStoreState } from "../store/types";
import type { Logger } from "../logger";
import type { ToolRegistry } from "../tools/index";
import type { ToolOutputAccessService } from "../tool-output/access-service";
import type { SessionGoalService } from "../session-goal";
import type { AttachmentModelProjector } from "../attachments";
import { TOOL_WORKTREE_ENTER, TOOL_WORKTREE_EXIT } from "../tools/names";
import type { ChildExecutionHandle, ChildExecutionRequest, ResumeChildRequest } from "../delegation/types";
import type { VersionControl, VersionControlDetector } from "../version-control/detector";
import type { AgentDefinition } from "./factory-types";
import {
  createAutoInjectReminderHook,
  createHybridCompressionHook,
  createMemoryConsolidationHook,
  createMemoryExtractionHook,
  createTitleGenerationHook,
  createTodoContinuationHook,
} from "./query/hooks";
import type { AfterLoopEndContext, QueryLoopHooks } from "./query/loop-hooks";
import { DEFAULT_QUERY_MAX_STEPS, runQueryLoop } from "./query/loop";
import type { Agent, AgentCommand, AgentCommandResult, AgentResult, AgentRunOptions } from "./types";

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
  readonly toolRegistry: ToolRegistry;
  readonly skillService: SkillService;
  readonly storeManager: SessionStoreManager;
  readonly store: StoreApi<SessionStoreState>;
  readonly toolOutputAccess: ToolOutputAccessService;
  readonly attachmentProjector: AttachmentModelProjector;
  readonly resolveAttachmentReadPaths: (
    workspaceRoot: string,
    rootSessionId: string,
  ) => Promise<ReadonlySet<string>>;
  /** Canonical project root used for persistent project/session state. */
  readonly projectRoot: string;
  /** Current Session execution directory used by prompts and filesystem tools. */
  readonly cwd: string;
  readonly depth?: number;
  readonly backgroundTaskManager?: BackgroundTaskManager;
  readonly projectContextResolver: ProjectContextResolver;
  readonly sessionGoalService?: SessionGoalService;
  readonly resolveVersionControl: VersionControlDetector;
  readonly resolveAllowedTools: (definition: AgentDefinition, depth: number) => readonly string[];
  readonly startChildExecution?: (request: ChildExecutionRequest) => Promise<ChildExecutionHandle>;
  readonly cancelChildSession?: (workspaceRoot: string, parentSessionId: string, childSessionId: string) => boolean;
  readonly resumeChildSession?: (workspaceRoot: string, request: ResumeChildRequest) => Promise<ChildExecutionHandle>;
  readonly acquireSessionCwdTransition?: (workspaceRoot: string, sessionId: string) => () => void;
  readonly resolveMcpStatuses?: () => ReadonlyMap<string, McpServerStatus>;
  readonly memoryConfig?: MemoryExtractionConfig;
  readonly logger: Logger;
}

function buildEnv(projectRoot: string, cwd: string, versionControl: VersionControl): PromptEnv {
  return {
    platform: process.platform,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
    projectRoot,
    cwd,
    versionControl,
    date: new Date().toISOString().slice(0, 10),
  };
}

export function mapMcpServerStatusForPrompt(status: McpServerStatus | undefined): RuntimePromptEnvelope["mcp"][string] {
  if (status === undefined || status.state === "pending") return "pending";
  if (status.state === "failed" || status.state === "disabled") return "failed";
  if (status.toolCount === 0) return "ready-zero";
  return status.warningCount > 0 ? "partial-warning" : "ready";
}

function durablePromptTrace(trace: CompiledPromptContract["trace"]): PromptTraceSnapshot {
  return {
    version: "2",
    status: trace.status,
    hash: trace.hash,
    sections: trace.sections.map((section) => ({ ...section })),
    skills: {
      status: trace.skills.status,
      active: trace.skills.active.map((skill) => ({ ...skill })),
    },
    visibleTools: [...trace.visibleTools],
    agentsMd: trace.agentsMd,
    memory: trace.memory,
    mcp: { ...trace.mcp },
    warnings: [...trace.warnings],
  };
}

export function buildLifecycleCurrentContext(
  todo: Pick<ProjectTodo, "id" | "content" | "revision" | "status" | "rejectionReason" | "archivedAt"> | undefined,
  plan: {
    readonly path: string;
    readonly state: "present" | "absent";
  } | undefined,
): string[] {
  return [
    `todoId=${todo?.id ?? "none"}`,
    `todoRevision=${todo?.revision ?? "none"}`,
    `todoStatus=${todo?.status ?? "none"}`,
    `todoArchived=${todo === undefined ? "none" : todo.archivedAt === undefined ? "false" : "true"}`,
    `todoRejectionReason=${todo?.rejectionReason === undefined ? "none" : JSON.stringify(todo.rejectionReason)}`,
    `todoContent=${todo === undefined ? "none" : JSON.stringify(todo.content)}`,
    `todoPlanPath=${plan === undefined ? "none" : JSON.stringify(plan.path)}`,
    `todoPlanState=${plan?.state ?? "none"}`,
  ];
}

export class ConfiguredAgent implements Agent {
  readonly store: StoreApi<SessionStoreState>;
  private readonly definition: AgentDefinition;
  private readonly toolRegistry: ToolRegistry;
  private readonly skillService: SkillService;
  private readonly storeManager: SessionStoreManager;
  private readonly toolOutputAccess: ToolOutputAccessService;
  private readonly attachmentProjector: AttachmentModelProjector;
  private readonly resolveAttachmentReadPaths: ConfiguredAgentOptions["resolveAttachmentReadPaths"];
  private readonly projectRoot: string;
  readonly cwd: string;
  private readonly projectContextResolver: ProjectContextResolver;
  private readonly sessionGoalService: SessionGoalService | undefined;
  private readonly resolveVersionControl: VersionControlDetector;
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
  private readonly acquireSessionCwdTransition: ((workspaceRoot: string, sessionId: string) => () => void) | undefined;
  private readonly resolveMcpStatuses: (() => ReadonlyMap<string, McpServerStatus>) | undefined;
  private readonly memoryConfig: MemoryExtractionConfig | undefined;
  private readonly logger: Logger;
  private agentsMd: PromptSource<string> = { status: "absent", source: "AGENTS.md search" };
  private disposed = false;

  constructor(options: ConfiguredAgentOptions) {
    this.logger = options.logger.child({
      module: "agents.configured-agent",
      context: { agentName: options.definition.name },
    });
    this.hybridCompressionHook = createHybridCompressionHook(
      this.logger.child({ module: "compression.hybrid" }),
      options.toolOutputAccess,
    );
    this.definition = options.definition;
    this.toolRegistry = options.toolRegistry;
    this.skillService = options.skillService;
    this.storeManager = options.storeManager;
    this.toolOutputAccess = options.toolOutputAccess;
    this.attachmentProjector = options.attachmentProjector;
    this.resolveAttachmentReadPaths = options.resolveAttachmentReadPaths;
    if (!options.store) throw new Error("ConfiguredAgent requires an explicit store");
    this.store = options.store;
    this.projectRoot = options.projectRoot;
    this.cwd = options.cwd;
    this.projectContextResolver = options.projectContextResolver;
    this.sessionGoalService = options.sessionGoalService;
    this.resolveVersionControl = options.resolveVersionControl;
    this.depth = options.depth ?? 0;
    this.backgroundTaskManager = options.backgroundTaskManager ?? new DefaultBackgroundTaskManager({
      logger: this.logger.child({ module: "background.manager" }),
    });
    this.ownsBackgroundTaskManager = options.backgroundTaskManager === undefined;
    this.resolveAllowedTools = options.resolveAllowedTools;
    this.startChildExecution = options.startChildExecution;
    this.cancelChildSession = options.cancelChildSession;
    this.resumeChildSession = options.resumeChildSession;
    this.acquireSessionCwdTransition = options.acquireSessionCwdTransition;
    this.resolveMcpStatuses = options.resolveMcpStatuses;
    this.memoryConfig = options.memoryConfig;
    this.memoryRoots = {
      project: projectRuntimePath(this.projectRoot, "memory"),
      user: join(homedir(), USER_DATA_DIR_NAME, "memory"),
    };

    this.commandRegistry = new CommandRegistry();
    this.commandRegistry.register(
      createCompactCommand(
        {
          circuitBreaker: this.hybridCompressionHook.circuitBreaker,
          logger: this.logger.child({ module: "compact.command" }),
        },
      ),
    );
    this.commandRegistry.register(
      createSkillCommand(),
    );
  }

  classifyCommand(input: string): AgentCommand | null {
    const parsed = this.commandRegistry.parse(input);
    if (parsed === null) return null;
    // /compact accepts no arguments. Inputs such as `/compact this` remain
    // ordinary model messages rather than being partially interpreted.
    if (parsed.command === "compact" && parsed.args.trim() !== "") return null;
    return { name: parsed.command, args: parsed.args };
  }

  async executeCommand(
    command: AgentCommand,
    binding: ExecutionModelBinding,
    options: Pick<AgentRunOptions, "abort"> = {},
  ): Promise<AgentCommandResult> {
    if (this.disposed) throw new Error("Agent has been disposed");
    options.abort?.throwIfAborted();

    const descriptor = this.commandRegistry.get(command.name);
    if (descriptor === undefined) {
      this.store.getState().append({
        type: "system-notice",
        message: `Unknown command: /${command.name}`,
      });
      await this.storeManager.flushSession(this.store.getState().sessionId, this.projectRoot);
      return { kind: "handled" };
    }

    const result = await descriptor.handler({
      store: this.store,
      binding,
      logger: this.logger,
      abort: options.abort,
      cwd: this.cwd,
      agentName: this.definition.name,
      agentSkills: this.definition.skills,
      skillService: this.skillService,
    }, command.args);
    if (command.name === "compact" && result.success) {
      await this.hybridCompressionHook.scheduleToolOutputRecoveryNotice();
    }
    options.abort?.throwIfAborted();
    this.store.getState().append({ type: "system-notice", message: result.message });
    await this.storeManager.flushSession(this.store.getState().sessionId, this.projectRoot);
    return result.continueAsMessage === undefined
      ? { kind: "handled" }
      : { kind: "message", content: result.continueAsMessage };
  }

  async run(binding: ExecutionModelBinding, options: AgentRunOptions): Promise<AgentResult> {
    if (this.disposed) {
      throw new Error("Agent has been disposed");
    }

    const {
      abort,
      executionId,
      runOrdinal,
      initialStep,
      maxSteps,
      extraTools,
      toolProjection,
      consumeSteers,
    } = options;

    const btm = this.backgroundTaskManager;
    const shouldDrainBackgroundTasks = this.ownsBackgroundTaskManager;

    try {
      await this.refreshAgentsMd();
      const projectContext: ProjectContext = await this.projectContextResolver.resolve(this.projectRoot);
      const state = this.store.getState();
      const baseAllowedTools = this.resolveAllowedTools(this.definition, this.depth);
      const definitionAllowedTools = [
        ...baseAllowedTools,
        ...this.resolveSessionWorktreeTools(),
      ];
      const allowedTools = this.resolveEffectiveTools(
        definitionAllowedTools,
        extraTools,
        toolProjection,
        this.definition.name === "discussion",
      );
      const agentSkills = this.definition.skills;
      const memory = await this.resolveMemorySnapshot();
      const mcpStatuses = this.resolveMcpStatuses?.() ?? new Map<string, McpServerStatus>();
      const env = buildEnv(
        this.projectRoot,
        this.cwd,
        await this.resolveVersionControl(this.cwd, abort),
      );
      let availableSkills: PromptContractV2["availableSkills"] = [];
      const activeSkills: ResolvedSkill[] = [];
      try {
        availableSkills = await this.skillService.listForAgent(this.cwd, agentSkills);
        for (const name of await this.resolveActiveSkillNames(projectContext)) {
          const skill = await this.skillService.readForAgent(this.cwd, name, this.definition.skills);
          if (skill === null) throw new SkillNotFoundError(name);
          activeSkills.push(skill);
        }
      } catch (error) {
        const contract = await this.buildPromptContract({
          allowedTools, availableSkills, activeSkills, env, projectContext, memory, mcpStatuses, binding,
        });
        const trace = durablePromptTrace(createFailedPromptTrace(contract, error, {
          status: "error",
          active: activeSkills.map((skill) => ({ name: skill.metadata.name, source: skill.path ?? skill.source })),
        }));
        this.store.getState().append({ type: "prompt-trace", trace });
        await this.storeManager.flushSession(this.store.getState().sessionId, this.projectRoot);
        throw error;
      }
      const compiler = new PromptContractCompiler();
      const resolveSystemPrompt = async (): Promise<string> => {
        const contract = await this.buildPromptContract({
          allowedTools,
          availableSkills,
          activeSkills,
          env,
          projectContext,
          memory,
          mcpStatuses,
          binding,
        });
        try {
          const compiled = await compiler.compile(contract);
          const trace = durablePromptTrace(compiled.trace);
          this.store.getState().append({ type: "prompt-trace", trace });
          await this.storeManager.flushSession(this.store.getState().sessionId, this.projectRoot);
          this.logger.debug("prompt.compiled", { meta: { ...compiled.trace } });
          return compiled.prompt;
        } catch (error) {
          const trace = durablePromptTrace(createFailedPromptTrace(contract, error));
          this.store.getState().append({ type: "prompt-trace", trace });
          await this.storeManager.flushSession(this.store.getState().sessionId, this.projectRoot);
          throw error;
        }
      };
      const hooks = this.buildHooks(btm);
      const prepareModelContext = this.sessionGoalService !== undefined
        && state.sessionId === state.rootSessionId
        && this.definition.name === "lead"
        ? async (): Promise<void> => {
            await this.sessionGoalService!.materializeModelContextNotices({
              workspaceRoot: this.projectRoot,
              sessionId: state.sessionId,
            });
          }
        : undefined;
      const totalMaxSteps = maxSteps ?? DEFAULT_QUERY_MAX_STEPS;
      let nextInitialStep = initialStep;
      while (true) {
        const result = await runQueryLoop(
          {
            executionId,
            runOrdinal,
            initialStep: nextInitialStep,
            binding,
            logger: this.logger,
            toolRegistry: this.toolRegistry,
            allowedTools,
            agentSkills,
            skillService: this.skillService,
            storeManager: this.storeManager,
            projectContext,
            ...(this.sessionGoalService === undefined ? {} : { sessionGoalService: this.sessionGoalService }),
            cwd: this.cwd,
            toolOutputAccess: this.toolOutputAccess,
            attachmentProjector: this.attachmentProjector,
            resolveAttachmentReadPaths: () => this.resolveAttachmentReadPaths(
              this.projectRoot,
              this.store.getState().rootSessionId,
            ),
            abort,
            resolveSystemPrompt,
            store: this.store,
            consumeSteers,
            ...(prepareModelContext === undefined ? {} : { prepareModelContext }),
            startChildExecution: this.startChildExecution,
            cancelChildSession: this.cancelChildSession,
            resumeChildSession: this.resumeChildSession,
            acquireSessionCwdTransition: this.acquireSessionCwdTransition,
            agentName: this.definition.name,
            currentDepth: this.depth,
            hooks,
            maxSteps: totalMaxSteps,
          },
        );

        if (result.outcome === "suspended") return result;
        if (this.store.getState().toolBatches.some((batch) => batch.archivedAt === undefined && batch.calls.some((call) => call.state === "blocked"))) {
          return result;
        }

        if (result.cwdChanged !== undefined) return result;
        if (result.steps >= totalMaxSteps || !this.hasUnconsumedTodoContinuation() || abort?.aborted) {
          return result;
        }
        nextInitialStep = result.steps;
      }
    } catch (error) {
      if (!(error instanceof BusyError)) {
        this.logger.error("agent.run.fatal", {
          error: error instanceof Error ? error.message : String(error),
        });
        this.store.getState().append({
          type: "execution-error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    } finally {
      if (shouldDrainBackgroundTasks) {
        await btm.drain(60000);
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.ownsBackgroundTaskManager) {
      this.backgroundTaskManager.cancelAll();
    }
  }

  private async refreshAgentsMd(): Promise<void> {
    try {
      const snapshot = await loadAgentsMd(this.cwd);
      this.agentsMd = snapshot === undefined
        ? { status: "absent", source: `upward search from ${this.cwd}` }
        : { status: "present", source: snapshot.path, value: snapshot.content };
    } catch (error) {
      this.agentsMd = {
        status: "error",
        source: error instanceof AgentsMdLoadError ? error.filePath : `upward search from ${this.cwd}`,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async buildPromptContract(input: {
    readonly allowedTools: readonly string[];
    readonly availableSkills: PromptContractV2["availableSkills"];
    readonly activeSkills: PromptContractV2["activeSkills"];
    readonly env: PromptEnv;
    readonly projectContext: ProjectContext;
    readonly memory: PromptSource<PromptMemorySnapshot>;
    readonly mcpStatuses: ReadonlyMap<string, McpServerStatus>;
    readonly binding: ExecutionModelBinding;
  }): Promise<PromptContractV2> {
    const state = this.store.getState();
    const todoId =
      state.parentSessionId !== undefined
        ? undefined
        : state.source?.kind === "todo"
          ? state.source.todoId
          : state.source?.kind === "automation" && state.source.todoId !== null
            ? state.source.todoId
            : undefined;
    const todo = todoId === undefined
      ? undefined
      : await input.projectContext.todos.readTodo(todoId);
    const planPath = todo === undefined
      ? undefined
      : `${PROJECT_STATE_DIR_NAME}/plans/${todo.id}.md`;
    const plan = planPath === undefined
      ? undefined
      : {
          path: planPath,
          state: await Bun.file(join(this.projectRoot, planPath)).exists() ? "present" as const : "absent" as const,
        };
    const parentAgentName = state.parentSessionId === undefined
      ? "none"
      : this.storeManager.get(state.parentSessionId, this.projectRoot)?.getState().agentName;
    if (parentAgentName === undefined) {
      throw new Error(`Parent Session "${state.parentSessionId}" identity is unavailable while compiling the Prompt contract`);
    }
    const allowedDelegateTargets = input.allowedTools.includes("delegate")
      ? [...(this.definition.tools.delegateTargets ?? [])]
      : [];
    const effectiveMaxDepth = this.definition.childPolicy?.maxDepth ?? this.depth;
    const runtime: RuntimePromptEnvelope = {
      agentName: this.definition.name,
      sessionId: state.sessionId,
      rootSessionId: state.rootSessionId,
      parentSessionId: state.parentSessionId ?? "none",
      parentAgentName,
      depth: this.depth,
      source: state.source ?? "child",
      allowedDelegateTargets,
      todo: todo === undefined ? "none" : { id: todo.id, mode: "bound" },
      remainingDepth: Math.max(0, effectiveMaxDepth - this.depth),
      maxConcurrentChildren: this.definition.childPolicy?.maxConcurrent ?? 0,
      mcp: Object.fromEntries((this.definition.mcpTools ?? []).map((server) => [server, mapMcpServerStatusForPrompt(input.mcpStatuses.get(server))])),
    };
    return {
      version: "2",
      role: this.definition.roleContract,
      runtime,
      allowedTools: input.allowedTools,
      availableSkills: input.availableSkills,
      activeSkills: input.activeSkills,
      guidanceAuthority: {
        skills: { kind: "guidance-only", grants: "none" },
        projectInstructions: { kind: "guidance-only", grants: "none" },
      },
      agentsMd: this.agentsMd,
      memory: input.memory,
      currentContext: buildLifecycleCurrentContext(todo, plan),
      delegationRequest: state.delegationRequest ?? "none",
      env: input.env,
    };
  }

  private async resolveMemorySnapshot(): Promise<PromptSource<PromptMemorySnapshot>> {
    if (!this.definition.includeMemoryInPrompt) return { status: "absent", source: "agent-definition" };
    try {
      const manager = new MemoryFileManager(this.memoryRoots);
      const [index, preferences] = await Promise.all([manager.readIndex(), manager.readPreferences()]);
      return {
        status: "present",
        source: "project-and-user-memory",
        value: { index: index ?? "none", preferences: preferences ?? "none" },
      };
    } catch (error) {
      return {
        status: "error",
        source: "project-and-user-memory",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private buildHooks(btm: BackgroundTaskManager): QueryLoopHooks {
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
    if (beforeModelCall.length > 0) {
      hooks.beforeModelCall = beforeModelCall;
    }

    const afterLoopEnd = [];
    if (policy.todoStepReminder || policy.todoQueryLoopContinuation) {
      const todoContinuation = createTodoContinuationHook();
      hooks.afterStepEnd = [
        ...(policy.todoStepReminder ? [todoContinuation.afterStepEnd] : []),
      ];
      if (policy.todoQueryLoopContinuation) afterLoopEnd.push(todoContinuation.afterLoopEnd);
    }
    // Memory hooks only run on a user-facing root Agent (depth 0).
    // Sub-agents at depth > 0 must not write to project/user memory independently.
    const isRootAgent = this.depth === 0;
    const memoryEnabled = this.memoryConfig?.enabled ?? true;
    if (memoryEnabled && policy.memoryExtraction && isRootAgent) {
      const extractMemory = createMemoryExtractionHook(btm, this.memoryRoots, isCancelled, this.memoryConfig);
      afterLoopEnd.push(async (context: AfterLoopEndContext) => {
        if (context.loopOutcome.kind === "terminal") await extractMemory(context);
      });
    }
    if (memoryEnabled && policy.memoryConsolidation && isRootAgent) {
      const consolidateMemory = createMemoryConsolidationHook(btm, this.memoryRoots, isCancelled, this.memoryConfig);
      afterLoopEnd.push(async (context: AfterLoopEndContext) => {
        if (context.loopOutcome.kind === "terminal") await consolidateMemory(context);
      });
    }
    if (afterLoopEnd.length > 0) {
      hooks.afterLoopEnd = afterLoopEnd;
    }

    return hooks;
  }

  private resolveEffectiveTools(
    definitionAllowedTools: readonly string[],
    extraTools: readonly string[] | undefined,
    toolProjection: readonly string[] | undefined,
    contextLocked = false,
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
      if (contextLocked && !eligible.has(toolName)) {
        throw new UnknownExtraToolError(toolName);
      }
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

    if (toolProjection === undefined) return merged;
    const allowed = new Set(merged);
    for (const toolName of toolProjection) {
      if (!allowed.has(toolName)) {
        throw new UnknownExtraToolError(toolName);
      }
    }
    return [...new Set(toolProjection)];
  }

  private resolveSessionWorktreeTools(): string[] {
    const state = this.store.getState();
    if (
      this.depth !== 0
      || this.definition.name !== "lead"
      || state.parentSessionId !== undefined
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

  private async resolveActiveSkillNames(_projectContext: ProjectContext): Promise<readonly string[]> {
    const state = this.store.getState();
    const names = [...state.activeSkillNames];
    if (state.parentSessionId !== undefined || state.sessionId !== state.rootSessionId) {
      return [...new Set(names)];
    }
    if (this.definition.name === "discussion") {
      return [...new Set(["shape-todo", ...names])];
    }
    if (this.definition.name !== "lead") return [...new Set(names)];

    const lifecycleSkill = state.goal?.status === "active"
        ? "run-goal"
        : "orchestrate-work";
    return [...new Set([lifecycleSkill, ...names])];
  }

}
