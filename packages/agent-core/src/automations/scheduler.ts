import type { Automation, AutomationInvocation } from "@archcode/protocol";

import { AutomationCoordinator } from "./coordinator";
import { AutomationDispatcher, type AutomationChangeListener } from "./dispatcher";
import { AutomationStateManager, type CreateAutomationInput, type UpdateAutomationInput } from "./state-manager";

const MAX_TIMER_DELAY_MS = 2_147_000_000;
const PENDING_RECHECK_MS = 1_000;

export interface AutomationSchedulerClock {
  now(): number;
}

export interface AutomationSchedulerTimerHandle {
  readonly id?: unknown;
}

export interface AutomationSchedulerTimer {
  schedule(delayMs: number, callback: () => void | Promise<void>): AutomationSchedulerTimerHandle;
  cancel(handle: AutomationSchedulerTimerHandle): void;
}

export interface AutomationSchedulerOptions {
  readonly stateManager: AutomationStateManager;
  readonly dispatcher: AutomationDispatcher;
  readonly clock?: AutomationSchedulerClock;
  readonly timer?: AutomationSchedulerTimer;
  readonly onChange?: AutomationChangeListener;
}

export interface AutomationService {
  listAutomations(): Promise<Automation[]>;
  readAutomation(automationId: string): Promise<Automation>;
  createAutomation(input: CreateAutomationInput): Promise<Automation>;
  updateAutomation(automationId: string, input: UpdateAutomationInput): Promise<Automation>;
  deleteAutomation(automationId: string): Promise<void>;
  pauseAutomation(automationId: string): Promise<Automation>;
  resumeAutomation(automationId: string): Promise<Automation>;
  runAutomationNow(automationId: string): Promise<AutomationInvocation>;
  listAutomationInvocations(automationId: string, limit?: number): Promise<AutomationInvocation[]>;
}

const systemClock: AutomationSchedulerClock = { now: () => Date.now() };

const systemTimer: AutomationSchedulerTimer = {
  schedule(delayMs, callback) {
    const id = setTimeout(() => { void callback(); }, delayMs);
    if (typeof id === "object" && "unref" in id) id.unref();
    return { id };
  },
  cancel(handle) {
    if (handle.id !== undefined) clearTimeout(handle.id as Timer);
  },
};

/** Materializes schedules; Session execution remains owned by SessionDispatchGateway. */
export class AutomationScheduler implements AutomationService {
  readonly #stateManager: AutomationStateManager;
  readonly #dispatcher: AutomationDispatcher;
  readonly #clock: AutomationSchedulerClock;
  readonly #timer: AutomationSchedulerTimer;
  readonly #onChange: AutomationChangeListener | undefined;
  readonly #coordinator: AutomationCoordinator;
  #timerHandle: AutomationSchedulerTimerHandle | undefined;
  #started = false;
  #disposed = false;
  #ticking: Promise<void> | undefined;
  #lastError: unknown;

  constructor(options: AutomationSchedulerOptions) {
    this.#stateManager = options.stateManager;
    this.#dispatcher = options.dispatcher;
    this.#clock = options.clock ?? systemClock;
    this.#timer = options.timer ?? systemTimer;
    this.#onChange = options.onChange;
    this.#coordinator = options.dispatcher.coordinator;
  }

  get lastError(): unknown {
    return this.#lastError;
  }

  async start(): Promise<void> {
    if (this.#disposed) throw new Error("AutomationScheduler has been disposed");
    if (this.#started) return;
    await this.#stateManager.resetSchedulesAfterOffline(this.#clock.now());
    await this.#dispatcher.dispatchPending();
    this.#started = true;
    await this.#arm();
  }

  dispose(): void {
    this.#disposed = true;
    this.#started = false;
    if (this.#timerHandle) this.#timer.cancel(this.#timerHandle);
    this.#timerHandle = undefined;
  }

  async tick(): Promise<void> {
    if (this.#ticking) return this.#ticking;
    this.#ticking = this.#runTick().finally(() => { this.#ticking = undefined; });
    return this.#ticking;
  }

  listAutomations(): Promise<Automation[]> {
    return this.#stateManager.listAutomations();
  }

  readAutomation(automationId: string): Promise<Automation> {
    return this.#stateManager.readAutomation(automationId);
  }

  async createAutomation(input: CreateAutomationInput): Promise<Automation> {
    const automation = await this.#stateManager.createAutomation(input);
    this.#onChange?.({ automationId: automation.id });
    await this.#armIfStarted();
    return automation;
  }

  async updateAutomation(automationId: string, input: UpdateAutomationInput): Promise<Automation> {
    const mutate = () => this.#stateManager.updateAutomation(automationId, input);
    const automation = input.action !== undefined || input.trigger !== undefined
      ? await this.#dispatcher.reconcileAcceptedBeforeMutation(automationId, mutate)
      : await this.#coordinator.runExclusive(automationId, mutate);
    this.#onChange?.({ automationId: automation.id });
    await this.#armIfStarted();
    return automation;
  }

  async pauseAutomation(automationId: string): Promise<Automation> {
    const automation = await this.#dispatcher.reconcileAcceptedBeforeMutation(
      automationId,
      () => this.#stateManager.pauseAutomation(automationId),
    );
    this.#onChange?.({ automationId: automation.id });
    await this.#armIfStarted();
    return automation;
  }

  async resumeAutomation(automationId: string): Promise<Automation> {
    const automation = await this.#coordinator.runExclusive(
      automationId,
      () => this.#stateManager.resumeAutomation(automationId),
    );
    this.#onChange?.({ automationId: automation.id });
    await this.#armIfStarted();
    return automation;
  }

  async deleteAutomation(automationId: string): Promise<void> {
    await this.#coordinator.runExclusive(
      automationId,
      () => this.#stateManager.deleteAutomation(automationId),
    );
    this.#onChange?.({ automationId });
    await this.#armIfStarted();
  }

  async runAutomationNow(automationId: string): Promise<AutomationInvocation> {
    await this.#stateManager.readAutomation(automationId);
    const invocation = await this.#coordinator.runExclusive(
      automationId,
      () => this.#stateManager.enqueueInvocation(automationId, new Date(this.#clock.now()).toISOString()),
    );
    this.#onChange?.({ automationId });
    const result = await this.#dispatcher.dispatchInvocation(invocation.id);
    await this.#armIfStarted();
    return result;
  }

  listAutomationInvocations(automationId: string, limit?: number): Promise<AutomationInvocation[]> {
    return this.#stateManager.listInvocations(automationId, limit);
  }

  async #runTick(): Promise<void> {
    const now = this.#clock.now();
    for (const automation of await this.#stateManager.listAutomations()) {
      const dueAt = automation.nextFireAt;
      if (automation.status !== "active" || dueAt === undefined || Date.parse(dueAt) > now) continue;
      const invocation = await this.#coordinator.runExclusive(
        automation.id,
        () => this.#stateManager.advanceSchedule(automation.id, dueAt, now),
      );
      if (invocation !== undefined) {
        this.#onChange?.({ automationId: automation.id });
      }
    }
    await this.#dispatcher.dispatchPending();
    await this.#armIfStarted();
  }

  async #armIfStarted(): Promise<void> {
    if (this.#started && !this.#disposed) await this.#arm();
  }

  async #arm(): Promise<void> {
    if (this.#timerHandle) this.#timer.cancel(this.#timerHandle);
    this.#timerHandle = undefined;
    if (!this.#started || this.#disposed) return;

    const now = this.#clock.now();
    let nextAt: number | undefined;
    let hasPending = false;
    for (const automation of await this.#stateManager.listAutomations()) {
      if (automation.status === "active" && automation.nextFireAt !== undefined) {
        const candidate = Date.parse(automation.nextFireAt);
        nextAt = nextAt === undefined ? candidate : Math.min(nextAt, candidate);
      }
      if ((await this.#stateManager.listInvocations(automation.id)).some((item) => item.status === "pending")) hasPending = true;
    }
    let delay = nextAt === undefined ? undefined : Math.max(0, nextAt - now);
    if (hasPending) delay = delay === undefined ? PENDING_RECHECK_MS : Math.min(delay, PENDING_RECHECK_MS);
    if (delay === undefined) return;
    this.#timerHandle = this.#timer.schedule(Math.min(delay, MAX_TIMER_DELAY_MS), () => {
      void this.tick().catch((error) => { this.#lastError = error; });
    });
  }
}
