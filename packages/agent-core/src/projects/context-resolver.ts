import { homedir } from "node:os";
import { join } from "node:path";
import { PROJECT_STATE_DIR_NAME, USER_DATA_DIR_NAME } from "@archcode/protocol";

import { HitlBoundaryCodec, ProjectHitlQueue, type ProjectHitlQueueOptions } from "../hitl";
import { MemoryFileManager } from "../memory/file-manager";
import { silentLogger } from "../logger";
import type { Logger } from "../logger";
import { ProjectApprovalManager } from "../tools/permission/project-approvals";
import type { ProjectContext, ProjectInfo } from "./types";
import type { Automation, AutomationAction, AutomationTrigger } from "@archcode/protocol";
import type { ProjectTodoService } from "../todos";

export interface ProjectContextResolverOptions {
  /** Runtime-wide strict HITL boundary shared with ToolRegistry. */
  hitlCodec: HitlBoundaryCodec;
  /** Registry-backed ProjectInfo lookup. Missing projects must fail resolution. */
  projectInfoFactory: (workspaceRoot: string) => Promise<ProjectInfo> | ProjectInfo;
  /** Project-owned Todo service composed with narrow runtime capabilities. */
  projectTodoFactory: (input: {
    workspaceRoot: string;
    project: ProjectInfo;
  }) => ProjectTodoService;
  /** Runtime-owned Automation creation path used by the model-facing tool. */
  createAutomation: (workspaceRoot: string, input: {
    readonly name: string;
    readonly trigger: AutomationTrigger;
    readonly action: AutomationAction;
    readonly createdFromSessionId: string;
  }) => Promise<Automation>;
  /** Factory primarily for testing alternate ProjectHitlQueue construction. */
  hitlFactory?: (options: ProjectHitlQueueOptions) => ProjectHitlQueue;
  /** Factory primarily for testing alternate MemoryFileManager construction. */
  memoryFactory?: (workspaceRoot: string) => MemoryFileManager;
  /** Factory primarily for testing ProjectApprovalManager load behavior. */
  approvalsFactory?: () => ProjectApprovalManager;
  logger?: Logger;
}

export class ProjectContextResolver {
  #contexts = new Map<string, Promise<ProjectContext>>();
  readonly #logger: Logger;
  readonly #hitlCodec: HitlBoundaryCodec;
  readonly #projectInfoFactory: (workspaceRoot: string) => Promise<ProjectInfo> | ProjectInfo;
  readonly #projectTodoFactory: ProjectContextResolverOptions["projectTodoFactory"];
  readonly #createAutomation: ProjectContextResolverOptions["createAutomation"];
  readonly #hitlFactory: (options: ProjectHitlQueueOptions) => ProjectHitlQueue;
  readonly #memoryFactory: (workspaceRoot: string) => MemoryFileManager;
  readonly #approvalsFactory: () => ProjectApprovalManager;

  constructor(options: ProjectContextResolverOptions) {
    this.#logger = (options.logger ?? silentLogger).child({ module: "projects.context" });
    this.#hitlCodec = options.hitlCodec;
    this.#projectInfoFactory = options.projectInfoFactory;
    this.#projectTodoFactory = options.projectTodoFactory;
    this.#createAutomation = options.createAutomation;
    this.#hitlFactory = options.hitlFactory ?? ((input) => new ProjectHitlQueue(input));
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
      await pending;
    } catch (error) {
      this.#logger.warn("projects.context.dispose_failed", { error, meta: { workspaceRoot } });
    }
  }

  async #buildContext(workspaceRoot: string): Promise<ProjectContext> {
    const approvals = this.#approvalsFactory();
    await approvals.load(workspaceRoot);
    const project = await this.#projectInfoFactory(workspaceRoot);
    const hitl = this.#hitlFactory({ workspaceRoot, codec: this.#hitlCodec });
    const todos = this.#projectTodoFactory({ workspaceRoot, project });
    const context: ProjectContext = {
      project,
      createAutomation: (input) => this.#createAutomation(workspaceRoot, input),
      todos,
      hitl,
      memory: this.#memoryFactory(workspaceRoot),
      approvals,
    };
    return context;
  }
}
