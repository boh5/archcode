import type {
  ProjectTodo,
  ProjectTodoActivateInput,
  ProjectTodoActivationKind,
  ProjectTodoCreateInput,
  ProjectTodoDiscussionUpdatePatch,
  ProjectTodoSessionOwner,
  ProjectTodoUpdateInput,
} from "@archcode/protocol";

import {
  ProjectTodoActivationConflictError,
  ProjectTodoDiscussionAuthorizationError,
  ProjectTodoReturnToReadyConflictError,
  ProjectTodoRevisionConflictError,
} from "./errors";
import { ProjectTodoDiscussionUpdatePatchSchema } from "./schema";
import { ProjectTodoStateManager } from "./state-manager";

export interface ProjectTodoSessionCapability {
  ensureRootSession(input: {
    readonly workspaceRoot: string;
    readonly sessionId: string;
    readonly agentName: "lead";
    readonly title: string;
  }): Promise<void>;
  /** Must be idempotent for the Session-scoped executionId. */
  ensureExecution(input: {
    readonly workspaceRoot: string;
    readonly sessionId: string;
    readonly executionId: string;
    readonly userMessage: string;
  }): Promise<void>;
  /** Atomically requires an idle family and blocks new starts until release. */
  acquireIdleFamily(input: {
    readonly workspaceRoot: string;
    readonly rootSessionId: string;
  }): Promise<{ release(): void } | undefined>;
}

export type ProjectTodoAutomationResourceStatus = "active" | "paused" | "disabled";

export interface ProjectTodoResourceSnapshot {
  readonly kind: "automation";
  readonly id: string;
  readonly createdFromSessionId: string;
  readonly createdAt: string | number;
  readonly status: ProjectTodoAutomationResourceStatus;
}

export interface ProjectTodoProvenanceCapability {
  listResources(input: {
    readonly kind: "automation";
    readonly sourceSessionId: string;
  }): Promise<readonly ProjectTodoResourceSnapshot[]>;
}

export interface ProjectTodoDiscussionAuthorization {
  readonly sessionId: string;
  readonly rootSessionId: string;
  readonly agentName: string;
  readonly projectSlug: string;
}

export interface ProjectTodoDiscussionUpdateInput {
  readonly authorization: ProjectTodoDiscussionAuthorization;
  readonly expectedRevision: number;
  readonly patch: ProjectTodoDiscussionUpdatePatch;
}

export interface ProjectTodoResourceCreatedInput {
  readonly kind: "automation";
  readonly sourceSessionId: string;
  readonly resourceId: string;
}

export interface ProjectTodoServiceOptions {
  readonly workspaceRoot: string;
  readonly projectSlug: string;
  readonly sessions: ProjectTodoSessionCapability;
  readonly provenance: ProjectTodoProvenanceCapability;
  readonly state?: ProjectTodoStateManager;
}

export class ProjectTodoService {
  readonly workspaceRoot: string;
  readonly projectSlug: string;
  readonly state: ProjectTodoStateManager;
  readonly #sessions: ProjectTodoSessionCapability;
  readonly #provenance: ProjectTodoProvenanceCapability;
  readonly #sessionRecovery = new Map<string, Promise<void>>();

  constructor(options: ProjectTodoServiceOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.projectSlug = requireProjectSlug(options.projectSlug);
    this.state = options.state ?? new ProjectTodoStateManager(options.workspaceRoot);
    this.#sessions = options.sessions;
    this.#provenance = options.provenance;
  }

  async listTodos(): Promise<ProjectTodo[]> {
    return this.state.listTodos();
  }

  async readTodo(todoId: string): Promise<ProjectTodo> {
    return this.state.readTodo(todoId);
  }

  async createTodo(input: ProjectTodoCreateInput): Promise<ProjectTodo> {
    return this.state.createTodo(input);
  }

  async updateTodo(todoId: string, input: ProjectTodoUpdateInput): Promise<ProjectTodo> {
    await this.readTodo(todoId);
    return this.state.updateTodo(todoId, input);
  }

  async archiveTodo(todoId: string, expectedRevision: number): Promise<ProjectTodo> {
    await this.readTodo(todoId);
    return this.state.archiveTodo(todoId, expectedRevision);
  }

  async restoreTodo(todoId: string, expectedRevision: number): Promise<ProjectTodo> {
    await this.readTodo(todoId);
    return this.state.restoreTodo(todoId, expectedRevision);
  }

  async discussTodo(todoId: string, expectedRevision: number): Promise<ProjectTodo> {
    await this.readTodo(todoId);
    const checkpoint = await this.state.checkpointDiscussion(todoId, expectedRevision, crypto.randomUUID());
    await this.#ensureDiscussion(checkpoint);
    return this.readTodo(todoId);
  }

  async activateTodo(todoId: string, input: ProjectTodoActivateInput): Promise<ProjectTodo> {
    await this.readTodo(todoId);
    const checkpoint = await this.state.checkpointActivation(todoId, input.expectedRevision, input.kind, crypto.randomUUID());
    await this.#ensureActivation(checkpoint);
    return this.#reconcileActivationResource(await this.readTodo(todoId));
  }

  async updateFromDiscussion(input: ProjectTodoDiscussionUpdateInput): Promise<ProjectTodo> {
    const authorization = input.authorization;
    if (authorization.agentName !== "lead") {
      throw new ProjectTodoDiscussionAuthorizationError("only Lead may update through a bound Discussion");
    }
    if (authorization.sessionId !== authorization.rootSessionId) {
      throw new ProjectTodoDiscussionAuthorizationError("Discussion must be a root Session");
    }
    if (authorization.projectSlug !== this.projectSlug) {
      throw new ProjectTodoDiscussionAuthorizationError("Discussion belongs to another Project");
    }
    const todo = await this.state.findByDiscussionSessionId(authorization.sessionId);
    if (todo === undefined) {
      throw new ProjectTodoDiscussionAuthorizationError("Session is not bound to a Project Todo Discussion");
    }
    const patch = ProjectTodoDiscussionUpdatePatchSchema.parse(input.patch);
    return this.state.updateTodo(todo.id, { expectedRevision: input.expectedRevision, patch });
  }

  /** Retries all durable checkpoints after Project context recovery. */
  async reconcileAll(): Promise<void> {
    for (const todo of await this.listTodos()) await this.reconcileTodo(todo.id);
  }

  async reconcileTodo(todoId: string): Promise<ProjectTodo> {
    let todo = await this.readTodo(todoId);
    if (todo.discussionSessionId !== undefined) await this.#ensureDiscussion(todo);
    if (todo.activation !== undefined) {
      await this.#ensureActivation(todo);
      todo = await this.#reconcileActivationResource(await this.readTodo(todoId));
    }
    return todo;
  }

  /** Post-commit resource notification. The provenance reader chooses the canonical earliest resource. */
  async handleResourceCreated(input: ProjectTodoResourceCreatedInput): Promise<ProjectTodo | undefined> {
    const todo = await this.state.findByActivationSourceSessionId(input.sourceSessionId);
    if (todo === undefined || todo.activation?.kind !== input.kind) return undefined;
    const resources = await this.#matchingResources(todo);
    if (!resources.some((resource) => resource.id === input.resourceId)) return todo;
    return this.#bindEarliestResource(todo, resources);
  }

  async returnToReady(todoId: string, expectedRevision: number): Promise<ProjectTodo> {
    const current = await this.readTodo(todoId);
    const activation = current.activation;
    if (activation === undefined) {
      throw new ProjectTodoActivationConflictError(todoId, undefined, "Project Todo has no Activation to clear");
    }
    if (current.status !== "ready" || current.archivedAt !== undefined) {
      throw new ProjectTodoReturnToReadyConflictError(todoId, "only an unarchived In Progress Todo can return to Ready");
    }

    const familyLease = await this.#sessions.acquireIdleFamily({
      workspaceRoot: this.workspaceRoot,
      rootSessionId: activation.sourceSessionId,
    });
    if (familyLease === undefined) {
      throw new ProjectTodoReturnToReadyConflictError(todoId, "source Session family is active");
    }

    try {
      const reconciled = await this.#reconcileActivationResource(current);
      const reconciledActivation = reconciled.activation;
      if (reconciledActivation === undefined || reconciledActivation.sourceSessionId !== activation.sourceSessionId) {
        throw new ProjectTodoActivationConflictError(todoId, reconciledActivation?.kind, "Project Todo Activation changed during readiness check");
      }
      if (reconciled.revision !== expectedRevision) {
        throw new ProjectTodoRevisionConflictError(todoId, expectedRevision, reconciled.revision);
      }

      if (reconciledActivation.kind !== "session") {
        const resources = await this.#matchingResources(reconciled);
        const exact = reconciledActivation.resourceId === undefined
          ? undefined
          : resources.find((resource) => resource.id === reconciledActivation.resourceId);
        if (exact !== undefined && !isInactiveResource(exact)) {
          throw new ProjectTodoReturnToReadyConflictError(todoId, `${exact.kind} resource ${exact.id} is ${exact.status}`);
        }
      }

      return this.state.clearActivation(todoId, expectedRevision, activation.sourceSessionId);
    } finally {
      familyLease.release();
    }
  }

  async findSessionOwners(sessionIds: readonly string[]): Promise<ProjectTodoSessionOwner[]> {
    return (await this.state.findSessionOwners(sessionIds)).filter((owner) => {
      // StateManager is workspace-scoped. Resolve the Todo only when a foreign
      // project slug could have been persisted in the same workspace file.
      return owner.ownerType === "project_todo";
    });
  }

  async #ensureDiscussion(todo: ProjectTodo): Promise<void> {
    const sessionId = todo.discussionSessionId;
    if (sessionId === undefined) return;
    await this.#ensureSession(sessionId, async () => {
      await this.#sessions.ensureRootSession({
        workspaceRoot: this.workspaceRoot,
        sessionId,
        agentName: "lead",
        title: `Discussion: ${todo.title}`,
      });
      await this.#sessions.ensureExecution({
        workspaceRoot: this.workspaceRoot,
        sessionId,
        executionId: discussionExecutionId(todo.id),
        userMessage: discussionMessage(todo),
      });
    });
  }

  async #ensureActivation(todo: ProjectTodo): Promise<void> {
    const activation = todo.activation;
    if (activation === undefined) return;
    await this.#ensureSession(activation.sourceSessionId, async () => {
      await this.#sessions.ensureRootSession({
        workspaceRoot: this.workspaceRoot,
        sessionId: activation.sourceSessionId,
        agentName: "lead",
        title: activation.snapshot.title,
      });
      await this.#sessions.ensureExecution({
        workspaceRoot: this.workspaceRoot,
        sessionId: activation.sourceSessionId,
        executionId: activationExecutionId(todo.id),
        userMessage: activationMessage(todo, activation.kind),
      });
    });
  }

  async #ensureSession(sessionId: string, operation: () => Promise<void>): Promise<void> {
    const existing = this.#sessionRecovery.get(sessionId);
    if (existing !== undefined) return existing;
    const pending = operation();
    this.#sessionRecovery.set(sessionId, pending);
    try {
      await pending;
    } finally {
      if (this.#sessionRecovery.get(sessionId) === pending) this.#sessionRecovery.delete(sessionId);
    }
  }

  async #reconcileActivationResource(todo: ProjectTodo): Promise<ProjectTodo> {
    if (todo.activation === undefined || todo.activation.kind === "session" || todo.activation.resourceId !== undefined) return todo;
    return this.#bindEarliestResource(todo, await this.#matchingResources(todo));
  }

  async #matchingResources(todo: ProjectTodo): Promise<readonly ProjectTodoResourceSnapshot[]> {
    const activation = todo.activation;
    if (activation === undefined || activation.kind === "session") return [];
    const resources = await this.#provenance.listResources({
      kind: activation.kind,
      sourceSessionId: activation.sourceSessionId,
    });
    return resources.filter((resource) => (
      resource.kind === activation.kind && resource.createdFromSessionId === activation.sourceSessionId
    ));
  }

  async #bindEarliestResource(todo: ProjectTodo, resources: readonly ProjectTodoResourceSnapshot[]): Promise<ProjectTodo> {
    const activation = todo.activation;
    if (activation === undefined || activation.kind === "session" || resources.length === 0) return todo;
    const earliest = [...resources].sort(compareResources)[0]!;
    return this.state.bindActivationResource(todo.id, activation.sourceSessionId, earliest.id);
  }

}

export function discussionExecutionId(todoId: string): string {
  return `project-todo:${todoId}:discussion`;
}

export function activationExecutionId(todoId: string): string {
  return `project-todo:${todoId}:activation`;
}

function discussionMessage(todo: ProjectTodo): string {
  return [
    "Discuss and shape the bound Project Todo. Do not start implementation or produce an implementation plan.",
    "Use project_todo_update to write confirmed corrections and decisions back to this same Todo.",
    todoSnapshot(todo),
  ].join("\n\n");
}

function activationMessage(todo: ProjectTodo, kind: ProjectTodoActivationKind): string {
  const activation = todo.activation;
  if (activation === undefined) throw new ProjectTodoActivationConflictError(todo.id, undefined, "Project Todo has no Activation snapshot");
  const snapshot = activationSnapshot(todo.id, activation.todoRevision, activation.snapshot);
  if (kind === "automation") {
    return `/skill use automation-create Create an Automation from the following Project Todo snapshot. Preserve the existing clarification and explicit confirmation flow; do not call automation_create before confirmation.\n\n${snapshot}`;
  }
  return `Implement the following Project Todo as an ordinary Lead Session. The snapshot is fixed at activation revision ${activation.todoRevision}.\n\n${snapshot}`;
}

function todoSnapshot(todo: ProjectTodo): string {
  return [
    `Todo ID: ${todo.id}`,
    `Revision: ${todo.revision}`,
    `Status: ${todo.status}`,
    `Title: ${todo.title}`,
    "Body:",
    todo.body,
  ].join("\n");
}

function activationSnapshot(
  todoId: string,
  revision: number,
  snapshot: { readonly title: string; readonly body: string },
): string {
  return [
    `Todo ID: ${todoId}`,
    `Revision: ${revision}`,
    "Status: ready",
    `Title: ${snapshot.title}`,
    "Body:",
    snapshot.body,
  ].join("\n");
}

function compareResources(left: ProjectTodoResourceSnapshot, right: ProjectTodoResourceSnapshot): number {
  const created = resourceTimestamp(left.createdAt) - resourceTimestamp(right.createdAt);
  return created === 0 ? left.id.localeCompare(right.id) : created;
}

function resourceTimestamp(value: string | number): number {
  const timestamp = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Number.MAX_SAFE_INTEGER;
}

function isInactiveResource(resource: ProjectTodoResourceSnapshot): boolean {
  return resource.status === "paused" || resource.status === "disabled";
}

function requireProjectSlug(projectSlug: string): string {
  const value = projectSlug.trim();
  if (value.length === 0) throw new Error("projectSlug must not be empty");
  return value;
}
