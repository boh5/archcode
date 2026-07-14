import { homedir } from "node:os";
import { join } from "node:path";
import { PROJECT_STATE_DIR_NAME, USER_DATA_DIR_NAME } from "@archcode/protocol";

import { GoalStateManager } from "../goals/state";
import type { GoalCancellationCapability } from "../goals/cancellation";
import { type ResumeCoordinator } from "../hitl/resume-coordinator";
import { HitlService, type HitlServiceOptions } from "../hitl/service";
import { MemoryFileManager } from "../memory/file-manager";
import { silentLogger } from "../logger";
import type { Logger } from "../logger";
import type { SessionStoreManager } from "../store/session-store-manager";
import { recoverSessionHitlJournals } from "../execution/session-hitl-journal";
import { ProjectApprovalManager } from "../tools/permission/project-approvals";
import type { ProjectContext, ProjectInfo } from "./types";
import type { Automation, AutomationAction, AutomationTrigger } from "@archcode/protocol";
import type { GoalLifecycleService } from "../goals/lifecycle-service";

export interface ProjectContextResolverOptions {
  /** Registry-backed ProjectInfo lookup. Missing projects must fail resolution. */
  projectInfoFactory: (workspaceRoot: string) => Promise<ProjectInfo> | ProjectInfo;
  /** Factory primarily for testing alternate GoalStateManager construction. */
  goalStateFactory?: (
    workspaceRoot: string,
    onCommitted: (goal: import("@archcode/protocol").GoalState) => void | Promise<void>,
  ) => GoalStateManager;
  /** Narrow post-commit observer; Goal persistence remains domain-owned. */
  goalCommitted?: (input: {
    readonly workspaceRoot: string;
    readonly project: ProjectInfo;
    readonly goal: import("@archcode/protocol").GoalState;
  }) => void | Promise<void>;
  /** Application-level Goal cancellation capability supplied by runtime composition. */
  goalCancellationFactory: (input: {
    workspaceRoot: string;
    project: ProjectInfo;
    goalState: GoalStateManager;
    hitl: HitlService;
  }) => GoalCancellationCapability;
  /** Application-level Goal orchestration supplied by runtime composition. */
  goalLifecycleFactory: (input: {
    workspaceRoot: string;
    project: ProjectInfo;
    goalState: GoalStateManager;
  }) => GoalLifecycleService;
  /** Runtime-owned Automation creation path used by the model-facing tool. */
  createAutomation: (workspaceRoot: string, input: {
    readonly name: string;
    readonly trigger: AutomationTrigger;
    readonly action: AutomationAction;
    readonly createdFromSessionId: string;
  }) => Promise<Automation>;
  /** Factory primarily for testing alternate HitlService construction. */
  hitlFactory?: (options: HitlServiceOptions) => HitlService;
  /** Shared SessionStoreManager used for owner-local HITL lookup and aggregation. */
  sessionStoreManager: SessionStoreManager;
  /** Application-level ResumeCoordinator composition with all production adapters. */
  resumeCoordinatorFactory: (input: { workspaceRoot: string; hitl: HitlService; goalState: GoalStateManager }) => ResumeCoordinator;
  /** Factory primarily for testing alternate MemoryFileManager construction. */
  memoryFactory?: (workspaceRoot: string) => MemoryFileManager;
  /** Factory primarily for testing ProjectApprovalManager load behavior. */
  approvalsFactory?: () => ProjectApprovalManager;
  logger?: Logger;
}

export class ProjectContextResolver {
  #contexts = new Map<string, Promise<ProjectContext>>();
  readonly #logger: Logger;
  readonly #projectInfoFactory: (workspaceRoot: string) => Promise<ProjectInfo> | ProjectInfo;
  readonly #goalStateFactory: NonNullable<ProjectContextResolverOptions["goalStateFactory"]>;
  readonly #goalCommitted: NonNullable<ProjectContextResolverOptions["goalCommitted"]>;
  readonly #goalCancellationFactory: ProjectContextResolverOptions["goalCancellationFactory"];
  readonly #goalLifecycleFactory: ProjectContextResolverOptions["goalLifecycleFactory"];
  readonly #createAutomation: ProjectContextResolverOptions["createAutomation"];
  readonly #hitlFactory: (options: HitlServiceOptions) => HitlService;
  readonly #sessionStoreManager: SessionStoreManager;
  readonly #resumeCoordinatorFactory: ProjectContextResolverOptions["resumeCoordinatorFactory"];
  readonly #memoryFactory: (workspaceRoot: string) => MemoryFileManager;
  readonly #approvalsFactory: () => ProjectApprovalManager;

  constructor(options: ProjectContextResolverOptions) {
    this.#logger = (options.logger ?? silentLogger).child({ module: "projects.context" });
    this.#projectInfoFactory = options.projectInfoFactory;
    this.#goalStateFactory = options.goalStateFactory ?? ((workspaceRoot, onCommitted) => {
      return new GoalStateManager(workspaceRoot, this.#logger.child({ module: "goals.state" }), onCommitted);
    });
    this.#goalCommitted = options.goalCommitted ?? (() => {});
    this.#goalCancellationFactory = options.goalCancellationFactory;
    this.#goalLifecycleFactory = options.goalLifecycleFactory;
    this.#createAutomation = options.createAutomation;
    this.#sessionStoreManager = options.sessionStoreManager;
    this.#resumeCoordinatorFactory = options.resumeCoordinatorFactory;
    this.#hitlFactory = options.hitlFactory ?? ((input) => new HitlService(input));
    this.#memoryFactory = options.memoryFactory ?? ((workspaceRoot) => {
      return new MemoryFileManager({
        project: join(workspaceRoot, PROJECT_STATE_DIR_NAME, "memory"),
        user: join(homedir(), USER_DATA_DIR_NAME, "memory"),
      });
    });
    this.#approvalsFactory = options.approvalsFactory ?? (() => new ProjectApprovalManager(this.#logger.child({ module: "project.approvals" })));
  }

  async resolve(workspaceRoot: string): Promise<ProjectContext> {
    let pending = this.#contexts.get(workspaceRoot);
    if (!pending) {
      pending = this.#buildContext(workspaceRoot).catch((error: unknown) => {
        this.#contexts.delete(workspaceRoot);
        throw error;
      });
      this.#contexts.set(workspaceRoot, pending);
    }
    return await pending;
  }

  alias(workspaceRoot: string, context: ProjectContext): void {
    this.#contexts.set(workspaceRoot, Promise.resolve(context));
  }

  async dispose(workspaceRoot: string): Promise<void> {
    const pending = this.#contexts.get(workspaceRoot);
    this.#contexts.delete(workspaceRoot);
    if (pending === undefined) return;
    try {
      const context = await pending;
      context.hitlResumeCoordinator.dispose();
      context.hitl.shutdown();
    } catch (error) {
      this.#logger.warn("projects.context.dispose_failed", { error, meta: { workspaceRoot } });
    }
  }

  async #buildContext(workspaceRoot: string): Promise<ProjectContext> {
    const approvals = this.#approvalsFactory();
    await approvals.load(workspaceRoot);
    const project = await this.#projectInfoFactory(workspaceRoot);
    const goalState = this.#goalStateFactory(
      workspaceRoot,
      (goal) => this.#goalCommitted({ workspaceRoot, project, goal }),
    );
    const hitl = this.#hitlFactory({
      workspaceRoot,
      project,
      sessions: this.#sessionStoreManager,
      goalState,
    });
    await recoverSessionHitlJournals({
      workspaceRoot,
      sessions: this.#sessionStoreManager,
      hitl,
    });
    const hitlResumeCoordinator = this.#resumeCoordinatorFactory({ workspaceRoot, hitl, goalState });
    const context: ProjectContext = {
      project,
      goalState,
      goalLifecycle: this.#goalLifecycleFactory({ workspaceRoot, project, goalState }),
      createAutomation: (input) => this.#createAutomation(workspaceRoot, input),
      goalCancellation: this.#goalCancellationFactory({ workspaceRoot, project, goalState, hitl }),
      hitl,
      hitlResumeCoordinator,
      memory: this.#memoryFactory(workspaceRoot),
      approvals,
    };
    // Journal repair and durable resume claims are fail-closed before this
    // scan. recover() schedules claimed continuations without awaiting their
    // potentially long Agent tails, so adapter re-entry can resolve this
    // same context once this build promise publishes it.
    await hitlResumeCoordinator.recover();

    return context;
  }
}
