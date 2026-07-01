import { homedir } from "node:os";
import { basename, join } from "node:path";

import { GoalStateManager } from "../goals/state";
import { HitlService } from "../hitl/service";
import { MemoryFileManager } from "../memory/file-manager";
import { silentLogger } from "../logger";
import type { Logger } from "../logger";
import { ProjectApprovalManager } from "../tools/permission/project-approvals";
import type { ProjectContext, ProjectInfo } from "./types";

export interface ProjectContextResolverOptions {
  /** Factory primarily for testing alternate GoalStateManager construction. */
  goalStateFactory?: (workspaceRoot: string) => GoalStateManager;
  /** Factory primarily for testing alternate HitlService construction. */
  hitlFactory?: () => HitlService;
  /** Factory primarily for testing alternate MemoryFileManager construction. */
  memoryFactory?: (workspaceRoot: string) => MemoryFileManager;
  /** Factory primarily for testing ProjectApprovalManager load behavior. */
  approvalsFactory?: () => ProjectApprovalManager;
  logger?: Logger;
}

export class ProjectContextResolver {
  #contexts = new Map<string, Promise<ProjectContext>>();
  readonly #logger: Logger;
  readonly #goalStateFactory: (workspaceRoot: string) => GoalStateManager;
  readonly #hitlFactory: () => HitlService;
  readonly #memoryFactory: (workspaceRoot: string) => MemoryFileManager;
  readonly #approvalsFactory: () => ProjectApprovalManager;

  constructor(options: ProjectContextResolverOptions = {}) {
    this.#logger = (options.logger ?? silentLogger).child({ module: "projects.context" });
    this.#goalStateFactory = options.goalStateFactory ?? ((workspaceRoot) => {
      return new GoalStateManager(workspaceRoot, this.#logger.child({ module: "goals.state" }));
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

    return {
      project: this.#createPlaceholderProjectInfo(workspaceRoot),
      goalState: this.#goalStateFactory(workspaceRoot),
      hitl: this.#hitlFactory(),
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
