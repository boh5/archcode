import { resolve } from "node:path";

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
} from "./dispatcher";

export interface AutomationSessionRuntime {
  acceptSessionMessage(input: {
    readonly slug: string;
    readonly workspaceRoot: string;
    readonly sessionId: string;
    readonly text: string;
    readonly clientRequestId: string;
    readonly source: "automation";
  }): Promise<{ readonly clientRequestId: string; readonly messageId: string }>;
}

export interface RuntimeSessionDispatchGatewayOptions {
  readonly sessionStoreManager: Pick<
    SessionStoreManager,
    "createSessionFile" | "getSessionFile"
  >;
  readonly sessionRuntime: AutomationSessionRuntime;
  readonly resolveProject: (projectSlug: string) => Promise<Pick<ProjectInfo, "slug" | "workspaceRoot"> | undefined>;
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
  readonly #dispatches = new Map<string, Promise<void>>();

  constructor(options: RuntimeSessionDispatchGatewayOptions) {
    this.#sessions = options.sessionStoreManager;
    this.#runtime = options.sessionRuntime;
    this.#resolveProject = options.resolveProject;
    this.#worktreeServiceFactory = options.worktreeServiceFactory
      ?? ((workspaceRoot) => new WorktreeService({ canonicalRoot: workspaceRoot }));
  }

  async dispatch(input: SessionDispatchInput): Promise<void> {
    const key = `${input.workspaceRoot}\0${input.clientRequestId}`;
    const existing = this.#dispatches.get(key);
    if (existing !== undefined) return await existing;
    const pending = this.#dispatch(input).finally(() => {
      if (this.#dispatches.get(key) === pending) this.#dispatches.delete(key);
    });
    this.#dispatches.set(key, pending);
    return await pending;
  }

  async #dispatch(input: SessionDispatchInput): Promise<void> {
    const project = await this.#resolveProject(input.projectSlug);
    if (project === undefined || project.workspaceRoot !== input.workspaceRoot || project.slug !== input.projectSlug) {
      throw new Error(`Automation project scope is unavailable: ${input.projectSlug}`);
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
    } else {
      const session = await this.#readSession(input.workspaceRoot, input.sessionId);
      if (session === undefined) throw new SessionFileNotFoundError(input.sessionId);
      this.#assertRootSessionIdentity(session);
    }

    await this.#runtime.acceptSessionMessage({
      slug: project.slug,
      workspaceRoot: input.workspaceRoot,
      sessionId: input.sessionId,
      text: input.message,
      clientRequestId: input.clientRequestId,
      source: "automation",
    });
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

  #assertRootSessionIdentity(session: HydratedSessionFile): void {
    if (session.rootSessionId !== session.sessionId || session.parentSessionId !== undefined) {
      throw new AutomationSessionIdentityError(
        session.sessionId,
        `Automation messages can target only a root Session: ${session.sessionId}`,
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
