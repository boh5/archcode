import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { GlobalSSEEvent, GlobalSessionEventEnvelope } from "@specra/protocol";
import type { SessionAgentManager } from "../agents/session-agent-manager";
import { AgentRunningError } from "../agents/errors";
import type { CommandResult } from "../commands/types";
import type { AskUserResponse } from "../deferred";
import { getSessionsDir } from "../store/sessions-dir";
import { scopedKey } from "../store/key";
import type { SessionStoreManager } from "../store/session-store-manager";
import type { SessionEventEnvelope, SessionStoreState } from "../store/types";
import type { AskUserRequest, ToolConfirmationRequest, ToolConfirmationResult } from "../tools/types";
import type { StoreApi } from "zustand";

const ABORT_AND_WAIT_TIMEOUT_MS = 10000;

export interface RunningJob {
  readonly jobId: string;
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly abortController: AbortController;
  readonly promise: Promise<void>;
}

export interface SubmitAgentJobInput {
  readonly slug: string;
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly userMessage: string;
}

export interface SubscribeSessionEventsInput {
  readonly slug: string;
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly onEvent: (event: GlobalSSEEvent) => void;
}

interface AgentJobRunnerConfig {
  readonly sessionAgentManager: SessionAgentManager;
  readonly storeManager: SessionStoreManager;
  readonly requestPermission: (
    workspaceRoot: string,
    sessionId: string,
    request: ToolConfirmationRequest,
    abortSignal?: AbortSignal,
  ) => Promise<ToolConfirmationResult>;
  readonly requestQuestion: (
    workspaceRoot: string,
    sessionId: string,
    request: AskUserRequest,
  ) => Promise<AskUserResponse>;
  readonly cleanupDeferredSession: (workspaceRoot: string, sessionId: string) => void;
  readonly trackSession: (workspaceRoot: string, sessionId: string) => void;
  readonly untrackSession: (workspaceRoot: string, sessionId: string) => void;
}

interface SubscriptionRegistration extends SubscribeSessionEventsInput {
  lastForwardedNextEventId: number;
  unsubscribeStore?: () => void;
}

export class AgentJobRunner {
  readonly #jobs = new Map<string, RunningJob>();
  readonly #subscriptions = new Map<string, Set<SubscriptionRegistration>>();
  readonly #config: AgentJobRunnerConfig;

  constructor(config: AgentJobRunnerConfig) {
    this.#config = config;
  }

  submit(input: SubmitAgentJobInput): RunningJob {
    const key = scopedKey(input.workspaceRoot, input.sessionId);
    if (this.#jobs.has(key)) {
      throw new AgentRunningError();
    }

    this.#config.sessionAgentManager.acquireSlot(input.workspaceRoot, input.sessionId);
    this.#config.trackSession(input.workspaceRoot, input.sessionId);
    const abortController = new AbortController();
    const jobId = crypto.randomUUID();

    const promise = this.#runJob(input, abortController).finally(() => {
      this.#jobs.delete(key);
      this.#config.sessionAgentManager.releaseSlot(input.workspaceRoot, input.sessionId);
      this.#config.cleanupDeferredSession(input.workspaceRoot, input.sessionId);
    });

    const job: RunningJob = {
      jobId,
      sessionId: input.sessionId,
      workspaceRoot: input.workspaceRoot,
      abortController,
      promise,
    };
    this.#jobs.set(key, job);
    return job;
  }

  abort(workspaceRoot: string, sessionId: string): boolean {
    const job = this.#jobs.get(scopedKey(workspaceRoot, sessionId));
    if (!job) return false;

    job.abortController.abort();
    this.#jobs.delete(scopedKey(workspaceRoot, sessionId));
    return true;
  }

  async abortAndWait(workspaceRoot: string, sessionId: string): Promise<void> {
    const job = this.#jobs.get(scopedKey(workspaceRoot, sessionId));
    if (!job) return;

    job.abortController.abort();
    this.#jobs.delete(scopedKey(workspaceRoot, sessionId));
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, ABORT_AND_WAIT_TIMEOUT_MS));
    await Promise.race([job.promise.catch(() => {}), timeout]);
  }

  async abortAll(): Promise<void> {
    const jobs = [...this.#jobs.values()];
    for (const job of jobs) {
      job.abortController.abort();
      this.#jobs.delete(scopedKey(job.workspaceRoot, job.sessionId));
    }

    await Promise.allSettled(jobs.map((job) => job.promise));
  }

  isRunning(workspaceRoot: string, sessionId: string): boolean {
    return this.#jobs.has(scopedKey(workspaceRoot, sessionId));
  }

  getJob(workspaceRoot: string, sessionId: string): RunningJob | undefined {
    return this.#jobs.get(scopedKey(workspaceRoot, sessionId));
  }

  async dispatchCommand(
    workspaceRoot: string,
    sessionId: string,
    name: string,
    args?: string,
  ): Promise<CommandResult | null> {
    if (!this.isRunning(workspaceRoot, sessionId)) return null;
    return await this.#config.sessionAgentManager.dispatchCommand(workspaceRoot, sessionId, name, args);
  }

  subscribe(input: SubscribeSessionEventsInput): () => void {
    const key = scopedKey(input.workspaceRoot, input.sessionId);
    const registration: SubscriptionRegistration = {
      ...input,
      lastForwardedNextEventId: 0,
    };
    const registrations = this.#subscriptions.get(key) ?? new Set<SubscriptionRegistration>();
    registrations.add(registration);
    this.#subscriptions.set(key, registrations);

    const store = this.#config.storeManager.get(input.sessionId, input.workspaceRoot);
    if (store) this.#attachSubscription(registration, store);

    return () => {
      registration.unsubscribeStore?.();
      registrations.delete(registration);
      if (registrations.size === 0) this.#subscriptions.delete(key);
    };
  }

  async deleteSession(workspaceRoot: string, sessionId: string): Promise<void> {
    await this.abortAndWait(workspaceRoot, sessionId);
    this.#config.cleanupDeferredSession(workspaceRoot, sessionId);
    this.#config.sessionAgentManager.dispose(workspaceRoot, sessionId);
    this.#config.untrackSession(workspaceRoot, sessionId);
    this.#unsubscribeSession(workspaceRoot, sessionId);

    const path = join(getSessionsDir(workspaceRoot), `${sessionId}.json`);
    if (await Bun.file(path).exists()) {
      await rm(path);
    }
  }

  async #runJob(input: SubmitAgentJobInput, abortController: AbortController): Promise<void> {
    try {
      const agent = await this.#config.sessionAgentManager.getOrCreate(input.workspaceRoot, input.sessionId);
      this.#attachSubscriptionsForSession(input.workspaceRoot, input.sessionId, agent.store);
      if (abortController.signal.aborted) return;

      await agent.run(input.userMessage, {
        abort: abortController.signal,
        confirmPermission: (request, abortSignal) =>
          this.#config.requestPermission(input.workspaceRoot, input.sessionId, request, abortSignal),
        askUser: (request) => this.#config.requestQuestion(input.workspaceRoot, input.sessionId, request),
      });
    } catch (error) {
      if (!abortController.signal.aborted) {
        console.error(
          `[AgentJobRunner] Job for session "${input.sessionId}" failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  #attachSubscriptionsForSession(
    workspaceRoot: string,
    sessionId: string,
    store: StoreApi<SessionStoreState>,
  ): void {
    const registrations = this.#subscriptions.get(scopedKey(workspaceRoot, sessionId));
    if (!registrations) return;
    for (const registration of registrations) {
      this.#attachSubscription(registration, store);
    }
  }

  #attachSubscription(
    registration: SubscriptionRegistration,
    store: StoreApi<SessionStoreState>,
  ): void {
    registration.unsubscribeStore?.();
    registration.unsubscribeStore = store.subscribe((current) => this.#forwardCurrent(registration, current));
    this.#forwardCurrent(registration, store.getState());
  }

  #forwardCurrent(registration: SubscriptionRegistration, current: SessionStoreState): void {
    if (current.nextEventId <= registration.lastForwardedNextEventId) return;

    if (registration.lastForwardedNextEventId < current.eventOffset) {
      registration.lastForwardedNextEventId = current.nextEventId;
      registration.onEvent({
        type: "reset",
        slug: registration.slug,
        sessionId: registration.sessionId,
        reason: "lagged",
      });
      return;
    }

    const start = registration.lastForwardedNextEventId - current.eventOffset;
    const envelopes: SessionEventEnvelope[] = current.events.slice(start);
    registration.lastForwardedNextEventId = current.nextEventId;
    for (const envelope of envelopes) {
      const event: GlobalSessionEventEnvelope = {
        type: "event",
        slug: registration.slug,
        sessionId: registration.sessionId,
        eventId: envelope.id,
        createdAt: envelope.createdAt,
        kind: envelope.kind,
        payload: envelope.payload,
      };
      registration.onEvent(event);
    }
  }

  #unsubscribeSession(workspaceRoot: string, sessionId: string): void {
    const key = scopedKey(workspaceRoot, sessionId);
    const registrations = this.#subscriptions.get(key);
    if (!registrations) return;
    for (const registration of registrations) {
      registration.unsubscribeStore?.();
    }
    this.#subscriptions.delete(key);
  }
}
