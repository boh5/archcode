import { homedir } from "node:os";
import { basename, join } from "node:path";

import { WorkflowArtifactManager } from "../agents/workflow/artifacts";
import { WorkflowStateManager } from "../agents/workflow/state";
import { MemoryFileManager } from "../memory/file-manager";
import { silentLogger } from "../logger";
import { ProjectApprovalManager } from "../tools/permission/project-approvals";
import type { ProjectContext, ProjectInfo } from "./types";

export interface ProjectContextResolverOptions {
  /** Factory primarily for testing alternate WorkflowStateManager construction. */
  workflowStateFactory?: (workspaceRoot: string) => WorkflowStateManager;
  /** Factory primarily for testing alternate MemoryFileManager construction. */
  memoryFactory?: (workspaceRoot: string) => MemoryFileManager;
  /** Factory primarily for testing ProjectApprovalManager load behavior. */
  approvalsFactory?: () => ProjectApprovalManager;
  /** Factory primarily for testing artifact manager construction. */
  artifactsFactory?: (workspaceRoot: string, workflowState: WorkflowStateManager) => WorkflowArtifactManager;
}

export class ProjectContextResolver {
  #contexts = new Map<string, Promise<ProjectContext>>();
  readonly #workflowStateFactory: (workspaceRoot: string) => WorkflowStateManager;
  readonly #memoryFactory: (workspaceRoot: string) => MemoryFileManager;
  readonly #approvalsFactory: () => ProjectApprovalManager;
  readonly #artifactsFactory: (workspaceRoot: string, workflowState: WorkflowStateManager) => WorkflowArtifactManager;

  constructor(options: ProjectContextResolverOptions = {}) {
    this.#workflowStateFactory = options.workflowStateFactory ?? ((workspaceRoot) => {
      return new WorkflowStateManager(workspaceRoot);
    });
    this.#memoryFactory = options.memoryFactory ?? ((workspaceRoot) => {
      return new MemoryFileManager({
        project: join(workspaceRoot, ".specra", "memory"),
        user: join(homedir(), ".specra", "memory"),
      });
    });
    this.#approvalsFactory = options.approvalsFactory ?? (() => new ProjectApprovalManager(silentLogger));
    this.#artifactsFactory = options.artifactsFactory ?? ((workspaceRoot, workflowState) => {
      return new WorkflowArtifactManager(workspaceRoot, workflowState);
    });
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
    const workflowState = this.#workflowStateFactory(workspaceRoot);

    return {
      project: this.#createPlaceholderProjectInfo(workspaceRoot),
      workflowState,
      memory: this.#memoryFactory(workspaceRoot),
      approvals,
      artifacts: this.#artifactsFactory(workspaceRoot, workflowState),
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
