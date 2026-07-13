import type { AutomationInvocation } from "@archcode/protocol";

import { AutomationCoordinator } from "./coordinator";
import { AutomationStateManager } from "./state-manager";

export type SessionExecutionDispatchState = "missing" | "ready" | "active" | "accepted" | "unavailable";

export interface SessionExecutionIdentity {
  readonly workspaceRoot: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly executionId: string;
}

export type SessionDispatchInput =
  | (SessionExecutionIdentity & {
    readonly kind: "start_session";
    readonly message: string;
    readonly location: "project" | "worktree";
  })
  | (SessionExecutionIdentity & {
    readonly kind: "send_message";
    readonly message: string;
  });

/**
 * The only Automation-to-Session boundary. Implementations must route through
 * the ordinary Session execution API and make executionId acceptance idempotent.
 */
export interface SessionDispatchGateway {
  inspectExecution(identity: SessionExecutionIdentity): Promise<SessionExecutionDispatchState>;
  dispatch(input: SessionDispatchInput): Promise<{ readonly accepted: boolean }>;
}

export type AutomationChangeReason = "created" | "updated" | "deleted" | "invocation_changed";

export interface AutomationChangeNotification {
  readonly automationId: string;
  readonly reason: AutomationChangeReason;
}

export type AutomationChangeListener = (change: AutomationChangeNotification) => void;

export interface AutomationDispatcherOptions {
  readonly stateManager: AutomationStateManager;
  readonly gateway: SessionDispatchGateway;
  readonly now?: () => number;
  readonly onChange?: AutomationChangeListener;
  readonly coordinator?: AutomationCoordinator;
}

export class AutomationDispatcher {
  readonly coordinator: AutomationCoordinator;
  readonly #stateManager: AutomationStateManager;
  readonly #gateway: SessionDispatchGateway;
  readonly #now: () => number;
  readonly #onChange: AutomationChangeListener | undefined;
  readonly #dispatches = new Map<string, Promise<AutomationInvocation>>();

  constructor(options: AutomationDispatcherOptions) {
    this.#stateManager = options.stateManager;
    this.#gateway = options.gateway;
    this.#now = options.now ?? Date.now;
    this.#onChange = options.onChange;
    this.coordinator = options.coordinator ?? new AutomationCoordinator();
  }

  async dispatchInvocation(invocationId: string): Promise<AutomationInvocation> {
    const existing = this.#dispatches.get(invocationId);
    if (existing) return existing;
    const operation = this.#dispatchInvocation(invocationId);
    this.#dispatches.set(invocationId, operation);
    try {
      return await operation;
    } finally {
      if (this.#dispatches.get(invocationId) === operation) this.#dispatches.delete(invocationId);
    }
  }

  async reconcileAcceptedBeforeMutation<T>(
    automationId: string,
    mutation: () => Promise<T>,
  ): Promise<T> {
    return await this.coordinator.runExclusive(automationId, async () => {
      const pending = (await this.#stateManager.listInvocations(automationId))
        .find((invocation) => invocation.status === "pending");
      if (pending !== undefined) await this.#recoverAcceptedInvocation(pending);
      return await mutation();
    });
  }

  async #dispatchInvocation(invocationId: string): Promise<AutomationInvocation> {
    const invocation = await this.#stateManager.readInvocation(invocationId);
    return await this.coordinator.runExclusive(invocation.automationId, async () => {
      return await this.#dispatchClaimedInvocation(invocationId);
    });
  }

  async #dispatchClaimedInvocation(invocationId: string): Promise<AutomationInvocation> {
    const invocation = await this.#stateManager.readInvocation(invocationId);
    if (invocation.status !== "pending") return invocation;
    const automation = await this.#stateManager.readAutomation(invocation.automationId);
    const identity = invocationIdentity(this.#stateManager.workspaceRoot, automation.projectId, invocation);
    const recovered = await this.#recoverAcceptedInvocation(invocation, identity);
    if (recovered.status !== "pending") return recovered;
    const recoveredState = await this.#gateway.inspectExecution(identity);
    if (recoveredState === "unavailable") return invocation;
    if (await this.#hasActivePreviousInvocation(invocation)) return invocation;

    let dispatchError: unknown;
    try {
      const result = await this.#gateway.dispatch(automation.action.kind === "start_session"
        ? {
          ...identity,
          kind: "start_session",
          message: automation.action.message,
          location: automation.action.location,
        }
        : {
          ...identity,
          kind: "send_message",
          message: automation.action.message,
        });
      if (!result.accepted) throw new Error("Session gateway did not accept the execution");
    } catch (error) {
      dispatchError = error;
    }
    if (dispatchError !== undefined) {
      const completedAt = new Date(this.#now()).toISOString();
      const failed = await this.#stateManager.updateInvocation(invocation.id, {
        status: "failed",
        completedAt,
        error: dispatchError instanceof Error ? dispatchError.message : String(dispatchError),
      });
      this.#notifyInvocationChanged(failed);
      return failed;
    }
    // Deliberately outside the dispatch catch: if this write fails after the
    // Session accepted, the durable record remains pending and recovery probes
    // the same preallocated identities instead of misclassifying it as failed.
    return this.#markDispatched(invocation.id);
  }

  async #recoverAcceptedInvocation(
    invocation: AutomationInvocation,
    knownIdentity?: SessionExecutionIdentity,
  ): Promise<AutomationInvocation> {
    const automation = knownIdentity === undefined
      ? await this.#stateManager.readAutomation(invocation.automationId)
      : undefined;
    const identity = knownIdentity ?? invocationIdentity(
      this.#stateManager.workspaceRoot,
      automation!.projectId,
      invocation,
    );
    const recoveredState = await this.#gateway.inspectExecution(identity);
    return recoveredState === "accepted" || recoveredState === "active"
      ? await this.#markDispatched(invocation.id)
      : invocation;
  }

  async dispatchPending(): Promise<AutomationInvocation[]> {
    const results: AutomationInvocation[] = [];
    for (const automation of await this.#stateManager.listAutomations()) {
      const pending = (await this.#stateManager.listInvocations(automation.id)).find((item) => item.status === "pending");
      if (pending) results.push(await this.dispatchInvocation(pending.id));
    }
    return results;
  }

  async #hasActivePreviousInvocation(invocation: AutomationInvocation): Promise<boolean> {
    const history = await this.#stateManager.listInvocations(invocation.automationId);
    const previous = [...history].reverse().find((item) => item.id !== invocation.id && item.status === "dispatched" && item.sessionId !== undefined);
    if (!previous?.sessionId) return false;
    const automation = await this.#stateManager.readAutomation(invocation.automationId);
    const state = await this.#gateway.inspectExecution({
      workspaceRoot: this.#stateManager.workspaceRoot,
      projectId: automation.projectId,
      sessionId: previous.sessionId,
      executionId: previous.executionId,
    });
    return state === "active" || state === "unavailable";
  }

  async #markDispatched(invocationId: string): Promise<AutomationInvocation> {
    const dispatched = await this.#stateManager.updateInvocation(invocationId, {
      status: "dispatched",
      dispatchedAt: new Date(this.#now()).toISOString(),
    });
    this.#notifyInvocationChanged(dispatched);
    return dispatched;
  }

  #notifyInvocationChanged(invocation: AutomationInvocation): void {
    this.#onChange?.({
      automationId: invocation.automationId,
      reason: "invocation_changed",
    });
  }
}

function requiredSessionId(invocation: AutomationInvocation): string {
  if (!invocation.sessionId) throw new Error(`Automation invocation ${invocation.id} has no preallocated Session id`);
  return invocation.sessionId;
}

function invocationIdentity(
  workspaceRoot: string,
  projectId: string,
  invocation: AutomationInvocation,
): SessionExecutionIdentity {
  return {
    workspaceRoot,
    projectId,
    sessionId: requiredSessionId(invocation),
    executionId: invocation.executionId,
  };
}
