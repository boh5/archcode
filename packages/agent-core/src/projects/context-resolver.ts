import { homedir } from "node:os";
import { basename, join } from "node:path";
import { PROJECT_STATE_DIR_NAME, USER_DATA_DIR_NAME } from "@archcode/protocol";

import { GoalStateManager } from "../goals/state";
import type { GoalCancellationCapability } from "../goals/cancellation";
import { ResumeCoordinator, type ResumeCoordinatorAdapters } from "../hitl/resume-coordinator";
import { HitlService } from "../hitl/service";
import { LoopStateManager } from "../loops/state";
import { MemoryFileManager } from "../memory/file-manager";
import { silentLogger } from "../logger";
import type { Logger } from "../logger";
import type { SessionStoreManager } from "../store/session-store-manager";
import { recoverSessionHitlJournals } from "../execution/session-hitl-journal";
import { ProjectApprovalManager } from "../tools/permission/project-approvals";
import type { ProjectContext, ProjectInfo } from "./types";

export interface ProjectContextResolverOptions {
  /** Factory primarily for runtime registry-backed ProjectInfo lookup. */
  projectInfoFactory?: (workspaceRoot: string) => Promise<ProjectInfo | undefined> | ProjectInfo | undefined;
  /** Factory primarily for testing alternate GoalStateManager construction. */
  goalStateFactory?: (workspaceRoot: string) => GoalStateManager;
  /** Application-level Goal cancellation capability supplied by runtime composition. */
  goalCancellationFactory?: (input: {
    workspaceRoot: string;
    project: ProjectInfo;
    goalState: GoalStateManager;
    hitl: HitlService;
  }) => GoalCancellationCapability;
  /** Factory primarily for testing alternate LoopStateManager construction. */
  loopStateFactory?: (workspaceRoot: string) => LoopStateManager;
  /** Factory primarily for testing alternate HitlService construction. */
  hitlFactory?: (workspaceRoot: string) => HitlService;
  /** Shared SessionStoreManager used for owner-local HITL lookup and aggregation. */
  sessionStoreManager?: SessionStoreManager;
  /** Factory primarily for testing alternate ResumeCoordinator construction. */
  resumeCoordinatorFactory?: (input: { workspaceRoot: string; hitl: HitlService; goalState: GoalStateManager; loopState: LoopStateManager; adapters?: ResumeCoordinatorAdapters }) => ResumeCoordinator;
  /** Owner-specific adapters registered by later HITL runtime tasks. */
  resumeAdapters?: ResumeCoordinatorAdapters;
  /** Factory primarily for testing alternate MemoryFileManager construction. */
  memoryFactory?: (workspaceRoot: string) => MemoryFileManager;
  /** Factory primarily for testing ProjectApprovalManager load behavior. */
  approvalsFactory?: () => ProjectApprovalManager;
  logger?: Logger;
}

export class ProjectContextResolver {
  #contexts = new Map<string, Promise<ProjectContext>>();
  readonly #logger: Logger;
  readonly #projectInfoFactory: (workspaceRoot: string) => Promise<ProjectInfo | undefined> | ProjectInfo | undefined;
  readonly #goalStateFactory: (workspaceRoot: string) => GoalStateManager;
  readonly #goalCancellationFactory?: ProjectContextResolverOptions["goalCancellationFactory"];
  readonly #loopStateFactory: (workspaceRoot: string) => LoopStateManager;
  readonly #hitlFactory: (workspaceRoot: string) => HitlService;
  readonly #sessionStoreManager?: SessionStoreManager;
  readonly #resumeCoordinatorFactory: (input: { workspaceRoot: string; hitl: HitlService; goalState: GoalStateManager; loopState: LoopStateManager; adapters?: ResumeCoordinatorAdapters }) => ResumeCoordinator;
  readonly #resumeAdapters?: ResumeCoordinatorAdapters;
  readonly #memoryFactory: (workspaceRoot: string) => MemoryFileManager;
  readonly #approvalsFactory: () => ProjectApprovalManager;

  constructor(options: ProjectContextResolverOptions = {}) {
    this.#logger = (options.logger ?? silentLogger).child({ module: "projects.context" });
    this.#projectInfoFactory = options.projectInfoFactory ?? (() => undefined);
    this.#goalStateFactory = options.goalStateFactory ?? ((workspaceRoot) => {
      return new GoalStateManager(workspaceRoot, this.#logger.child({ module: "goals.state" }));
    });
    this.#goalCancellationFactory = options.goalCancellationFactory;
    this.#loopStateFactory = options.loopStateFactory ?? ((workspaceRoot) => {
      return new LoopStateManager(workspaceRoot, this.#logger.child({ module: "loops.state" }));
    });
    this.#sessionStoreManager = options.sessionStoreManager;
    this.#resumeCoordinatorFactory = options.resumeCoordinatorFactory ?? ((input) => new ResumeCoordinator({ hitl: input.hitl, adapters: input.adapters, logger: this.#logger }));
    this.#resumeAdapters = options.resumeAdapters;
    this.#hitlFactory = options.hitlFactory ?? ((workspaceRoot) => new HitlService({ workspaceRoot }));
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
    const project = await this.#projectInfoFactory(workspaceRoot) ?? this.#createPlaceholderProjectInfo(workspaceRoot);
    const goalState = this.#goalStateFactory(workspaceRoot);
    const loopState = this.#loopStateFactory(workspaceRoot);
    const hitl = this.#hitlFactory(workspaceRoot);
    hitl.configure({
      workspaceRoot,
      project,
      sessions: this.#sessionStoreManager,
      goalState,
      loopState,
    });
    await hitl.load(workspaceRoot);
    if (this.#sessionStoreManager !== undefined) {
      await recoverSessionHitlJournals({
        workspaceRoot,
        projectSlug: project.slug,
        sessions: this.#sessionStoreManager,
        hitl,
      });
    }
    const hitlResumeCoordinator = this.#resumeCoordinatorFactory({ workspaceRoot, hitl, goalState, loopState, adapters: this.#resumeAdapters });
    const context: ProjectContext = {
      project,
      goalState,
      ...(this.#goalCancellationFactory === undefined ? {} : {
        goalCancellation: this.#goalCancellationFactory({ workspaceRoot, project, goalState, hitl }),
      }),
      loopState,
      hitl,
      hitlResumeCoordinator,
      memory: this.#memoryFactory(workspaceRoot),
      approvals,
    };
    if (this.#sessionStoreManager !== undefined && hasResumeAdapters(this.#resumeAdapters)) {
      // Journal repair and durable resume claims are fail-closed before this
      // scan. recover() single-flights and schedules claimed continuations but
      // deliberately does not await their potentially long Agent/Loop tails.
      // Any adapter resolve() re-entry naturally resumes once this build
      // promise publishes the fully constructed context.
      await hitlResumeCoordinator.recover();
    }

    return context;
  }

  #createPlaceholderProjectInfo(workspaceRoot: string): ProjectInfo {
    const name = basename(workspaceRoot);
    // Fallback for tests or runtimes that do not provide registry-backed ProjectInfo.
    return {
      slug: name,
      name,
      workspaceRoot,
      addedAt: new Date().toISOString(),
    };
  }
}

function hasResumeAdapters(adapters: ResumeCoordinatorAdapters | undefined): boolean {
  return adapters?.session !== undefined || adapters?.goal !== undefined || adapters?.loop !== undefined;
}
