import { homedir } from "node:os";
import { join } from "node:path";
import { PROJECT_STATE_DIR_NAME, USER_DATA_DIR_NAME } from "@archcode/protocol";

import { GoalStateManager } from "../goals/state";
import type { GoalCancellationCapability } from "../goals/cancellation";
import { type ResumeCoordinator } from "../hitl/resume-coordinator";
import { HitlService, type HitlServiceOptions } from "../hitl/service";
import { LoopStateManager } from "../loops/state";
import { MemoryFileManager } from "../memory/file-manager";
import { silentLogger } from "../logger";
import type { Logger } from "../logger";
import type { SessionStoreManager } from "../store/session-store-manager";
import { recoverSessionHitlJournals } from "../execution/session-hitl-journal";
import { ProjectApprovalManager } from "../tools/permission/project-approvals";
import type { ProjectContext, ProjectInfo } from "./types";

export interface ProjectContextResolverOptions {
  /** Registry-backed ProjectInfo lookup. Missing projects must fail resolution. */
  projectInfoFactory: (workspaceRoot: string) => Promise<ProjectInfo> | ProjectInfo;
  /** Factory primarily for testing alternate GoalStateManager construction. */
  goalStateFactory?: (workspaceRoot: string) => GoalStateManager;
  /** Application-level Goal cancellation capability supplied by runtime composition. */
  goalCancellationFactory: (input: {
    workspaceRoot: string;
    project: ProjectInfo;
    goalState: GoalStateManager;
    hitl: HitlService;
  }) => GoalCancellationCapability;
  /** Factory primarily for testing alternate LoopStateManager construction. */
  loopStateFactory?: (workspaceRoot: string) => LoopStateManager;
  /** Factory primarily for testing alternate HitlService construction. */
  hitlFactory?: (options: HitlServiceOptions) => HitlService;
  /** Shared SessionStoreManager used for owner-local HITL lookup and aggregation. */
  sessionStoreManager: SessionStoreManager;
  /** Application-level ResumeCoordinator composition with all production adapters. */
  resumeCoordinatorFactory: (input: { workspaceRoot: string; hitl: HitlService; goalState: GoalStateManager; loopState: LoopStateManager }) => ResumeCoordinator;
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
  readonly #goalStateFactory: (workspaceRoot: string) => GoalStateManager;
  readonly #goalCancellationFactory: ProjectContextResolverOptions["goalCancellationFactory"];
  readonly #loopStateFactory: (workspaceRoot: string) => LoopStateManager;
  readonly #hitlFactory: (options: HitlServiceOptions) => HitlService;
  readonly #sessionStoreManager: SessionStoreManager;
  readonly #resumeCoordinatorFactory: ProjectContextResolverOptions["resumeCoordinatorFactory"];
  readonly #memoryFactory: (workspaceRoot: string) => MemoryFileManager;
  readonly #approvalsFactory: () => ProjectApprovalManager;

  constructor(options: ProjectContextResolverOptions) {
    this.#logger = (options.logger ?? silentLogger).child({ module: "projects.context" });
    this.#projectInfoFactory = options.projectInfoFactory;
    this.#goalStateFactory = options.goalStateFactory ?? ((workspaceRoot) => {
      return new GoalStateManager(workspaceRoot, this.#logger.child({ module: "goals.state" }));
    });
    this.#goalCancellationFactory = options.goalCancellationFactory;
    this.#loopStateFactory = options.loopStateFactory ?? ((workspaceRoot) => {
      return new LoopStateManager(workspaceRoot, this.#logger.child({ module: "loops.state" }));
    });
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

  dispose(workspaceRoot: string): void {
    this.#contexts.delete(workspaceRoot);
  }

  async #buildContext(workspaceRoot: string): Promise<ProjectContext> {
    const approvals = this.#approvalsFactory();
    await approvals.load(workspaceRoot);
    const project = await this.#projectInfoFactory(workspaceRoot);
    const goalState = this.#goalStateFactory(workspaceRoot);
    const loopState = this.#loopStateFactory(workspaceRoot);
    const hitl = this.#hitlFactory({
      workspaceRoot,
      project,
      sessions: this.#sessionStoreManager,
      goalState,
      loopState,
    });
    await recoverSessionHitlJournals({
      workspaceRoot,
      sessions: this.#sessionStoreManager,
      hitl,
    });
    const hitlResumeCoordinator = this.#resumeCoordinatorFactory({ workspaceRoot, hitl, goalState, loopState });
    const context: ProjectContext = {
      project,
      goalState,
      goalCancellation: this.#goalCancellationFactory({ workspaceRoot, project, goalState, hitl }),
      loopState,
      hitl,
      hitlResumeCoordinator,
      memory: this.#memoryFactory(workspaceRoot),
      approvals,
    };
    // Journal repair and durable resume claims are fail-closed before this
    // scan. recover() schedules claimed continuations without awaiting their
    // potentially long Agent/Loop tails, so adapter re-entry can resolve this
    // same context once this build promise publishes it.
    await hitlResumeCoordinator.recover();

    return context;
  }
}
