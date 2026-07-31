import {
  PROJECT_STATE_DIR_NAME,
  type CreateProjectTodoSessionInput,
  type CreateProjectTodoSessionResponse,
  type ProjectTodo,
  type ProjectTodoCreateInput,
  type ProjectTodoDiscussionUpdatePatch,
  type ProjectTodoSessionSource,
  type ProjectTodoUpdateInput,
} from "@archcode/protocol";
import { join } from "node:path";

import { ProjectTodoDiscussionAuthorizationError } from "./errors";
import {
  CreateProjectTodoSessionSchema,
  ProjectTodoDiscussionUpdatePatchSchema,
} from "./schema";
import { ProjectTodoStateManager } from "./state-manager";

export interface ProjectTodoSessionCapability {
  createRootSession(input: {
    readonly workspaceRoot: string;
    readonly agentName: "lead" | "discussion";
    readonly title: string;
    readonly projectTodo: ProjectTodoSessionSource;
  }): Promise<{ readonly sessionId: string }>;
  acceptMessage(input: {
    readonly workspaceRoot: string;
    readonly sessionId: string;
    readonly text: string;
    readonly clientRequestId: string;
  }): Promise<void>;
}

export interface ProjectTodoDiscussionAuthorization {
  readonly sessionId: string;
  readonly rootSessionId: string;
  readonly agentName: string;
  readonly projectSlug: string;
  readonly projectTodo?: ProjectTodoSessionSource;
}

export interface ProjectTodoDiscussionUpdateInput {
  readonly authorization: ProjectTodoDiscussionAuthorization;
  readonly expectedRevision: number;
  readonly patch: ProjectTodoDiscussionUpdatePatch;
}

export interface ProjectTodoServiceOptions {
  readonly workspaceRoot: string;
  readonly projectSlug: string;
  readonly sessions: ProjectTodoSessionCapability;
  readonly state?: ProjectTodoStateManager;
}

/**
 * Project Todo application boundary. Persistence remains private and Session
 * effects are expressed only through the ordinary Session capability.
 */
export class ProjectTodoService {
  readonly workspaceRoot: string;
  readonly projectSlug: string;
  readonly #state: ProjectTodoStateManager;
  readonly #sessions: ProjectTodoSessionCapability;

  constructor(options: ProjectTodoServiceOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.projectSlug = requireProjectSlug(options.projectSlug);
    this.#state = options.state ?? new ProjectTodoStateManager(options.workspaceRoot);
    this.#sessions = options.sessions;
  }

  async listTodos(): Promise<ProjectTodo[]> {
    return this.#state.listTodos();
  }

  async readTodo(todoId: string): Promise<ProjectTodo> {
    return this.#state.readTodo(todoId);
  }

  async createTodo(input: ProjectTodoCreateInput): Promise<ProjectTodo> {
    return this.#state.createTodo(input);
  }

  async updateTodo(todoId: string, input: ProjectTodoUpdateInput): Promise<ProjectTodo> {
    return this.#state.updateTodo(todoId, input);
  }

  async createSession(
    todoId: string,
    input: CreateProjectTodoSessionInput,
  ): Promise<CreateProjectTodoSessionResponse> {
    const request = CreateProjectTodoSessionSchema.parse(input);
    const todo = request.entry === "discussion"
      ? await this.#state.readCurrentTodo(todoId, request.expectedRevision)
      : await this.#state.beginWork(todoId, request.expectedRevision);
    const projectTodo: ProjectTodoSessionSource = { todoId, entry: request.entry };
    const planRelativePath = `${PROJECT_STATE_DIR_NAME}/plans/${todoId}.md`;
    const hasPlan = request.entry === "work"
      ? await Bun.file(join(this.workspaceRoot, planRelativePath)).exists()
      : false;
    const { sessionId } = await this.#sessions.createRootSession({
      workspaceRoot: this.workspaceRoot,
      agentName: request.entry === "discussion" ? "discussion" : "lead",
      title: request.entry === "discussion" ? `Discussion: ${todo.title}` : todo.title,
      projectTodo,
    });
    await this.#sessions.acceptMessage({
      workspaceRoot: this.workspaceRoot,
      sessionId,
      text: sessionMessage(
        todo,
        todo.revision,
        request.entry,
        hasPlan ? planRelativePath : undefined,
        "initialIntent" in request ? request.initialIntent : undefined,
      ),
      clientRequestId: crypto.randomUUID(),
    });
    return { todo, sessionId };
  }

  async updateFromDiscussion(input: ProjectTodoDiscussionUpdateInput): Promise<ProjectTodo> {
    const authorization = input.authorization;
    if (authorization.agentName !== "discussion") {
      throw new ProjectTodoDiscussionAuthorizationError("only Discussion may update its bound Todo");
    }
    if (authorization.sessionId !== authorization.rootSessionId) {
      throw new ProjectTodoDiscussionAuthorizationError("Discussion must be a root Session");
    }
    if (authorization.projectSlug !== this.projectSlug) {
      throw new ProjectTodoDiscussionAuthorizationError("Discussion belongs to another Project");
    }
    if (authorization.projectTodo === undefined) {
      throw new ProjectTodoDiscussionAuthorizationError("Discussion is not bound to a Project Todo");
    }
    const patch = ProjectTodoDiscussionUpdatePatchSchema.parse(input.patch);
    return this.#state.updateTodo(authorization.projectTodo.todoId, {
      expectedRevision: input.expectedRevision,
      ...patch,
    });
  }
}

function sessionMessage(
  todo: ProjectTodo,
  revision: number,
  entry: CreateProjectTodoSessionInput["entry"],
  planPath?: string,
  initialIntent?: CreateProjectTodoSessionInput["initialIntent"],
): string {
  const source = [
    `Todo ID: ${todo.id}`,
    `Revision: ${revision}`,
    `Title: ${todo.title}`,
    "Body:",
    todo.body,
  ].join("\n");
  if (entry === "discussion") {
    if (initialIntent === "plan") {
      return [
        `/skill use plan-work Create or improve the implementation Plan for this bound Todo at ${PROJECT_STATE_DIR_NAME}/plans/${todo.id}.md. Preserve one Plan file, read it before editing when it exists, and do not start implementation.`,
        source,
      ].join("\n\n");
    }
    return [
      "Discuss and shape the bound Project Todo. Do not start product code implementation.",
      `When the user asks for a Plan, you may create or improve the unique implementation Plan at ${PROJECT_STATE_DIR_NAME}/plans/${todo.id}.md.`,
      "Use project_todo_update to write confirmed corrections and decisions back to this same Todo.",
      source,
    ].join("\n\n");
  }
  if (entry === "automation") {
    return `/skill use automation-create Create an Automation from the following Project Todo.\n\n${source}`;
  }
  if (planPath !== undefined) {
    return `/skill use execute-plan Execute the Project Todo using the Plan at ${planPath}. Check the Plan, ask whether to create a Goal, then follow the user's decision.\n\n${source}`;
  }
  return `Implement the following Project Todo as an ordinary Lead Session.\n\n${source}`;
}

function requireProjectSlug(projectSlug: string): string {
  const value = projectSlug.trim();
  if (value.length === 0) throw new Error("projectSlug must not be empty");
  return value;
}
