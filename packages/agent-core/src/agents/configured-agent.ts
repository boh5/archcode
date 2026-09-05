import { join } from "node:path";
import { lstat } from "node:fs/promises";
import {
  directChildContextCapacityViolation,
  projectLatestDirectChildContext,
  PROJECT_STATE_DIR_NAME,
  TOOL_BACKGROUND_OUTPUT,
  TOOL_CANCEL_SESSION,
  TOOL_GET_GOAL,
  TOOL_LIST_AGENTS,
  TOOL_OUTPUT_READ,
  TOOL_OUTPUT_SEARCH,
  TOOL_PDF_READ,
  TOOL_PROJECT_TODO_UPDATE,
  TOOL_RESUME_SESSION,
  TOOL_SEND_MESSAGE,
  TOOL_TOOL_SEARCH,
  TOOL_UPDATE_GOAL,
  TOOL_WAIT_FOR_REMINDER,
  type AgentTreeNode,
  type LoadedToolRef,
  type McpServerStatus,
  type ProjectTodo,
  type PromptTraceSnapshot,
  type ToolChildSessionLink,
  type ToolAuthorizationSnapshot,
} from "@archcode/protocol";
import type { AgentTreeProjection } from "@archcode/protocol";
import type { StoreApi } from "zustand";
import type { BackgroundTaskManager } from "../background/manager";
import { BackgroundTaskManager as DefaultBackgroundTaskManager } from "../background/manager";
import { CommandRegistry, createCompactCommand, createSkillCommand } from "../commands/index";
import type { ExecutionModelBinding } from "../models";
import type { MemoryPolicySnapshot } from "../memory";
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
import { ResolvedToolSet, type ToolRegistry } from "../tools/index";
import type { ToolOutputAccessService } from "../tool-output/access-service";
import type { SessionGoalService } from "../session-goal";
import type { AttachmentModelProjector } from "../attachments";
import { ProjectTodoNotFoundError } from "../todos/errors";
import { TOOL_WORKTREE_ENTER, TOOL_WORKTREE_EXIT } from "../tools/names";
import type {
  CancelDescendantSession,
  ChildExecutionHandle,
  ChildExecutionRequest,
  ResumeChildRequest,
  SendMessageToChild,
} from "../delegation/types";
import type { VersionControl, VersionControlDetector } from "../version-control/detector";
import type { AgentDefinition, AgentMcpToolSnapshot, DelegationCapabilitySnapshot } from "./factory-types";
import { projectModelToolDescriptors } from "./model-tool-projection";
import { isDelegationControlTool } from "./tool-filter";
import {
  buildDeferredToolDirectory,
  buildToolCatalog,
  buildToolSearchIndex,
  projectVisibleTools,
  searchToolCatalog,
  selectExactToolCatalogEntry,
  type ToolCatalog,
  type ToolCatalogInput,
  type ToolSearchQuery,
} from "./tool-visibility";
import {
  createAutoInjectReminderHook,
  createHybridCompressionHook,
  createTitleGenerationHook,
  createTodoContinuationHook,
} from "./query/hooks";
import type { QueryLoopHooks } from "./query/loop-hooks";
import { DEFAULT_QUERY_MAX_STEPS, runQueryLoop } from "./query/loop";
import type { Agent, AgentCommand, AgentCommandResult, AgentResult, AgentRunOptions } from "./types";

const PROMPT_MEMORY_READ_FAILURE =
  "kind=memory-read code=MEMORY_PROMPT_READ_FAILED Memory could not be read. Continue without Memory.";

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

export interface ToolVisibilityFacts {
  readonly activeRootGoal: boolean;
  readonly boundRootDiscussionTodo: boolean;
  readonly currentExecutionHasPdf: boolean;
  readonly hasRecoverableOutput: boolean;
  readonly hasDescendant: boolean;
  readonly hasRunningDirectChild: boolean;
  readonly hasBackgroundDirectChild: boolean;
  readonly hasNonterminalDirectChild: boolean;
  readonly hasNonterminalDescendant: boolean;
  readonly hasResumableDirectChild: boolean;
  readonly worktreeTool: typeof TOOL_WORKTREE_ENTER | typeof TOOL_WORKTREE_EXIT | null;
}

export interface LiveAuthorizedToolCatalog {
  readonly catalog: ToolCatalog;
  readonly localAuthorizedTools: readonly string[];
  readonly mcpStatuses: ReadonlyMap<string, McpServerStatus>;
}

interface ToolVisibilityAudit {
  readonly catalogDigest: string;
  readonly core: readonly string[];
  readonly state: readonly string[];
  readonly loaded: readonly string[];
  readonly deferredCount: number;
}

export function projectStateActivatedTools(facts: ToolVisibilityFacts): string[] {
  return [
    ...(facts.activeRootGoal ? [TOOL_GET_GOAL, TOOL_UPDATE_GOAL] : []),
    ...(facts.boundRootDiscussionTodo ? [TOOL_PROJECT_TODO_UPDATE] : []),
    ...(facts.currentExecutionHasPdf ? [TOOL_PDF_READ] : []),
    ...(facts.hasRecoverableOutput ? [TOOL_OUTPUT_READ, TOOL_OUTPUT_SEARCH] : []),
    ...(facts.hasDescendant ? [TOOL_LIST_AGENTS] : []),
    ...(facts.hasRunningDirectChild ? [TOOL_SEND_MESSAGE] : []),
    ...(facts.hasBackgroundDirectChild ? [TOOL_BACKGROUND_OUTPUT] : []),
    ...(facts.hasNonterminalDirectChild ? [TOOL_WAIT_FOR_REMINDER] : []),
    ...(facts.hasNonterminalDescendant ? [TOOL_CANCEL_SESSION] : []),
    ...(facts.hasResumableDirectChild ? [TOOL_RESUME_SESSION] : []),
    ...(facts.worktreeTool === null ? [] : [facts.worktreeTool]),
  ];
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
  readonly delegationCapabilities: DelegationCapabilitySnapshot;
  readonly startChildExecution?: (request: ChildExecutionRequest) => Promise<ChildExecutionHandle>;
  readonly cancelDescendantSession?: CancelDescendantSession;
  readonly sendMessageToChild?: SendMessageToChild;
  readonly resumeChildSession?: (workspaceRoot: string, request: ResumeChildRequest) => Promise<ChildExecutionHandle>;
  readonly getAgentTreeProjection?: (workspaceRoot: string, rootSessionId: string) => Promise<AgentTreeProjection>;
  readonly acquireSessionCwdTransition?: (workspaceRoot: string, sessionId: string) => () => void;
  readonly resolveMcpToolSnapshot?: (
    builtinServerNames: AgentDefinition["builtinMcpServers"],
  ) => AgentMcpToolSnapshot;
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
  if (status === undefined || status.state === "connecting") return "connecting";
  if (status.state === "disabled") return "disabled";
  if (status.state === "failed") return "failed";
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
      available: {
        includedEntries: trace.skills.available.includedEntries.map((entry) => ({ ...entry })),
        omittedCount: trace.skills.available.omittedCount,
        renderedText: trace.skills.available.renderedText,
        byteLength: trace.skills.available.byteLength,
      },
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
  private readonly commandRegistry: CommandRegistry;
  private readonly hybridCompressionHook: ReturnType<typeof createHybridCompressionHook>;
  private readonly backgroundTaskManager: BackgroundTaskManager;
  private readonly ownsBackgroundTaskManager: boolean;
  private readonly resolveAllowedTools: (definition: AgentDefinition, depth: number) => readonly string[];
  private readonly delegationCapabilities: DelegationCapabilitySnapshot;
  private readonly startChildExecution: ((request: ChildExecutionRequest) => Promise<ChildExecutionHandle>) | undefined;
  private readonly cancelDescendantSession: CancelDescendantSession | undefined;
  private readonly sendMessageToChild: SendMessageToChild | undefined;
  private readonly resumeChildSession: ((workspaceRoot: string, request: ResumeChildRequest) => Promise<ChildExecutionHandle>) | undefined;
  private readonly getAgentTreeProjection: ConfiguredAgentOptions["getAgentTreeProjection"];
  private readonly acquireSessionCwdTransition: ((workspaceRoot: string, sessionId: string) => () => void) | undefined;
  private readonly resolveMcpToolSnapshot: ConfiguredAgentOptions["resolveMcpToolSnapshot"];
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
    this.delegationCapabilities = options.delegationCapabilities;
    this.startChildExecution = options.startChildExecution;
    this.cancelDescendantSession = options.cancelDescendantSession;
    this.sendMessageToChild = options.sendMessageToChild;
    this.resumeChildSession = options.resumeChildSession;
    this.getAgentTreeProjection = options.getAgentTreeProjection;
    this.acquireSessionCwdTransition = options.acquireSessionCwdTransition;
    this.resolveMcpToolSnapshot = options.resolveMcpToolSnapshot;

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

  /** Semantic admission for a new logical Execution; shares the live catalog composition path. */
  async validateToolAuthorization(authorization: ToolAuthorizationSnapshot): Promise<void> {
    await this.resolveLiveAuthorizedToolCatalog(authorization);
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
    return result.pendingMessage === undefined
      ? { kind: "handled" }
      : {
          kind: "message",
          content: result.pendingMessage.content,
          executionSkillNames: result.pendingMessage.executionSkillNames,
        };
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
      toolAuthorizationSnapshot,
      loadedToolRefs,
      reconcileExecutionToolLoads,
      consumeSteers,
      executionSkillSnapshots,
      memoryPolicy,
    } = options;

    const btm = this.backgroundTaskManager;
    const shouldDrainBackgroundTasks = this.ownsBackgroundTaskManager;

    try {
      await this.refreshAgentsMd();
      const projectContext: ProjectContext = await this.projectContextResolver.resolve(this.projectRoot);
      const state = this.store.getState();
      // Reject malformed legacy or externally corrupted child state before any model boundary.
      // The same assertion runs again while rebuilding Current Context because children may
      // change between model steps.
      this.resolveCurrentDirectChildren(state.childSessionLinks);
      this.assertExecutionToolState(executionId, toolAuthorizationSnapshot, loadedToolRefs);
      const initialCatalog = await this.resolveLiveAuthorizedToolCatalog(toolAuthorizationSnapshot);
      const allowedTools = initialCatalog.localAuthorizedTools;
      const agentSkills = this.definition.skills;
      const memory = await this.resolveMemorySnapshot(projectContext, memoryPolicy);
      const env = buildEnv(
        this.projectRoot,
        this.cwd,
        await this.resolveVersionControl(this.cwd, abort),
      );
      let availableSkills: PromptContractV2["availableSkills"] = {
        includedEntries: [],
        omittedCount: 0,
        renderedText: "- none",
        byteLength: 6,
      };
      const staticActiveSkills: ResolvedSkill[] = [];
      try {
        availableSkills = await this.skillService.projectPromptCatalog(this.cwd, agentSkills);
        for (const name of await this.resolveStaticActiveSkillNames(executionSkillSnapshots)) {
          const skill = executionSkillSnapshots?.get(name)?.readEntry()
            ?? await this.skillService.readForAgent(this.cwd, name, this.definition.skills);
          if (skill === null) throw new SkillNotFoundError(name);
          staticActiveSkills.push(skill);
        }
      } catch (error) {
        const modelTools = await this.resolveVisibleModelTools({
          executionId,
          toolAuthorizationSnapshot,
          reconcileExecutionToolLoads,
        });
        const contract = await this.buildPromptContract({
          allowedTools: modelTools.tools.descriptors.map((descriptor) => descriptor.name),
          availableSkills,
          activeSkills: staticActiveSkills,
          env,
          projectContext,
          memory,
          mcpStatuses: modelTools.mcpStatuses,
          deferredToolDirectory: modelTools.deferredToolDirectory,
          toolVisibilityAudit: modelTools.audit,
          binding,
        });
        const trace = durablePromptTrace(createFailedPromptTrace(contract, error, {
          status: "error",
          available: availableSkills,
          active: staticActiveSkills.map((skill) => ({ name: skill.metadata.name, source: skill.sourceLabel })),
        }));
        this.store.getState().append({ type: "prompt-trace", trace });
        await this.storeManager.flushSession(this.store.getState().sessionId, this.projectRoot);
        throw error;
      }
      const compiler = new PromptContractCompiler();
      const resolveModelBoundary = async () => {
        const modelTools = await this.resolveVisibleModelTools({
          executionId,
          toolAuthorizationSnapshot,
          reconcileExecutionToolLoads,
        });
        let activeSkills: readonly ResolvedSkill[] = staticActiveSkills;
        try {
          activeSkills = await this.resolveBoundaryActiveSkills(staticActiveSkills);
          const contract = await this.buildPromptContract({
            allowedTools: modelTools.tools.descriptors.map((descriptor) => descriptor.name),
            availableSkills,
            activeSkills,
            env,
            projectContext,
            memory,
            mcpStatuses: modelTools.mcpStatuses,
            deferredToolDirectory: modelTools.deferredToolDirectory,
            toolVisibilityAudit: modelTools.audit,
            binding,
          });
          const compiled = await compiler.compile(contract);
          const trace = durablePromptTrace(compiled.trace);
          this.store.getState().append({ type: "prompt-trace", trace });
          await this.storeManager.flushSession(this.store.getState().sessionId, this.projectRoot);
          this.logger.debug("prompt.compiled", {
            meta: { ...compiled.trace, toolVisibility: modelTools.audit },
          });
          return {
            systemPrompt: compiled.prompt,
            tools: modelTools.tools,
            ...(modelTools.toolSearchVisible ? { catalogDigest: modelTools.catalog.digest } : {}),
          };
        } catch (error) {
          const contract = await this.buildPromptContract({
            allowedTools: modelTools.tools.descriptors.map((descriptor) => descriptor.name),
            availableSkills,
            activeSkills,
            env,
            projectContext,
            memory,
            mcpStatuses: modelTools.mcpStatuses,
            deferredToolDirectory: modelTools.deferredToolDirectory,
            toolVisibilityAudit: modelTools.audit,
            binding,
          });
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
            ...(executionSkillSnapshots === undefined ? {} : { executionSkillSnapshots }),
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
            resolveModelBoundary,
            resolveToolSearch: async (input) => this.resolveToolSearch({
              executionId,
              toolAuthorizationSnapshot,
              reconcileExecutionToolLoads,
              input,
            }),
            store: this.store,
            consumeSteers,
            ...(prepareModelContext === undefined ? {} : { prepareModelContext }),
            startChildExecution: this.startChildExecution,
            cancelDescendantSession: this.cancelDescendantSession,
            sendMessageToChild: this.sendMessageToChild,
            resumeChildSession: this.resumeChildSession,
            getAgentTreeProjection: this.getAgentTreeProjection,
            acquireSessionCwdTransition: this.acquireSessionCwdTransition,
            agentName: this.definition.name,
            currentDepth: this.depth,
            resolveSkillListTargetSkills: (agentType: string) => this.delegationCapabilities.targets
              .find((target) => target.agentName === agentType)
              ?.builtinSkillNames,
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
    readonly deferredToolDirectory: string | null;
    readonly toolVisibilityAudit: ToolVisibilityAudit;
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
    let todo: ProjectTodo | undefined;
    if (todoId !== undefined) {
      try {
        todo = await input.projectContext.todos.readTodo(todoId);
      } catch (error) {
        if (!(error instanceof ProjectTodoNotFoundError)) throw error;
      }
    }
    const planPath = todo === undefined
      ? undefined
      : join(this.projectRoot, PROJECT_STATE_DIR_NAME, "plans", `${todo.id}.md`);
    const plan = planPath === undefined
      ? undefined
      : {
          path: planPath,
          state: await isRegularFile(planPath) ? "present" as const : "absent" as const,
        };
    const parentAgentName = state.parentSessionId === undefined
      ? "none"
      : this.storeManager.get(state.parentSessionId, this.projectRoot)?.getState().agentName;
    if (parentAgentName === undefined) {
      throw new Error(`Parent Session "${state.parentSessionId}" identity is unavailable while compiling the Prompt contract`);
    }
    const allowedDelegateTargets = input.allowedTools.includes("delegate")
      ? this.delegationCapabilities.targets.map((target) => target.agentName)
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
      mcp: Object.fromEntries([...input.mcpStatuses].map(([server, status]) => [
        server,
        mapMcpServerStatusForPrompt(status),
      ])),
    };
    return {
      version: "2",
      role: this.definition.roleContract,
      runtime,
      allowedTools: input.allowedTools,
      deferredToolDirectory: input.deferredToolDirectory,
      availableSkills: input.availableSkills,
      activeSkills: input.activeSkills,
      guidanceAuthority: {
        skills: { kind: "guidance-only", grants: "none" },
        projectInstructions: { kind: "guidance-only", grants: "none" },
      },
      agentsMd: this.agentsMd,
      memory: input.memory,
      currentContext: [
        ...await this.buildCurrentContext(todo, plan),
        `toolCatalogDigest=${input.toolVisibilityAudit.catalogDigest}`,
        `toolDeferredCount=${input.toolVisibilityAudit.deferredCount}`,
      ],
      delegationRequest: state.delegationRequest ?? "none",
      env: input.env,
    };
  }

  private async buildCurrentContext(
    todo: ProjectTodo | undefined,
    plan: {
      readonly path: string;
      readonly state: "present" | "absent";
    } | undefined,
  ): Promise<readonly string[]> {
    const state = this.store.getState();
    const sessionTodos = [...state.todos]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((sessionTodo) => ({
        id: sessionTodo.id,
        content: sessionTodo.content,
        status: sessionTodo.status,
        ...(sessionTodo.createdAt === undefined ? {} : { createdAt: sessionTodo.createdAt }),
        ...(sessionTodo.updatedAt === undefined ? {} : { updatedAt: sessionTodo.updatedAt }),
      }));
    const directChildren = this.resolveCurrentDirectChildren(state.childSessionLinks);
    return [
      ...buildLifecycleCurrentContext(todo, plan),
      `sessionTodos=${JSON.stringify(sessionTodos)}`,
      `directChildren=${JSON.stringify(directChildren)}`,
    ];
  }

  private resolveCurrentDirectChildren(
    childSessionLinks: readonly ToolChildSessionLink[],
  ): readonly {
    readonly sessionId: string;
    readonly agentName: string;
    readonly profile: string;
    readonly title: string;
    readonly executionId: string | null;
    readonly status: string;
  }[] {
    const directChildren = projectLatestDirectChildContext(childSessionLinks);
    const capacityViolation = directChildContextCapacityViolation(directChildren);
    if (capacityViolation !== undefined) {
      throw new Error(`Current direct-child context violates its durable capacity: ${capacityViolation}`);
    }
    return directChildren;
  }

  private async resolveMemorySnapshot(
    projectContext: ProjectContext,
    memoryPolicy: MemoryPolicySnapshot,
  ): Promise<PromptSource<PromptMemorySnapshot>> {
    if (!this.definition.includeMemoryInPrompt) return { status: "absent", source: "agent-definition" };
    if (!memoryPolicy.policy.useMemory) return { status: "absent", source: "memory-policy" };
    try {
      const manifest = await projectContext.memory.readPromptManifest();
      return {
        status: "present",
        source: "project-and-user-memory",
        value: {
          index: manifest.index.availableForPrompt
            ? manifest.index.content ?? "none"
            : "[Project Memory index omitted because the project exceeds 200 topics. Manage it in Settings → Memory.]",
          preferences: manifest.preferences?.availableForPrompt === false
            ? "[Personal Memory omitted because preferences exceed 8 KiB. Manage it in Settings → Memory.]"
            : manifest.preferences?.content ?? "none",
        },
      };
    } catch {
      return {
        status: "error",
        source: "project-and-user-memory",
        error: PROMPT_MEMORY_READ_FAILURE,
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
    if (afterLoopEnd.length > 0) {
      hooks.afterLoopEnd = afterLoopEnd;
    }

    return hooks;
  }

  private async resolveVisibleModelTools(input: {
    readonly executionId: string;
    readonly toolAuthorizationSnapshot: ToolAuthorizationSnapshot;
    readonly reconcileExecutionToolLoads: AgentRunOptions["reconcileExecutionToolLoads"];
  }): Promise<{
    readonly catalog: ToolCatalog;
    readonly tools: ResolvedToolSet;
    readonly mcpStatuses: ReadonlyMap<string, McpServerStatus>;
    readonly deferredToolDirectory: string | null;
    readonly toolSearchVisible: boolean;
    readonly audit: ToolVisibilityAudit;
  }> {
    const [live, facts] = await Promise.all([
      this.resolveLiveAuthorizedToolCatalog(input.toolAuthorizationSnapshot),
      this.collectToolVisibilityFacts(input.executionId),
    ]);
    const loaded = this.resolveExecutionLoadedToolRefs(input.executionId);
    const stateTools = projectStateActivatedTools(facts);
    const projection = projectVisibleTools({
      catalog: live.catalog,
      core: this.definition.tools.core,
      state: stateTools,
      loaded,
    });
    if (projection.invalidLoadedRefs.length > 0) {
      await input.reconcileExecutionToolLoads(projection.invalidLoadedRefs);
    }
    return {
      catalog: live.catalog,
      tools: new ResolvedToolSet(projection.visible.map((entry) => entry.descriptor)),
      mcpStatuses: live.mcpStatuses,
      deferredToolDirectory: projection.toolSearchVisible
        ? buildDeferredToolDirectory(projection.deferred)
        : null,
      toolSearchVisible: projection.toolSearchVisible,
      audit: {
        catalogDigest: live.catalog.digest,
        core: visibleNamesFrom(this.definition.tools.core, projection.visible),
        state: visibleNamesFrom(stateTools, projection.visible),
        loaded: projection.loaded.map((entry) => entry.registryName),
        deferredCount: projection.deferred.length,
      },
    };
  }

  /** The only async composition boundary for an Agent's live authorized catalog. */
  async resolveLiveAuthorizedToolCatalog(
    authorization: ToolAuthorizationSnapshot,
  ): Promise<LiveAuthorizedToolCatalog> {
    const depthAuthorized = this.resolveAllowedTools(this.definition, this.depth);
    const depthAuthorizedSet = new Set(depthAuthorized);
    const eligibleWorktree = this.resolveSessionWorktreeTools();
    const eligibleLocal = new Set<string>();
    const localSourceKinds = new Map<string, "builtin" | "worktree" | "overlay">();
    const merged: string[] = [];
    for (const toolName of depthAuthorized) {
      if (eligibleLocal.has(toolName)) continue;
      eligibleLocal.add(toolName);
      localSourceKinds.set(toolName, "builtin");
      merged.push(toolName);
    }
    for (const toolName of eligibleWorktree) {
      if (eligibleLocal.has(toolName)) continue;
      eligibleLocal.add(toolName);
      localSourceKinds.set(toolName, "worktree");
      merged.push(toolName);
    }

    for (const toolName of authorization.extraTools) {
      if (
        (this.definition.name === "discussion" || isDelegationControlTool(toolName))
        && !depthAuthorizedSet.has(toolName)
      ) {
        throw new UnknownExtraToolError(toolName);
      }
      if (
        (toolName === TOOL_WORKTREE_ENTER || toolName === TOOL_WORKTREE_EXIT)
        && !eligibleLocal.has(toolName)
      ) {
        throw new IneligibleSessionWorktreeToolError(toolName);
      }
      if (this.toolRegistry.get(toolName) === undefined) throw new UnknownExtraToolError(toolName);
      if (!eligibleLocal.has(toolName)) {
        eligibleLocal.add(toolName);
        localSourceKinds.set(toolName, "overlay");
        merged.push(toolName);
      }
    }

    const localNames = authorization.toolProjection === null
      ? merged
      : authorization.toolProjection.map((toolName) => {
          if (!eligibleLocal.has(toolName)) throw new UnknownExtraToolError(toolName);
          return toolName;
        });
    const localDescriptors = projectModelToolDescriptors(
      this.toolRegistry.resolveForAgent(localNames).descriptors,
      this.delegationCapabilities,
    );
    const catalogInputs: ToolCatalogInput[] = localDescriptors.map((descriptor) => ({
      sourceKind: localSourceKinds.get(descriptor.name)!,
      namespace: "builtin",
      registryName: descriptor.name,
      descriptor,
    }));
    const mcp = this.resolveMcpToolSnapshot?.(this.definition.builtinMcpServers);
    const names = new Set(localDescriptors.map((descriptor) => descriptor.name));
    for (const [registryName, entry] of mcp?.tools ?? []) {
      if (names.has(registryName)) {
        throw new Error(`MCP tool alias "${registryName}" collides with an existing authorized tool`);
      }
      names.add(registryName);
      catalogInputs.push({
        sourceKind: "mcp",
        namespace: entry.serverName,
        registryName,
        descriptor: entry.descriptor,
      });
    }
    const catalog = await buildToolCatalog(catalogInputs);
    return {
      catalog,
      localAuthorizedTools: localDescriptors.map((descriptor) => descriptor.name),
      mcpStatuses: new Map(Object.entries(mcp?.statuses.servers ?? {})),
    };
  }

  private async resolveToolSearch(input: {
    readonly executionId: string;
    readonly toolAuthorizationSnapshot: ToolAuthorizationSnapshot;
    readonly reconcileExecutionToolLoads: AgentRunOptions["reconcileExecutionToolLoads"];
    readonly input: ToolSearchQuery;
  }) {
    const [live, facts] = await Promise.all([
      this.resolveLiveAuthorizedToolCatalog(input.toolAuthorizationSnapshot),
      this.collectToolVisibilityFacts(input.executionId),
    ]);
    const projection = projectVisibleTools({
      catalog: live.catalog,
      core: this.definition.tools.core,
      state: projectStateActivatedTools(facts),
      loaded: this.resolveExecutionLoadedToolRefs(input.executionId),
    });
    if (projection.invalidLoadedRefs.length > 0) {
      await input.reconcileExecutionToolLoads(projection.invalidLoadedRefs);
    }
    const selected = selectExactToolCatalogEntry(projection.deferred, input.input);
    const results = selected ?? searchToolCatalog(buildToolSearchIndex({
      digest: live.catalog.digest,
      entries: projection.deferred,
    }), input.input);
    return {
      catalogDigest: live.catalog.digest,
      namespaces: [...new Set(projection.deferred.map((entry) => entry.namespace))].sort(),
      matches: results.map(({ name, namespace, description, descriptorDigest }) => ({
        name,
        namespace,
        description,
        descriptorDigest,
      })),
    };
  }

  private async collectToolVisibilityFacts(executionId: string): Promise<ToolVisibilityFacts> {
    const state = this.store.getState();
    const directLinks = latestDirectChildLinks(state.childSessionLinks);
    const nonterminalDirectStatuses = new Set(["linked", "running", "waiting_for_human", "cancelling"]);
    const resumableDirectStatuses = new Set(["completed", "failed", "timed_out", "cancelled", "interrupted"]);
    const hasNonterminalDirectChild = directLinks.some((link) => nonterminalDirectStatuses.has(link.status));
    // Direct links answer every direct-child visibility fact. Only resolve the
    // family tree when all direct children are terminal and a deeper running
    // descendant could still require cancel_session. This avoids taking the
    // stable family-snapshot path while an already-known direct child is live.
    const tree = this.getAgentTreeProjection === undefined
      || directLinks.length === 0
      || hasNonterminalDirectChild
      ? undefined
      : await this.getAgentTreeProjection(this.projectRoot, state.rootSessionId);
    const currentNode = tree === undefined ? undefined : findAgentTreeNode(tree.root, state.sessionId);
    const descendants = currentNode === undefined ? [] : flattenAgentTreeChildren(currentNode);
    const currentExecutionHasPdf = state.messages.some((message) => (
      message.role === "user"
      && message.executionId === executionId
      && message.parts.some((part) => (
        part.type === "attachment"
        && part.completedAt !== undefined
        && part.attachment.mediaType === "application/pdf"
      ))
    ));
    return {
      activeRootGoal: this.definition.name === "lead"
        && state.parentSessionId === undefined
        && state.sessionId === state.rootSessionId
        && state.goal?.status === "active",
      boundRootDiscussionTodo: this.definition.name === "discussion"
        && state.parentSessionId === undefined
        && state.sessionId === state.rootSessionId
        && state.source?.kind === "todo",
      currentExecutionHasPdf,
      hasRecoverableOutput: await this.toolOutputAccess.countRecoverableForExecution(executionId) > 0,
      hasDescendant: directLinks.length > 0,
      hasRunningDirectChild: directLinks.some((link) => link.status === "running"),
      hasBackgroundDirectChild: directLinks.some((link) => link.background),
      hasNonterminalDirectChild,
      hasNonterminalDescendant: descendants.some((node) => (
        node.latestExecutionStatus === "running" || node.latestExecutionStatus === "suspended"
      )) || directLinks.some((link) => nonterminalDirectStatuses.has(link.status)),
      hasResumableDirectChild: (currentNode?.children ?? []).some((node) => (
        node.latestExecutionStatus !== null
        && node.latestExecutionStatus !== "running"
        && node.latestExecutionStatus !== "suspended"
      )) || directLinks.some((link) => resumableDirectStatuses.has(link.status)),
      worktreeTool: this.resolveSessionWorktreeTools()[0] ?? null,
    };
  }

  private resolveExecutionLoadedToolRefs(executionId: string): readonly LoadedToolRef[] {
    const record = this.store.getState().executions.find((execution) => execution.id === executionId);
    if (record === undefined) throw new Error(`Execution "${executionId}" is unavailable while resolving loaded tools`);
    return record.loadedToolRefs;
  }

  private assertExecutionToolState(
    executionId: string,
    authorization: ToolAuthorizationSnapshot,
    loadedToolRefs: readonly LoadedToolRef[],
  ): void {
    const record = this.store.getState().executions.find((execution) => execution.id === executionId);
    if (record === undefined) throw new Error(`Execution "${executionId}" is unavailable while starting Agent.run`);
    if (JSON.stringify(record.toolAuthorizationSnapshot) !== JSON.stringify(authorization)) {
      throw new Error(`Execution "${executionId}" tool authorization snapshot does not match Agent.run`);
    }
    if (JSON.stringify(record.loadedToolRefs) !== JSON.stringify(loadedToolRefs)) {
      throw new Error(`Execution "${executionId}" loaded tool refs do not match Agent.run`);
    }
  }

  private resolveSessionWorktreeTools(): Array<typeof TOOL_WORKTREE_ENTER | typeof TOOL_WORKTREE_EXIT> {
    const state = this.store.getState();
    if (
      this.depth !== 0
      || this.definition.name !== "lead"
      || state.parentSessionId !== undefined
    ) return [];

    const toolName: typeof TOOL_WORKTREE_ENTER | typeof TOOL_WORKTREE_EXIT =
      this.cwd === this.projectRoot ? TOOL_WORKTREE_ENTER : TOOL_WORKTREE_EXIT;
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

  private async resolveStaticActiveSkillNames(
    executionSkillSnapshots?: ReadonlyMap<string, import("../skills").SkillPackageSnapshot>,
  ): Promise<readonly string[]> {
    const state = this.store.getState();
    const names = [...state.activeSkillNames, ...(executionSkillSnapshots?.keys() ?? [])];
    if (state.parentSessionId !== undefined || state.sessionId !== state.rootSessionId) {
      return [...new Set(names)];
    }
    if (this.definition.name === "discussion") {
      return [...new Set(["shape-todo", ...names])];
    }
    if (this.definition.name !== "lead") return [...new Set(names)];

    // Root Lead lifecycle Skills are selected at each model boundary below.
    // They are a runtime slot, never part of the immutable ordinary/explicit
    // Skill package loaded for this Execution.
    return [...new Set(names)].filter((name) => name !== "orchestrate-work" && name !== "run-goal");
  }

  private async resolveBoundaryActiveSkills(
    staticActiveSkills: readonly ResolvedSkill[],
  ): Promise<readonly ResolvedSkill[]> {
    const lifecycleSkillName = this.resolveRootLeadLifecycleSkillName();
    if (lifecycleSkillName === undefined) return [...staticActiveSkills];

    const lifecycleSkill = await this.skillService.readForAgent(
      this.cwd,
      lifecycleSkillName,
      this.definition.skills,
    );
    if (lifecycleSkill === null) throw new SkillNotFoundError(lifecycleSkillName);
    return [
      lifecycleSkill,
      ...staticActiveSkills.filter((skill) => skill.metadata.name !== lifecycleSkillName),
    ];
  }

  private resolveRootLeadLifecycleSkillName(): "orchestrate-work" | "run-goal" | undefined {
    const state = this.store.getState();
    if (
      this.definition.name !== "lead"
      || state.parentSessionId !== undefined
      || state.sessionId !== state.rootSessionId
    ) return undefined;
    return state.goal?.status === "active" ? "run-goal" : "orchestrate-work";
  }

}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isFile() && !info.isSymbolicLink();
  } catch (error) {
    if (typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT") return false;
    throw error;
  }
}

function latestDirectChildLinks(links: readonly ToolChildSessionLink[]): ToolChildSessionLink[] {
  const latest = new Map<string, ToolChildSessionLink>();
  for (const link of links) {
    const current = latest.get(link.childSessionId);
    if (
      current === undefined
      || link.createdAt > current.createdAt
      || (link.createdAt === current.createdAt && link.parentToolCallId.localeCompare(current.parentToolCallId) > 0)
    ) {
      latest.set(link.childSessionId, link);
    }
  }
  return [...latest.values()].sort((a, b) => a.childSessionId.localeCompare(b.childSessionId));
}

function findAgentTreeNode(root: AgentTreeNode, sessionId: string): AgentTreeNode | undefined {
  if (root.session.sessionId === sessionId) return root;
  for (const child of root.children) {
    const match = findAgentTreeNode(child, sessionId);
    if (match !== undefined) return match;
  }
  return undefined;
}

function flattenAgentTreeChildren(node: AgentTreeNode): AgentTreeNode[] {
  return node.children.flatMap((child) => [child, ...flattenAgentTreeChildren(child)]);
}

function visibleNamesFrom(
  candidates: readonly string[],
  visible: readonly { readonly registryName: string }[],
): string[] {
  const visibleNames = new Set(visible.map((entry) => entry.registryName));
  return [...new Set(candidates)].filter((name) => visibleNames.has(name));
}
