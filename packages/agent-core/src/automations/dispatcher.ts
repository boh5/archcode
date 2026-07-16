import type { AutomationInvocation } from "@archcode/protocol";

import { AutomationCoordinator } from "./coordinator";
import { AutomationStateManager } from "./state-manager";

export interface SessionMessageDispatchIdentity {
  readonly workspaceRoot: string;
  readonly projectSlug: string;
  readonly sessionId: string;
  readonly clientRequestId: string;
}

export type SessionDispatchInput =
  | (SessionMessageDispatchIdentity & {
    readonly kind: "start_session";
    readonly message: string;
    readonly location: "project" | "worktree";
  })
  | (SessionMessageDispatchIdentity & {
    readonly kind: "send_message";
    readonly message: string;
  });

/**
 * The only Automation-to-Session boundary. Implementations must route through
 * the ordinary Session message API and make clientRequestId acceptance idempotent.
 */
export interface SessionDispatchGateway {
  dispatch(input: SessionDispatchInput): Promise<void>;
}

export interface AutomationChangeNotification {
  readonly automationId: string;
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
      if (pending !== undefined) await this.#dispatchClaimedInvocation(pending.id);
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
    const identity = invocationIdentity(this.#stateManager.workspaceRoot, automation.projectSlug, invocation);

    let dispatchError: unknown;
    try {
      await this.#gateway.dispatch(automation.action.kind === "start_session"
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
    // Session accepted, the durable record remains pending and a retry submits
    // the same clientRequestId to the idempotent Session message boundary.
    return this.#markDispatched(invocation.id);
  }

  async dispatchPending(): Promise<AutomationInvocation[]> {
    const results: AutomationInvocation[] = [];
    for (const automation of await this.#stateManager.listAutomations()) {
      const pending = (await this.#stateManager.listInvocations(automation.id)).find((item) => item.status === "pending");
      if (pending) results.push(await this.dispatchInvocation(pending.id));
    }
    return results;
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
    });
  }
}

function requiredSessionId(invocation: AutomationInvocation): string {
  if (!invocation.sessionId) throw new Error(`Automation invocation ${invocation.id} has no preallocated Session id`);
  return invocation.sessionId;
}

function invocationIdentity(
  workspaceRoot: string,
  projectSlug: string,
  invocation: AutomationInvocation,
): SessionMessageDispatchIdentity {
  return {
    workspaceRoot,
    projectSlug,
    sessionId: requiredSessionId(invocation),
    clientRequestId: invocation.id,
  };
}
