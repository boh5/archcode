import {
  PROJECT_STATE_DIR_NAME,
  projectTodoDisplayLabel,
  type CreateProjectTodoSessionInput,
  type CreateProjectTodoSessionResponse,
  type ProjectTodo,
  type ProjectTodoCreateInput,
  type ProjectTodoDiscussionUpdatePatch,
  type ProjectTodoRunNowInput,
  type ProjectTodoRunNowResponse,
  type RootSessionSummary,
  type RootSessionSource,
  type ProjectTodoUpdateInput,
} from "@archcode/protocol";
import { join } from "node:path";

import {
  ProjectTodoDiscussionAuthorizationError,
  ProjectTodoRunNowConflictError,
  ProjectTodoRunNowRecoveryError,
} from "./errors";
import {
  CreateProjectTodoSessionSchema,
  ProjectTodoDiscussionUpdatePatchSchema,
  ProjectTodoRunNowSchema,
} from "./schema";
import { ProjectTodoStateManager } from "./state-manager";

export interface ProjectTodoSessionCapability {
  createRootSession(input: {
    readonly workspaceRoot: string;
    readonly agentName: "lead" | "discussion";
    readonly title: string;
    readonly source: RootSessionSource;
  }): Promise<{ readonly sessionId: string }>;
  acceptMessage(input: {
    readonly workspaceRoot: string;
    readonly sessionId: string;
    readonly text: string;
    readonly clientRequestId: string;
  }): Promise<void>;
  readRootSession(input: {
    readonly workspaceRoot: string;
    readonly sessionId: string;
  }): Promise<RootSessionSummary>;
  hasDurableMessage(input: {
    readonly workspaceRoot: string;
    readonly sessionId: string;
    readonly clientRequestId: string;
  }): Promise<boolean>;
  deleteSession(input: {
    readonly workspaceRoot: string;
    readonly sessionId: string;
  }): Promise<void>;
}

export interface ProjectTodoDiscussionAuthorization {
  readonly sessionId: string;
  readonly rootSessionId: string;
  readonly agentName: string;
  readonly projectSlug: string;
  readonly source?: RootSessionSource;
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
  readonly #runNowInFlight = new Map<string, {
    readonly requestHash: string;
    readonly promise: Promise<ProjectTodoRunNowResponse>;
  }>();

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
    const source: RootSessionSource = { kind: "todo", todoId, entry: request.entry };
    const planRelativePath = `${PROJECT_STATE_DIR_NAME}/plans/${todoId}.md`;
    const hasPlan = request.entry === "work"
      ? await Bun.file(join(this.workspaceRoot, planRelativePath)).exists()
      : false;
    const { sessionId } = await this.#sessions.createRootSession({
      workspaceRoot: this.workspaceRoot,
      agentName: request.entry === "discussion" ? "discussion" : "lead",
      title: request.entry === "discussion"
        ? `Discussion: ${projectTodoDisplayLabel(todo.content, todo.id)}`
        : projectTodoDisplayLabel(todo.content, todo.id),
      source,
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

  async runNow(input: ProjectTodoRunNowInput): Promise<ProjectTodoRunNowResponse> {
    const request = ProjectTodoRunNowSchema.parse(input);
    const requestHash = hashRunNowRequest(request.content);
    const inFlight = this.#runNowInFlight.get(request.clientRequestId);
    if (inFlight !== undefined) {
      if (inFlight.requestHash !== requestHash) {
        throw new ProjectTodoRunNowConflictError(request.clientRequestId);
      }
      return await inFlight.promise;
    }

    const promise = this.#runNow(request, requestHash);
    this.#runNowInFlight.set(request.clientRequestId, { requestHash, promise });
    try {
      return await promise;
    } finally {
      if (this.#runNowInFlight.get(request.clientRequestId)?.promise === promise) {
        this.#runNowInFlight.delete(request.clientRequestId);
      }
    }
  }

  async #runNow(
    request: ProjectTodoRunNowInput,
    requestHash: string,
  ): Promise<ProjectTodoRunNowResponse> {
    const receipt = await this.#state.readRunNowReceipt(request.clientRequestId);
    if (receipt !== undefined) {
      if (receipt.requestHash !== requestHash) {
        throw new ProjectTodoRunNowConflictError(request.clientRequestId);
      }
      return {
        todo: await this.#state.readTodo(receipt.todoId),
        session: await this.#sessions.readRootSession({
          workspaceRoot: this.workspaceRoot,
          sessionId: receipt.sessionId,
        }),
      };
    }

    const todo = await this.#state.createRunNowTodo({ content: request.content });
    let sessionId: string | undefined;
    try {
      ({ sessionId } = await this.#sessions.createRootSession({
        workspaceRoot: this.workspaceRoot,
        agentName: "lead",
        title: projectTodoDisplayLabel(todo.content, todo.id),
        source: { kind: "todo", todoId: todo.id, entry: "work" },
      }));
      try {
        await this.#sessions.acceptMessage({
          workspaceRoot: this.workspaceRoot,
          sessionId,
          text: `Implement the following Project Todo as an ordinary Lead Session.\n\n${todoSource(todo)}`,
          clientRequestId: request.clientRequestId,
        });
      } catch (error) {
        let durable: boolean;
        try {
          durable = await this.#sessions.hasDurableMessage({
            workspaceRoot: this.workspaceRoot,
            sessionId,
            clientRequestId: request.clientRequestId,
          });
        } catch (receiptError) {
          throw new ProjectTodoRunNowRecoveryError(
            todo.id,
            sessionId,
            "Run now failed after Session creation, and durable message acceptance could not be determined",
            { cause: new AggregateError([error, receiptError]) },
          );
        }
        if (!durable) {
          await this.#compensateRunNow(todo.id, sessionId, error);
          throw error;
        }
      }

      try {
        await this.#state.commitRunNowReceipt({
          clientRequestId: request.clientRequestId,
          requestHash,
          todoId: todo.id,
          sessionId,
        });
      } catch (error) {
        throw new ProjectTodoRunNowRecoveryError(
          todo.id,
          sessionId,
          "Run now was accepted, but its idempotency receipt could not be committed",
          { cause: error },
        );
      }

      return {
        todo,
        session: await this.#sessions.readRootSession({
          workspaceRoot: this.workspaceRoot,
          sessionId,
        }),
      };
    } catch (error) {
      if (error instanceof ProjectTodoRunNowRecoveryError) throw error;
      if (sessionId === undefined) await this.#compensateRunNow(todo.id, undefined, error);
      throw error;
    }
  }

  async #compensateRunNow(todoId: string, sessionId: string | undefined, cause: unknown): Promise<void> {
    try {
      if (sessionId !== undefined) {
        await this.#sessions.deleteSession({ workspaceRoot: this.workspaceRoot, sessionId });
      }
      await this.#state.deleteRunNowTodo(todoId);
    } catch (error) {
      throw new ProjectTodoRunNowRecoveryError(
        todoId,
        sessionId,
        "Run now failed and its partial entities could not be fully removed",
        { cause: new AggregateError([cause, error]) },
      );
    }
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
    if (authorization.source?.kind !== "todo" || authorization.source.entry !== "discussion") {
      throw new ProjectTodoDiscussionAuthorizationError("Discussion is not bound to a Project Todo");
    }
    const patch = ProjectTodoDiscussionUpdatePatchSchema.parse(input.patch);
    return this.#state.updateTodo(authorization.source.todoId, {
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
  initialIntent?: "plan",
): string {
  const source = todoSource(todo, revision);
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

function todoSource(todo: ProjectTodo, revision: number = todo.revision): string {
  return [
    `Todo ID: ${todo.id}`,
    `Revision: ${revision}`,
    "Content:",
    todo.content,
  ].join("\n");
}

function hashRunNowRequest(content: string): string {
  return new Bun.CryptoHasher("sha256")
    .update(JSON.stringify({ content }))
    .digest("hex");
}

function requireProjectSlug(projectSlug: string): string {
  const value = projectSlug.trim();
  if (value.length === 0) throw new Error("projectSlug must not be empty");
  return value;
}
