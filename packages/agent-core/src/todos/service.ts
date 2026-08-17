import {
  PROJECT_STATE_DIR_NAME,
  projectTodoContentExcerpt,
  type CreateProjectTodoSessionInput,
  type CreateProjectTodoSessionResponse,
  type AttachmentDescriptor,
  type ProjectTodo,
  type ProjectTodoAttachmentListResponse,
  type ProjectTodoAttachmentMutationResponse,
  type ProjectTodoCreateInput,
  type ProjectTodoDiscussionUpdatePatch,
  type ProjectTodoRunNowInput,
  type ProjectTodoRunNowResponse,
  type ProjectTodoStartDiscussionInput,
  type ProjectTodoStartDiscussionResponse,
  type RootSessionSummary,
  type RootSessionSource,
  type ProjectTodoUpdateInput,
} from "@archcode/protocol";
import { join } from "node:path";

import {
  ProjectAttachmentStorage,
  type OpenProjectAttachmentResult,
  type VerifiedProjectAttachment,
} from "../attachments";
import type { Logger } from "../logger";
import {
  ProjectTodoAttachmentService,
  type OpenProjectTodoAttachmentInput,
  type RemoveProjectTodoAttachmentInput,
  type UploadProjectTodoAttachmentInput,
} from "./attachments";

import {
  ProjectTodoDiscussionAuthorizationError,
  ProjectTodoRunNowConflictError,
  ProjectTodoRunNowRecoveryError,
  ProjectTodoStartDiscussionConflictError,
  ProjectTodoStartDiscussionRecoveryError,
} from "./errors";
import {
  CreateProjectTodoSessionSchema,
  ProjectTodoDiscussionUpdatePatchSchema,
  ProjectTodoRunNowSchema,
  ProjectTodoStartDiscussionSchema,
} from "./schema";
import { ProjectTodoStateManager } from "./state-manager";

export interface ProjectTodoSessionCapability {
  createRootSession(input: {
    readonly workspaceRoot: string;
    readonly sessionId: string;
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
  }): Promise<RootSessionSummary | undefined>;
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

type PreparedRootSession = Parameters<ProjectTodoSessionCapability["createRootSession"]>[0];
type PreparedRootSessionOutcome =
  | { readonly kind: "ready" }
  | { readonly kind: "absent"; readonly cause: unknown }
  | { readonly kind: "indeterminate"; readonly cause: unknown };
type ProjectTodoCaptureMode = "run_now" | "start_discussion";
type ProjectTodoCaptureInput = ProjectTodoRunNowInput | ProjectTodoStartDiscussionInput;
type ProjectTodoCaptureResponse = ProjectTodoRunNowResponse | ProjectTodoStartDiscussionResponse;
interface ProjectTodoCaptureReceipt {
  readonly clientRequestId: string;
  readonly requestHash: string;
  readonly todoId: string;
  readonly sessionId: string;
  readonly status: "preparing" | "recovery_required" | "accepted";
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
  readonly attachmentStorage?: ProjectAttachmentStorage;
  readonly logger?: Logger;
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
  readonly #attachments: ProjectTodoAttachmentService;
  readonly #captureInFlight = new Map<string, {
    readonly requestHash: string;
    readonly promise: Promise<ProjectTodoCaptureResponse>;
  }>();

  constructor(options: ProjectTodoServiceOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.projectSlug = requireProjectSlug(options.projectSlug);
    this.#state = options.state ?? new ProjectTodoStateManager(options.workspaceRoot);
    this.#sessions = options.sessions;
    this.#attachments = new ProjectTodoAttachmentService({
      workspaceRoot: options.workspaceRoot,
      state: this.#state,
      storage: options.attachmentStorage ?? new ProjectAttachmentStorage(),
      logger: options.logger,
    });
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

  async listAttachments(todoId: string): Promise<ProjectTodoAttachmentListResponse> {
    return await this.#attachments.list(todoId);
  }

  async uploadAttachment(
    input: UploadProjectTodoAttachmentInput,
  ): Promise<ProjectTodoAttachmentMutationResponse> {
    return await this.#attachments.upload(input);
  }

  async openAttachment(
    input: OpenProjectTodoAttachmentInput,
  ): Promise<OpenProjectAttachmentResult> {
    return await this.#attachments.openDownload(input);
  }

  async resolveAttachmentReadPath(
    input: OpenProjectTodoAttachmentInput,
    expectedDescriptor: AttachmentDescriptor,
  ): Promise<string> {
    return await this.#attachments.resolveReadPath(input, expectedDescriptor);
  }

  async readVerifiedAttachment(
    input: OpenProjectTodoAttachmentInput,
    expectedDescriptor: AttachmentDescriptor,
  ): Promise<VerifiedProjectAttachment> {
    return await this.#attachments.readVerified(input, expectedDescriptor);
  }

  async removeAttachment(input: RemoveProjectTodoAttachmentInput): Promise<ProjectTodo> {
    return await this.#attachments.remove(input);
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
      sessionId: crypto.randomUUID(),
      agentName: request.entry === "discussion" ? "discussion" : "lead",
      title: request.entry === "discussion"
        ? `Discussion: ${projectTodoContentExcerpt(todo.content)}`
        : projectTodoContentExcerpt(todo.content),
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
    return await this.#capture("run_now", ProjectTodoRunNowSchema.parse(input));
  }

  async startDiscussion(
    input: ProjectTodoStartDiscussionInput,
  ): Promise<ProjectTodoStartDiscussionResponse> {
    return await this.#capture(
      "start_discussion",
      ProjectTodoStartDiscussionSchema.parse(input),
    );
  }

  async #capture(
    mode: ProjectTodoCaptureMode,
    request: ProjectTodoCaptureInput,
  ): Promise<ProjectTodoCaptureResponse> {
    const requestHash = hashTodoCaptureRequest(request.content);
    const key = `${mode}\0${request.clientRequestId}`;
    const inFlight = this.#captureInFlight.get(key);
    if (inFlight !== undefined) {
      if (inFlight.requestHash !== requestHash) {
        throw captureConflict(mode, request.clientRequestId);
      }
      return await inFlight.promise;
    }

    const promise = this.#captureOnce(mode, request, requestHash);
    this.#captureInFlight.set(key, { requestHash, promise });
    try {
      return await promise;
    } finally {
      if (this.#captureInFlight.get(key)?.promise === promise) {
        this.#captureInFlight.delete(key);
      }
    }
  }

  async #captureOnce(
    mode: ProjectTodoCaptureMode,
    request: ProjectTodoCaptureInput,
    requestHash: string,
  ): Promise<ProjectTodoCaptureResponse> {
    const receipt = await this.#readCaptureReceipt(mode, request.clientRequestId);
    if (receipt !== undefined) {
      if (receipt.requestHash !== requestHash) {
        throw captureConflict(mode, request.clientRequestId);
      }
      if (receipt.status === "accepted") {
        return await this.#readCaptureResponse(mode, receipt.todoId, receipt.sessionId);
      }
      if (receipt.status === "recovery_required") {
        throw captureRecovery(
          mode,
          receipt.todoId,
          receipt.sessionId,
          `${captureLabel(mode)} retained work that requires inspection before another attempt`,
        );
      }
      return await this.#resumePreparedCapture(
        mode,
        request.clientRequestId,
        receipt.todoId,
        receipt.sessionId,
      );
    }

    const { todo, receipt: prepared } = await this.#beginCapture(mode, {
      content: request.content,
      clientRequestId: request.clientRequestId,
      requestHash,
    });
    return await this.#resumePreparedCapture(
      mode,
      request.clientRequestId,
      todo.id,
      prepared.sessionId,
    );
  }

  async #resumePreparedCapture(
    mode: ProjectTodoCaptureMode,
    clientRequestId: string,
    todoId: string,
    sessionId: string,
  ): Promise<ProjectTodoCaptureResponse> {
    const todo = await this.#readCaptureTodo(mode, clientRequestId);
    const prepared = preparedCaptureSession(mode, this.workspaceRoot, sessionId, todo);
    const ensured = await this.#ensurePreparedRootSession(prepared);
    if (ensured.kind === "absent") {
      await this.#compensateCapture(
        mode,
        clientRequestId,
        todoId,
        sessionId,
        false,
        ensured.cause,
      );
      throw asError(ensured.cause);
    }
    if (ensured.kind === "indeterminate") {
      let cause = ensured.cause;
      try {
        await this.#markCaptureRecoveryRequired(mode, clientRequestId);
      } catch (recoveryError) {
        cause = new AggregateError([cause, recoveryError]);
      }
      throw captureRecovery(
        mode,
        todoId,
        sessionId,
        `${captureLabel(mode)} could not determine the exact prepared Session identity`,
        { cause },
      );
    }
    return await this.#acceptPreparedCapture(mode, clientRequestId, todoId, sessionId);
  }

  async #readCaptureReceipt(
    mode: ProjectTodoCaptureMode,
    clientRequestId: string,
  ): Promise<ProjectTodoCaptureReceipt | undefined> {
    return mode === "run_now"
      ? await this.#state.readRunNowReceipt(clientRequestId)
      : await this.#state.readStartDiscussionReceipt(clientRequestId);
  }

  async #beginCapture(
    mode: ProjectTodoCaptureMode,
    input: ProjectTodoCreateInput & {
      readonly clientRequestId: string;
      readonly requestHash: string;
    },
  ): Promise<{ readonly todo: ProjectTodo; readonly receipt: ProjectTodoCaptureReceipt }> {
    return mode === "run_now"
      ? await this.#state.beginRunNow(input)
      : await this.#state.beginStartDiscussion(input);
  }

  async #readCaptureTodo(
    mode: ProjectTodoCaptureMode,
    clientRequestId: string,
  ): Promise<ProjectTodo> {
    return mode === "run_now"
      ? await this.#state.readRunNowTodo(clientRequestId)
      : await this.#state.readStartDiscussionTodo(clientRequestId);
  }

  async #completeCapture(mode: ProjectTodoCaptureMode, clientRequestId: string): Promise<void> {
    if (mode === "run_now") {
      await this.#state.completeRunNow(clientRequestId);
    } else {
      await this.#state.completeStartDiscussion(clientRequestId);
    }
  }

  async #markCaptureRecoveryRequired(
    mode: ProjectTodoCaptureMode,
    clientRequestId: string,
  ): Promise<void> {
    if (mode === "run_now") {
      await this.#state.markRunNowRecoveryRequired(clientRequestId);
    } else {
      await this.#state.markStartDiscussionRecoveryRequired(clientRequestId);
    }
  }

  async #deletePendingCapture(
    mode: ProjectTodoCaptureMode,
    clientRequestId: string,
    todoId: string,
  ): Promise<void> {
    if (mode === "run_now") {
      await this.#state.deletePendingRunNow(clientRequestId, todoId);
    } else {
      await this.#state.deletePendingStartDiscussion(clientRequestId, todoId);
    }
  }

  async #ensurePreparedRootSession(
    prepared: PreparedRootSession,
  ): Promise<PreparedRootSessionOutcome> {
    try {
      const created = await this.#sessions.createRootSession(prepared);
      return created.sessionId === prepared.sessionId
        ? { kind: "ready" }
        : {
            kind: "indeterminate",
            cause: new Error(
              `Prepared Session ${prepared.sessionId} returned a different id: ${created.sessionId}`,
            ),
          };
    } catch (creationError) {
      let existing: RootSessionSummary | undefined;
      try {
        existing = await this.#sessions.readRootSession({
          workspaceRoot: prepared.workspaceRoot,
          sessionId: prepared.sessionId,
        });
      } catch (readError) {
        return {
          kind: "indeterminate",
          cause: new AggregateError([creationError, readError]),
        };
      }
      if (existing === undefined) return { kind: "absent", cause: creationError };
      if (matchesPreparedRootSession(existing, prepared)) return { kind: "ready" };
      return {
        kind: "indeterminate",
        cause: new AggregateError([
          creationError,
          new Error(`Prepared Session ${prepared.sessionId} has a different durable identity`),
        ]),
      };
    }
  }

  async #acceptPreparedCapture(
    mode: ProjectTodoCaptureMode,
    clientRequestId: string,
    todoId: string,
    sessionId: string,
  ): Promise<ProjectTodoCaptureResponse> {
    const todo = await this.#readCaptureTodo(mode, clientRequestId);
    try {
      await this.#sessions.acceptMessage({
        workspaceRoot: this.workspaceRoot,
        sessionId,
        text: captureSessionMessage(mode, todo),
        clientRequestId,
      });
    } catch (error) {
      let durable: boolean;
      try {
        durable = await this.#sessions.hasDurableMessage({
          workspaceRoot: this.workspaceRoot,
          sessionId,
          clientRequestId,
        });
      } catch (receiptError) {
        let cause: unknown = new AggregateError([error, receiptError]);
        try {
          await this.#markCaptureRecoveryRequired(mode, clientRequestId);
        } catch (recoveryError) {
          cause = new AggregateError([error, receiptError, recoveryError]);
        }
        throw captureRecovery(
          mode,
          todoId,
          sessionId,
          `${captureLabel(mode)} failed after Session creation, and durable message acceptance could not be determined`,
          { cause },
        );
      }
      if (!durable) {
        await this.#compensateCapture(mode, clientRequestId, todoId, sessionId, true, error);
        throw error;
      }
    }

    try {
      await this.#completeCapture(mode, clientRequestId);
    } catch (error) {
      let cause: unknown = error;
      try {
        await this.#markCaptureRecoveryRequired(mode, clientRequestId);
      } catch (recoveryError) {
        cause = new AggregateError([error, recoveryError]);
      }
      throw captureRecovery(
        mode,
        todoId,
        sessionId,
        `${captureLabel(mode)} was accepted, but its idempotency receipt could not be committed`,
        { cause },
      );
    }
    return await this.#readCaptureResponse(mode, todoId, sessionId);
  }

  async #readCaptureResponse(
    mode: ProjectTodoCaptureMode,
    todoId: string,
    sessionId: string,
  ): Promise<ProjectTodoCaptureResponse> {
    try {
      const session = await this.#sessions.readRootSession({ workspaceRoot: this.workspaceRoot, sessionId });
      if (session === undefined) {
        throw new Error(`Accepted ${captureLabel(mode)} Session is missing: ${sessionId}`);
      }
      return {
        todo: await this.#state.readTodo(todoId),
        session,
      };
    } catch (error) {
      throw captureRecovery(
        mode,
        todoId,
        sessionId,
        `${captureLabel(mode)} retained an accepted receipt whose exact entities could not be read`,
        { cause: error },
      );
    }
  }

  async #compensateCapture(
    mode: ProjectTodoCaptureMode,
    clientRequestId: string,
    todoId: string,
    sessionId: string,
    deleteSession: boolean,
    cause: unknown,
  ): Promise<void> {
    try {
      if (deleteSession) {
        await this.#sessions.deleteSession({ workspaceRoot: this.workspaceRoot, sessionId });
      }
      await this.#deletePendingCapture(mode, clientRequestId, todoId);
    } catch (error) {
      try {
        await this.#markCaptureRecoveryRequired(mode, clientRequestId);
      } catch (recoveryError) {
        error = new AggregateError([error, recoveryError]);
      }
      throw captureRecovery(
        mode,
        todoId,
        sessionId,
        `${captureLabel(mode)} failed and its partial entities could not be fully removed`,
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

function hashTodoCaptureRequest(content: string): string {
  return new Bun.CryptoHasher("sha256")
    .update(JSON.stringify({ content }))
    .digest("hex");
}

function captureConflict(
  mode: ProjectTodoCaptureMode,
  clientRequestId: string,
): ProjectTodoRunNowConflictError | ProjectTodoStartDiscussionConflictError {
  return mode === "run_now"
    ? new ProjectTodoRunNowConflictError(clientRequestId)
    : new ProjectTodoStartDiscussionConflictError(clientRequestId);
}

function captureRecovery(
  mode: ProjectTodoCaptureMode,
  todoId: string,
  sessionId: string,
  message: string,
  options?: ErrorOptions,
): ProjectTodoRunNowRecoveryError | ProjectTodoStartDiscussionRecoveryError {
  return mode === "run_now"
    ? new ProjectTodoRunNowRecoveryError(todoId, sessionId, message, options)
    : new ProjectTodoStartDiscussionRecoveryError(todoId, sessionId, message, options);
}

function captureLabel(mode: ProjectTodoCaptureMode): "Run now" | "Start discussion" {
  return mode === "run_now" ? "Run now" : "Start discussion";
}

function preparedCaptureSession(
  mode: ProjectTodoCaptureMode,
  workspaceRoot: string,
  sessionId: string,
  todo: ProjectTodo,
): PreparedRootSession {
  return {
    workspaceRoot,
    sessionId,
    agentName: mode === "run_now" ? "lead" : "discussion",
    title: mode === "run_now"
      ? projectTodoContentExcerpt(todo.content)
      : `Discussion: ${projectTodoContentExcerpt(todo.content)}`,
    source: {
      kind: "todo",
      todoId: todo.id,
      entry: mode === "run_now" ? "work" : "discussion",
    },
  };
}

function captureSessionMessage(mode: ProjectTodoCaptureMode, todo: ProjectTodo): string {
  return mode === "run_now"
    ? `Implement the following Project Todo as an ordinary Lead Session.\n\n${todoSource(todo)}`
    : sessionMessage(todo, todo.revision, "discussion");
}

function matchesPreparedRootSession(
  session: RootSessionSummary,
  prepared: PreparedRootSession,
): boolean {
  return session.sessionId === prepared.sessionId
    && session.rootSessionId === prepared.sessionId
    && session.cwd === prepared.workspaceRoot
    && session.agentName === prepared.agentName
    && sameRootSessionSource(session.source, prepared.source);
}

function sameRootSessionSource(
  actual: RootSessionSource | undefined,
  expected: RootSessionSource,
): boolean {
  if (actual?.kind !== expected.kind) return false;
  if (actual.kind === "direct" && expected.kind === "direct") return true;
  if (actual.kind === "todo" && expected.kind === "todo") {
    return actual.todoId === expected.todoId && actual.entry === expected.entry;
  }
  return actual.kind === "automation"
    && expected.kind === "automation"
    && actual.automationId === expected.automationId
    && actual.invocationId === expected.invocationId
    && actual.todoId === expected.todoId;
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

function requireProjectSlug(projectSlug: string): string {
  const value = projectSlug.trim();
  if (value.length === 0) throw new Error("projectSlug must not be empty");
  return value;
}
