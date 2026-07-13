import { resolve } from "node:path";
import type { SessionFamilyActivity } from "@archcode/protocol";

import type { ActiveSessionExecution, StartSessionExecutionInput } from "../execution";
import type { ProjectInfo } from "../projects/types";
import { SessionFileNotFoundError } from "../store/errors";
import type { HydratedSessionFile } from "../store/helpers";
import type { SessionStoreManager } from "../store/session-store-manager";
import {
  isManagedWorktreeFor,
  WorktreeService,
  type WorktreeInfo,
} from "../worktrees";
import type {
  SessionDispatchGateway,
  SessionDispatchInput,
  SessionExecutionDispatchState,
  SessionExecutionIdentity,
} from "./dispatcher";

export interface AutomationSessionRuntime {
  getSessionExecution(workspaceRoot: string, sessionId: string): ActiveSessionExecution | undefined;
  getSessionFamilyActivity(workspaceRoot: string, rootSessionId: string): SessionFamilyActivity;
  startSessionMessageExecution(input: StartSessionExecutionInput): Promise<ActiveSessionExecution>;
}

export interface RuntimeSessionDispatchGatewayOptions {
  readonly sessionStoreManager: Pick<
    SessionStoreManager,
    "createSessionFile" | "getSessionFile"
  >;
  readonly sessionRuntime: AutomationSessionRuntime;
  readonly resolveProject: (projectId: string) => Promise<Pick<ProjectInfo, "slug" | "workspaceRoot"> | undefined>;
  readonly worktreeServiceFactory?: (workspaceRoot: string) => Pick<
    WorktreeService,
    "create" | "findManaged" | "validate" | "validateManagedClaim"
  >;
}

export class AutomationSessionIdentityError extends Error {
  constructor(
    public readonly sessionId: string,
    message: string,
  ) {
    super(message);
    this.name = "AutomationSessionIdentityError";
  }
}

/** Bridges Automation dispatch into the ordinary checked Session message path. */
export class RuntimeSessionDispatchGateway implements SessionDispatchGateway {
  readonly #sessions: RuntimeSessionDispatchGatewayOptions["sessionStoreManager"];
  readonly #runtime: AutomationSessionRuntime;
  readonly #resolveProject: RuntimeSessionDispatchGatewayOptions["resolveProject"];
  readonly #worktreeServiceFactory: NonNullable<RuntimeSessionDispatchGatewayOptions["worktreeServiceFactory"]>;
  readonly #dispatches = new Map<string, Promise<{ readonly accepted: boolean }>>();

  constructor(options: RuntimeSessionDispatchGatewayOptions) {
    this.#sessions = options.sessionStoreManager;
    this.#runtime = options.sessionRuntime;
    this.#resolveProject = options.resolveProject;
    this.#worktreeServiceFactory = options.worktreeServiceFactory
      ?? ((workspaceRoot) => new WorktreeService({ canonicalRoot: workspaceRoot }));
  }

  async inspectExecution(identity: SessionExecutionIdentity): Promise<SessionExecutionDispatchState> {
    const live = this.#runtime.getSessionExecution(identity.workspaceRoot, identity.sessionId);
    if (live !== undefined) return live.executionId === identity.executionId ? "active" : "unavailable";

    const session = await this.#readSession(identity.workspaceRoot, identity.sessionId);
    if (session === undefined) return "missing";
    const execution = session.executions.find((item) => item.id === identity.executionId);
    if (execution !== undefined) {
      return execution.status === "running" || execution.status === "waiting_for_human"
        ? "active"
        : "accepted";
    }
    return this.#runtime.getSessionFamilyActivity(identity.workspaceRoot, session.rootSessionId) === "idle"
      ? "ready"
      : "unavailable";
  }

  async dispatch(input: SessionDispatchInput): Promise<{ readonly accepted: boolean }> {
    const key = `${input.workspaceRoot}\0${input.executionId}`;
    const existing = this.#dispatches.get(key);
    if (existing !== undefined) return await existing;
    const pending = this.#dispatch(input).finally(() => {
      if (this.#dispatches.get(key) === pending) this.#dispatches.delete(key);
    });
    this.#dispatches.set(key, pending);
    return await pending;
  }

  async #dispatch(input: SessionDispatchInput): Promise<{ readonly accepted: boolean }> {
    const state = await this.inspectExecution(input);
    if (state === "active" || state === "accepted") return { accepted: true };
    if (state === "unavailable") return { accepted: false };

    const project = await this.#resolveProject(input.projectId);
    if (project === undefined || project.workspaceRoot !== input.workspaceRoot || project.slug !== input.projectId) {
      throw new Error(`Automation project scope is unavailable: ${input.projectId}`);
    }

    if (input.kind === "start_session") {
      let session = await this.#readSession(input.workspaceRoot, input.sessionId);
      if (session === undefined) {
        const cwd = input.location === "project"
          ? input.workspaceRoot
          : await this.#prepareWorktree(input.workspaceRoot, input.sessionId);
        session = await this.#sessions.createSessionFile(
          input.workspaceRoot,
          { agentName: "engineer", cwd },
          input.sessionId,
        );
      }
      await this.#assertStartSessionIdentity(session, input.location, input.workspaceRoot);
    } else if (await this.#readSession(input.workspaceRoot, input.sessionId) === undefined) {
      throw new SessionFileNotFoundError(input.sessionId);
    }

    await this.#runtime.startSessionMessageExecution({
      slug: project.slug,
      workspaceRoot: input.workspaceRoot,
      sessionId: input.sessionId,
      userMessage: input.message,
      origin: "user_message",
      executionId: input.executionId,
    });
    return { accepted: true };
  }

  async #prepareWorktree(workspaceRoot: string, sessionId: string): Promise<string> {
    const worktrees = this.#worktreeServiceFactory(workspaceRoot);
    const owner = { type: "session" as const, id: sessionId };
    const existing = await worktrees.findManaged({ owner });
    if (existing === undefined) {
      return (await worktrees.create({ owner, label: "automation" })).worktreePath;
    }
    if (existing.branchName === undefined) {
      throw new AutomationSessionIdentityError(sessionId, `Automation Session ${sessionId} worktree has no branch`);
    }
    const claim = await worktrees.validateManagedClaim({
      path: existing.path,
      branchName: existing.branchName,
      mode: "orphan",
    });
    return claim.worktree.path;
  }

  async #assertStartSessionIdentity(
    session: HydratedSessionFile,
    location: "project" | "worktree",
    workspaceRoot: string,
  ): Promise<void> {
    if (
      session.rootSessionId !== session.sessionId
      || session.parentSessionId !== undefined
      || session.goalId !== undefined
      || session.agentName !== "engineer"
    ) {
      throw new AutomationSessionIdentityError(
        session.sessionId,
        `Preallocated Automation Session ${session.sessionId} has an incompatible identity`,
      );
    }
    if (location === "project") {
      if (resolve(session.cwd) !== resolve(workspaceRoot)) {
        throw new AutomationSessionIdentityError(
          session.sessionId,
          `Preallocated Automation Session ${session.sessionId} is not in the project checkout`,
        );
      }
      return;
    }
    const worktree = await this.#worktreeServiceFactory(workspaceRoot).validate(session.cwd);
    if (!isAutomationSessionWorktree(worktree, session.sessionId)) {
      throw new AutomationSessionIdentityError(
        session.sessionId,
        `Preallocated Automation Session ${session.sessionId} does not own its worktree`,
      );
    }
  }

  async #readSession(workspaceRoot: string, sessionId: string): Promise<HydratedSessionFile | undefined> {
    try {
      return await this.#sessions.getSessionFile(workspaceRoot, sessionId);
    } catch (error) {
      if (error instanceof SessionFileNotFoundError) return undefined;
      throw error;
    }
  }
}

function isAutomationSessionWorktree(worktree: WorktreeInfo, sessionId: string): boolean {
  return !worktree.isCanonical
    && isManagedWorktreeFor(worktree, { owner: { type: "session", id: sessionId } });
}
