import type { Automation, AutomationAction, AutomationInvocation, AutomationTrigger } from "@archcode/protocol";
import { join } from "node:path";
import { z } from "zod/v4";

import { atomicWrite } from "../utils/safe-file";
import { nextFireAt, validateAutomationTrigger } from "./schedule";
import { AutomationCreateSchema, AutomationStateFileSchema, AutomationUpdateSchema, type AutomationStateFile } from "./schema";

export class AutomationNotFoundError extends Error {
  readonly code = "AUTOMATION_NOT_FOUND";

  constructor(public readonly automationId: string) {
    super(`Automation not found: ${automationId}`);
    this.name = "AutomationNotFoundError";
  }
}

export class AutomationInvocationNotFoundError extends Error {
  readonly code = "AUTOMATION_INVOCATION_NOT_FOUND";

  constructor(public readonly invocationId: string) {
    super(`Automation invocation not found: ${invocationId}`);
    this.name = "AutomationInvocationNotFoundError";
  }
}

export interface CreateAutomationInput {
  readonly projectId: string;
  readonly createdFromSessionId: string;
  readonly name: string;
  readonly trigger: AutomationTrigger;
  readonly action: AutomationAction;
}

export interface UpdateAutomationInput {
  readonly name?: string;
  readonly trigger?: AutomationTrigger;
  readonly action?: AutomationAction;
}

export interface AutomationStateManagerOptions {
  readonly now?: () => number;
}

export class AutomationStateManager {
  readonly workspaceRoot: string;
  readonly #filePath: string;
  readonly #now: () => number;
  #state: AutomationStateFile | undefined;
  #mutation: Promise<void> = Promise.resolve();

  constructor(workspaceRoot: string, options: AutomationStateManagerOptions = {}) {
    this.workspaceRoot = workspaceRoot;
    this.#filePath = join(workspaceRoot, ".archcode", "automations", "state.json");
    this.#now = options.now ?? Date.now;
  }

  async listAutomations(): Promise<Automation[]> {
    const state = await this.#read();
    return structuredClone(state.automations);
  }

  async readAutomation(automationId: string): Promise<Automation> {
    const state = await this.#read();
    const automation = state.automations.find((item) => item.id === automationId);
    if (!automation) throw new AutomationNotFoundError(automationId);
    return structuredClone(automation);
  }

  async createAutomation(input: CreateAutomationInput): Promise<Automation> {
    const validated = AutomationCreateSchema.parse({
      name: input.name,
      trigger: input.trigger,
      action: input.action,
    });
    return this.#mutate((state) => {
      const now = this.#now();
      const nowIso = new Date(now).toISOString();
      const trigger = validateAutomationTrigger(validated.trigger);
      const action = validated.action;
      const scheduledAt = nextFireAt(trigger, now);
      const automation: Automation = {
        id: crypto.randomUUID(),
        projectId: requireProjectId(input.projectId),
        createdFromSessionId: requireUuid(input.createdFromSessionId, "createdFromSessionId"),
        name: validated.name,
        trigger,
        action,
        status: scheduledAt === undefined && trigger.kind === "once" ? "disabled" : "active",
        createdAt: nowIso,
        updatedAt: nowIso,
        ...(scheduledAt === undefined ? {} : { nextFireAt: scheduledAt }),
      };
      state.automations.push(automation);
      if (automation.status === "disabled" && trigger.kind === "once") {
        state.invocations.push(this.#newInvocation(automation, trigger.at, "missed", nowIso));
      }
      return structuredClone(automation);
    });
  }

  async updateAutomation(automationId: string, input: UpdateAutomationInput): Promise<Automation> {
    const validated = AutomationUpdateSchema.parse(input);
    return this.#mutate((state) => {
      const automation = requiredAutomation(state, automationId);
      const now = this.#now();
      const invalidatesPending = validated.action !== undefined || validated.trigger !== undefined;
      if (validated.name !== undefined) automation.name = validated.name;
      if (validated.action !== undefined) automation.action = validated.action;
      if (validated.trigger !== undefined) automation.trigger = validateAutomationTrigger(validated.trigger);
      if (invalidatesPending) {
        const completedAt = new Date(now).toISOString();
        for (const invocation of state.invocations) {
          if (invocation.automationId === automationId && invocation.status === "pending") {
            invocation.status = "cancelled";
            invocation.completedAt = completedAt;
          }
        }
      }
      if (automation.status === "active" && validated.trigger !== undefined) {
        const scheduledAt = nextFireAt(automation.trigger, now);
        automation.nextFireAt = scheduledAt;
        if (scheduledAt === undefined && automation.trigger.kind === "once") {
          automation.status = "disabled";
          if (!hasMissedInvocation(state, automation.id, automation.trigger.at)) {
            state.invocations.push(this.#newInvocation(automation, automation.trigger.at, "missed", new Date(now).toISOString()));
          }
        }
      }
      automation.updatedAt = new Date(now).toISOString();
      return structuredClone(automation);
    });
  }

  async deleteAutomation(automationId: string): Promise<void> {
    await this.#mutate((state) => {
      requiredAutomation(state, automationId);
      state.automations = state.automations.filter((item) => item.id !== automationId);
      state.invocations = state.invocations.filter((item) => item.automationId !== automationId);
    });
  }

  async pauseAutomation(automationId: string): Promise<Automation> {
    return this.#mutate((state) => {
      const automation = requiredAutomation(state, automationId);
      const nowIso = new Date(this.#now()).toISOString();
      automation.status = "paused";
      automation.nextFireAt = undefined;
      automation.updatedAt = nowIso;
      for (const invocation of state.invocations) {
        if (invocation.automationId === automationId && invocation.status === "pending") {
          invocation.status = "cancelled";
          invocation.completedAt = nowIso;
        }
      }
      return structuredClone(automation);
    });
  }

  async resumeAutomation(automationId: string): Promise<Automation> {
    return this.#mutate((state) => {
      const automation = requiredAutomation(state, automationId);
      const now = this.#now();
      const nowIso = new Date(now).toISOString();
      const scheduledAt = nextFireAt(automation.trigger, now);
      automation.status = scheduledAt === undefined && automation.trigger.kind === "once" ? "disabled" : "active";
      automation.nextFireAt = scheduledAt;
      automation.updatedAt = nowIso;
      if (automation.status === "disabled" && automation.trigger.kind === "once") {
        if (!hasMissedInvocation(state, automation.id, automation.trigger.at)) {
          state.invocations.push(this.#newInvocation(automation, automation.trigger.at, "missed", nowIso));
        }
      }
      return structuredClone(automation);
    });
  }

  async enqueueInvocation(automationId: string, dueAt: string): Promise<AutomationInvocation> {
    return this.#mutate((state) => {
      const automation = requiredAutomation(state, automationId);
      const normalizedDueAt = normalizeIso(dueAt, "dueAt");
      const existing = state.invocations.find((item) => item.automationId === automationId && item.status === "pending");
      if (existing) {
        existing.dueAt = normalizedDueAt;
        return structuredClone(existing);
      }
      const invocation = this.#newInvocation(automation, normalizedDueAt, "pending", new Date(this.#now()).toISOString());
      state.invocations.push(invocation);
      return structuredClone(invocation);
    });
  }

  async readInvocation(invocationId: string): Promise<AutomationInvocation> {
    const state = await this.#read();
    const invocation = state.invocations.find((item) => item.id === invocationId);
    if (!invocation) throw new AutomationInvocationNotFoundError(invocationId);
    return structuredClone(invocation);
  }

  async listInvocations(automationId: string, limit?: number): Promise<AutomationInvocation[]> {
    const state = await this.#read();
    const matches = state.invocations.filter((item) => item.automationId === automationId);
    return structuredClone(limit === undefined ? matches : matches.slice(-limit));
  }

  async updateInvocation(invocationId: string, patch: Partial<Pick<AutomationInvocation, "status" | "dispatchedAt" | "completedAt" | "error">>): Promise<AutomationInvocation> {
    return this.#mutate((state) => {
      const invocation = state.invocations.find((item) => item.id === invocationId);
      if (!invocation) throw new AutomationInvocationNotFoundError(invocationId);
      Object.assign(invocation, patch);
      return structuredClone(invocation);
    });
  }

  async advanceSchedule(automationId: string, expectedDueAt: string, now = this.#now()): Promise<AutomationInvocation | undefined> {
    return this.#mutate((state) => {
      const automation = requiredAutomation(state, automationId);
      if (automation.status !== "active" || automation.nextFireAt !== expectedDueAt) return undefined;
      const invocation = this.#enqueueInState(state, automation, expectedDueAt);
      if (automation.trigger.kind === "once") {
        automation.status = "disabled";
        automation.nextFireAt = undefined;
      } else {
        automation.nextFireAt = nextFireAt(automation.trigger, now);
      }
      automation.updatedAt = new Date(now).toISOString();
      return structuredClone(invocation);
    });
  }

  async resetSchedulesAfterOffline(now = this.#now()): Promise<void> {
    await this.#mutate((state) => {
      const nowIso = new Date(now).toISOString();
      for (const automation of state.automations) {
        if (automation.status !== "active") continue;
        if (automation.trigger.kind === "once") {
          if (Date.parse(automation.trigger.at) <= now) {
            const alreadyRecorded = hasMissedInvocation(state, automation.id, automation.trigger.at);
            if (!alreadyRecorded) state.invocations.push(this.#newInvocation(automation, automation.trigger.at, "missed", nowIso));
            automation.status = "disabled";
            automation.nextFireAt = undefined;
          } else automation.nextFireAt = normalizeIso(automation.trigger.at, "at");
        } else {
          automation.nextFireAt = nextFireAt(automation.trigger, now);
        }
        automation.updatedAt = nowIso;
      }
    });
  }

  #newInvocation(automation: Automation, dueAt: string, status: AutomationInvocation["status"], createdAt: string): AutomationInvocation {
    return {
      id: crypto.randomUUID(),
      automationId: automation.id,
      dueAt: normalizeIso(dueAt, "dueAt"),
      status,
      executionId: crypto.randomUUID(),
      sessionId: automation.action.kind === "start_session" ? crypto.randomUUID() : automation.action.sessionId,
      createdAt,
      ...(status === "missed" ? { completedAt: createdAt } : {}),
    };
  }

  #enqueueInState(state: AutomationStateFile, automation: Automation, dueAt: string): AutomationInvocation {
    const existing = state.invocations.find((item) => item.automationId === automation.id && item.status === "pending");
    if (existing) {
      existing.dueAt = dueAt;
      return existing;
    }
    const invocation = this.#newInvocation(automation, dueAt, "pending", new Date(this.#now()).toISOString());
    state.invocations.push(invocation);
    return invocation;
  }

  async #read(): Promise<AutomationStateFile> {
    await this.#mutation;
    return this.#load();
  }

  async #load(): Promise<AutomationStateFile> {
    if (this.#state) return this.#state;
    const file = Bun.file(this.#filePath);
    if (!(await file.exists())) {
      this.#state = { version: 2, automations: [], invocations: [] };
      return this.#state;
    }
    this.#state = AutomationStateFileSchema.parse(await file.json());
    return this.#state;
  }

  #mutate<T>(mutation: (state: AutomationStateFile) => T | Promise<T>): Promise<T> {
    const operation = this.#mutation.then(async () => {
      const state = structuredClone(await this.#load());
      const result = await mutation(state);
      const parsed = AutomationStateFileSchema.parse(state);
      await atomicWrite(this.#filePath, `${JSON.stringify(parsed, null, 2)}\n`);
      this.#state = parsed;
      return result;
    });
    this.#mutation = operation.then(() => undefined, () => undefined);
    return operation;
  }
}

function requiredAutomation(state: AutomationStateFile, automationId: string): Automation {
  const automation = state.automations.find((item) => item.id === automationId);
  if (!automation) throw new AutomationNotFoundError(automationId);
  return automation;
}

function hasMissedInvocation(state: AutomationStateFile, automationId: string, dueAt: string): boolean {
  const normalizedDueAt = normalizeIso(dueAt, "dueAt");
  return state.invocations.some((item) => (
    item.automationId === automationId
    && item.status === "missed"
    && item.dueAt === normalizedDueAt
  ));
}

function requireProjectId(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error("projectId must not be empty");
  return trimmed;
}

function requireUuid(value: string, field: string): string {
  const parsed = z.uuid().safeParse(value);
  if (!parsed.success) throw new Error(`${field} must be a UUID`);
  return parsed.data;
}

function normalizeIso(value: string, field: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`${field} must be an ISO datetime`);
  return new Date(timestamp).toISOString();
}
