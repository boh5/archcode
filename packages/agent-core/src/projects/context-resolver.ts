import { homedir } from "node:os";
import { basename, join } from "node:path";

import { GoalArtifactManager } from "../goals/artifacts";
import { GoalMemoryManager } from "../goals/goal-memory";
import { GoalStateManager } from "../goals/state";
import { HitlService } from "../hitl/service";
import { LoopStateManager } from "../loops/state";
import { MemoryFileManager } from "../memory/file-manager";
import { silentLogger } from "../logger";
import type { Logger } from "../logger";
import { ProjectApprovalManager } from "../tools/permission/project-approvals";
import type { ProjectContext, ProjectInfo } from "./types";

export interface ProjectContextResolverOptions {
  /** Factory primarily for runtime registry-backed ProjectInfo lookup. */
  projectInfoFactory?: (workspaceRoot: string) => Promise<ProjectInfo | undefined> | ProjectInfo | undefined;
  /** Factory primarily for testing alternate GoalStateManager construction. */
  goalStateFactory?: (workspaceRoot: string) => GoalStateManager;
  /** Factory primarily for testing alternate GoalArtifactManager construction. */
  goalArtifactsFactory?: (workspaceRoot: string) => GoalArtifactManager;
  /** Factory primarily for testing alternate GoalMemoryManager construction. */
  goalMemoryFactory?: (workspaceRoot: string) => GoalMemoryManager;
  /** Factory primarily for testing alternate LoopStateManager construction. */
  loopStateFactory?: (workspaceRoot: string) => LoopStateManager;
  /** Factory primarily for testing alternate HitlService construction. */
  hitlFactory?: (workspaceRoot: string) => HitlService;
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
  readonly #goalArtifactsFactory: (workspaceRoot: string) => GoalArtifactManager;
  readonly #goalMemoryFactory: (workspaceRoot: string) => GoalMemoryManager;
  readonly #loopStateFactory: (workspaceRoot: string) => LoopStateManager;
  readonly #hitlFactory: (workspaceRoot: string) => HitlService;
  readonly #memoryFactory: (workspaceRoot: string) => MemoryFileManager;
  readonly #approvalsFactory: () => ProjectApprovalManager;

  constructor(options: ProjectContextResolverOptions = {}) {
    this.#logger = (options.logger ?? silentLogger).child({ module: "projects.context" });
    this.#projectInfoFactory = options.projectInfoFactory ?? (() => undefined);
    this.#goalStateFactory = options.goalStateFactory ?? ((workspaceRoot) => {
      return new GoalStateManager(workspaceRoot, this.#logger.child({ module: "goals.state" }));
    });
    this.#goalArtifactsFactory = options.goalArtifactsFactory ?? ((workspaceRoot) => {
      return new GoalArtifactManager(workspaceRoot);
    });
    this.#goalMemoryFactory = options.goalMemoryFactory ?? ((workspaceRoot) => {
      return new GoalMemoryManager(workspaceRoot);
    });
    this.#loopStateFactory = options.loopStateFactory ?? ((workspaceRoot) => {
      return new LoopStateManager(workspaceRoot, this.#logger.child({ module: "loops.state" }));
    });
    this.#hitlFactory = options.hitlFactory ?? (() => new HitlService());
    this.#memoryFactory = options.memoryFactory ?? ((workspaceRoot) => {
      return new MemoryFileManager({
        project: join(workspaceRoot, ".archcode", "memory"),
        user: join(homedir(), ".archcode", "memory"),
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

  dispose(workspaceRoot: string): void {
    this.#contexts.delete(workspaceRoot);
  }

  async #buildContext(workspaceRoot: string): Promise<ProjectContext> {
    const approvals = this.#approvalsFactory();
    await approvals.load(workspaceRoot);
    const hitl = this.#hitlFactory(workspaceRoot);
    await hitl.load(workspaceRoot);
    const project = await this.#projectInfoFactory(workspaceRoot) ?? this.#createPlaceholderProjectInfo(workspaceRoot);

    return {
      project,
      goalState: this.#goalStateFactory(workspaceRoot),
      goalArtifacts: this.#goalArtifactsFactory(workspaceRoot),
      goalMemory: this.#goalMemoryFactory(workspaceRoot),
      loopState: this.#loopStateFactory(workspaceRoot),
      hitl,
      memory: this.#memoryFactory(workspaceRoot),
      approvals,
    };
  }

  #createPlaceholderProjectInfo(workspaceRoot: string): ProjectInfo {
    const name = basename(workspaceRoot);
    // TODO(W1.M7): replace placeholder ProjectInfo with registry lookup
    return {
      slug: name,
      name,
      workspaceRoot,
      addedAt: new Date().toISOString(),
    };
  }
}
