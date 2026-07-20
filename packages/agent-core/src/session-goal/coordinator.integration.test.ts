import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChildResult, SessionGoalReviewReceipt } from "@archcode/protocol";
import type { ChildExecutionHandle } from "../delegation/types";
import type { SessionExecutionManager } from "../execution/session-execution-manager";
import { silentLogger } from "../logger";
import type { ModelRuntime } from "../models";
import type { ModelSelectionResolver } from "../models/model-selection-resolver";
import { SessionStoreManager } from "../store/session-store-manager";
import { testExecutionRecord, testExecutionStart } from "../testing/test-execution-fixtures";
import { SessionGoalCoordinator } from "./coordinator";
import { GoalReviewGate } from "./review-gate";
import { SessionGoalService } from "./service";
import { setSessionGoalReviewWatchFactoryForTest } from "./review-source-monitor";
import { setLlmAdapterForTest } from "../llm/adapter";
import type { ExecutionModelBinding } from "../models";

const root = join(import.meta.dir, "__test_tmp__", crypto.randomUUID());
const stores = new SessionStoreManager({ logger: silentLogger });
const service = new SessionGoalService(stores);
const coordinators: SessionGoalCoordinator[] = [];

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

beforeEach(() => {
  setSessionGoalReviewWatchFactoryForTest(() => new FakeReviewWatch());
});

afterEach(async () => {
  setSessionGoalReviewWatchFactoryForTest(undefined);
  setLlmAdapterForTest(undefined);
  await Promise.all(coordinators.splice(0).map((coordinator) => coordinator.dispose()));
  stores.clearAll();
  await rm(root, { recursive: true, force: true });
});

describe("SessionGoalCoordinator", () => {
  test("serializes concurrent idle notifications and starts one requested Reviewer", async () => {
    const sessionId = await rootGoal();
    const created = await service.get({ workspaceRoot: root, sessionId });
    const basis = await new GoalReviewGate().createBasis(root, created!);
    await service.requestReview({
      workspaceRoot: root,
      sessionId,
      authority: { kind: "agent" },
      requestedBy: "engineer",
      reason: "ready",
      reviewContract: basis.contract,
      reviewContractHash: basis.contractHash,
      userInputCursor: 0,
      sourceMutationEpoch: 0,
      sourceFingerprint: basis.sourceFingerprint,
    });
    const launches: unknown[] = [];
    const executionManager = fakeExecutionManager({
      startRuntimeReviewChild: mock(async (_workspaceRoot: string, request: unknown) => {
        launches.push(request);
        return {} as ChildExecutionHandle;
      }),
    });
    const coordinator = makeCoordinator(executionManager);
    const input = { workspaceRoot: root, projectSlug: "project", rootSessionId: sessionId };

    await Promise.all([coordinator.reconcile(input), coordinator.reconcile(input), coordinator.reconcile(input)]);

    expect(launches).toHaveLength(1);
    const goal = await service.get({ workspaceRoot: root, sessionId });
    expect(goal?.review).toMatchObject({ phase: "review_running", attempt: 1 });
    expect(coordinator.activeReviewMonitorCount).toBe(1);

    await service.recordReviewSourceMutation({
      workspaceRoot: root,
      sessionId,
      authority: { kind: "runtime" },
      claimId: goal!.review!.claim.claimId,
    });
    await service.pause({ workspaceRoot: root, sessionId, authority: { kind: "user_control" } });
    await coordinator.reconcile(input);
    expect(coordinator.activeReviewMonitorCount).toBe(0);
  });

  test("replays a failed Reviewer launch after persisting its claim", async () => {
    const sessionId = await rootGoal();
    await requestReview(sessionId);
    let launches = 0;
    const coordinator = makeCoordinator(fakeExecutionManager({
      startRuntimeReviewChild: mock(async () => {
        launches += 1;
        if (launches === 1) throw new Error("injected Reviewer launch failure");
        return {} as ChildExecutionHandle;
      }),
    }));
    const input = { workspaceRoot: root, projectSlug: "project", rootSessionId: sessionId };

    await expect(coordinator.reconcile(input)).rejects.toThrow("injected Reviewer launch failure");
    expect(await service.get({ workspaceRoot: root, sessionId })).toMatchObject({
      status: "active",
      failureCount: 1,
      review: { phase: "review_running", attempt: 1 },
    });

    await waitFor(() => launches === 2);
    expect(await service.get({ workspaceRoot: root, sessionId })).toMatchObject({
      status: "active",
      failureCount: 1,
      review: { phase: "review_running", attempt: 2 },
    });
  });

  test("records a recoverable failure when prelaunch source monitoring invalidates its claim", async () => {
    const sessionId = await rootGoal();
    await mkdir(join(root, "blocked"), { recursive: true });
    await writeFile(join(root, "blocked", "file.ts"), "export {};\n");
    await git(["init"]);
    await git(["add", "source.ts", "blocked/file.ts"]);
    await requestReview(sessionId);
    await rm(join(root, "blocked"), { recursive: true, force: true });
    await writeFile(join(root, "blocked"), "not a directory\n");

    const startReview = mock(async () => ({} as ChildExecutionHandle));
    const coordinator = makeCoordinator(fakeExecutionManager({ startRuntimeReviewChild: startReview }));
    const input = { workspaceRoot: root, projectSlug: "project", rootSessionId: sessionId };

    await expect(coordinator.reconcile(input)).rejects.toThrow("source monitor invalidated");
    expect(startReview).not.toHaveBeenCalled();
    expect(coordinator.activeReviewMonitorCount).toBe(0);
    expect(await service.get({ workspaceRoot: root, sessionId })).toMatchObject({
      status: "active",
      failureCount: 1,
      review: undefined,
    });
    await coordinator.dispose();
  });

  test("does not launch a Reviewer or leak a monitor when watch allocation fails", async () => {
    const sessionId = await rootGoal();
    await requestReview(sessionId);
    setSessionGoalReviewWatchFactoryForTest(() => {
      throw new Error("watch unavailable");
    });
    const startReview = mock(async () => ({} as ChildExecutionHandle));
    const coordinator = makeCoordinator(fakeExecutionManager({ startRuntimeReviewChild: startReview }));

    await expect(coordinator.reconcile({
      workspaceRoot: root,
      projectSlug: "project",
      rootSessionId: sessionId,
    })).rejects.toThrow("source monitor invalidated");

    expect(startReview).not.toHaveBeenCalled();
    expect(coordinator.activeReviewMonitorCount).toBe(0);
    expect((await service.get({ workspaceRoot: root, sessionId }))?.failureCount).toBe(1);
  });

  test("keeps one monitor across HITL execution rebind and rebuilds it after restart", async () => {
    const sessionId = await rootGoal();
    await requestReview(sessionId);
    const executionManager = fakeExecutionManager({
      startRuntimeReviewChild: mock(async () => ({} as ChildExecutionHandle)),
    });
    const input = { workspaceRoot: root, projectSlug: "project", rootSessionId: sessionId };
    const coordinator = makeCoordinator(executionManager);
    await coordinator.reconcile(input);
    const running = await service.get({ workspaceRoot: root, sessionId });
    const review = running!.review!;
    expect(coordinator.activeReviewMonitorCount).toBe(1);

    const resumedExecutionId = crypto.randomUUID();
    await service.continueReviewAttempt({
      workspaceRoot: root,
      sessionId,
      authority: { kind: "runtime" },
      claimId: review.claim.claimId,
      reviewerSessionId: review.reviewerSessionId!,
      reviewerExecutionId: resumedExecutionId,
    });
    expect(await coordinator.ensureReviewMonitor({
      ...input,
      claimId: review.claim.claimId,
      reviewerSessionId: review.reviewerSessionId!,
      reviewerExecutionId: resumedExecutionId,
    })).toBe(true);
    expect(coordinator.activeReviewMonitorCount).toBe(1);

    await coordinator.dispose();
    expect(coordinator.activeReviewMonitorCount).toBe(0);
    const recovered = makeCoordinator(executionManager);
    expect(await recovered.ensureReviewMonitor({
      ...input,
      claimId: review.claim.claimId,
      reviewerSessionId: review.reviewerSessionId!,
      reviewerExecutionId: resumedExecutionId,
    })).toBe(true);
    expect(recovered.activeReviewMonitorCount).toBe(1);

    await service.recordReviewSourceMutation({
      workspaceRoot: root,
      sessionId,
      authority: { kind: "runtime" },
      claimId: review.claim.claimId,
    });
    await service.pause({ workspaceRoot: root, sessionId, authority: { kind: "user_control" } });
    await recovered.reconcile(input);
    expect(recovered.activeReviewMonitorCount).toBe(0);
  });

  test("joins concurrent failed idle notifications and schedules one replay", async () => {
    const sessionId = await rootGoal();
    await requestReview(sessionId);
    let launches = 0;
    const coordinator = makeCoordinator(fakeExecutionManager({
      startRuntimeReviewChild: mock(async () => {
        launches += 1;
        if (launches === 1) throw new Error("injected shared launch failure");
        return {} as ChildExecutionHandle;
      }),
    }));
    const input = { workspaceRoot: root, projectSlug: "project", rootSessionId: sessionId };

    const outcomes = await Promise.allSettled([
      coordinator.reconcile(input),
      coordinator.reconcile(input),
      coordinator.reconcile(input),
    ]);

    expect(outcomes.map((outcome) => outcome.status)).toEqual(["rejected", "rejected", "rejected"]);
    expect((await service.get({ workspaceRoot: root, sessionId }))?.failureCount).toBe(1);
    await waitFor(() => launches === 2);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(launches).toBe(2);
    expect((await service.get({ workspaceRoot: root, sessionId }))?.failureCount).toBe(1);
  });

  test("dispatches queued user input before a persisted review action", async () => {
    const sessionId = await rootGoal();
    const created = await service.get({ workspaceRoot: root, sessionId });
    const basis = await new GoalReviewGate().createBasis(root, created!);
    await service.requestReview({
      workspaceRoot: root,
      sessionId,
      authority: { kind: "agent" },
      requestedBy: "engineer",
      reason: "ready",
      reviewContract: basis.contract,
      reviewContractHash: basis.contractHash,
      userInputCursor: 0,
      sourceMutationEpoch: 0,
      sourceFingerprint: basis.sourceFingerprint,
    });
    const startReview = mock(async () => ({} as ChildExecutionHandle));
    const coordinator = makeCoordinator(fakeExecutionManager({
      tryStartQueuedExecution: mock(async () => ({ executionId: "queued" })),
      startRuntimeReviewChild: startReview,
    }));

    await coordinator.reconcile({ workspaceRoot: root, projectSlug: "project", rootSessionId: sessionId });

    expect(startReview).not.toHaveBeenCalled();
    expect((await service.get({ workspaceRoot: root, sessionId }))?.review?.phase).toBe("requested");
  });

  test("replaces a missing interrupted Reviewer with exactly one new attempt", async () => {
    const sessionId = await rootGoal();
    const created = await service.get({ workspaceRoot: root, sessionId });
    const basis = await new GoalReviewGate().createBasis(root, created!);
    const requested = await service.requestReview({
      workspaceRoot: root,
      sessionId,
      authority: { kind: "agent" },
      requestedBy: "engineer",
      reason: "ready",
      reviewContract: basis.contract,
      reviewContractHash: basis.contractHash,
      userInputCursor: 0,
      sourceMutationEpoch: 0,
      sourceFingerprint: basis.sourceFingerprint,
    });
    const claimId = requested.review!.claim.claimId;
    await service.markReviewRunning({
      workspaceRoot: root,
      sessionId,
      authority: { kind: "runtime" },
      claimId,
      reviewerSessionId: crypto.randomUUID(),
      reviewerExecutionId: crypto.randomUUID(),
    });
    const launches: unknown[] = [];
    const coordinator = makeCoordinator(fakeExecutionManager({
      startRuntimeReviewChild: mock(async (_workspaceRoot: string, request: unknown) => {
        launches.push(request);
        return {} as ChildExecutionHandle;
      }),
    }));
    const input = { workspaceRoot: root, projectSlug: "project", rootSessionId: sessionId };

    await Promise.all([coordinator.reconcile(input), coordinator.reconcile(input)]);

    expect(launches).toHaveLength(1);
    expect(await service.get({ workspaceRoot: root, sessionId })).toMatchObject({
      status: "active",
      review: {
        phase: "review_running",
        attempt: 2,
        claim: { claimId },
      },
    });
  });

  test("replays a failed remediation launch with the same persisted Execution id", async () => {
    const sessionId = await rootGoal();
    const remediation = await rejectedReview(sessionId);
    const executionIds: string[] = [];
    const coordinator = makeCoordinator(fakeExecutionManager({
      startCheckedExecution: mock(async (request: { executionId?: string }) => {
        executionIds.push(request.executionId!);
        if (executionIds.length === 1) throw new Error("injected remediation launch failure");
        return { executionId: request.executionId };
      }),
    }));
    const input = { workspaceRoot: root, projectSlug: "project", rootSessionId: sessionId };

    await expect(coordinator.reconcile(input)).rejects.toThrow("injected remediation launch failure");
    const failed = await service.get({ workspaceRoot: root, sessionId });
    expect(failed).toMatchObject({
      status: "active",
      failureCount: 1,
      review: { phase: "remediation_running", claim: { claimId: remediation.claimId } },
    });
    expect(failed?.review?.remediationExecutionId).toBeString();

    await waitFor(() => executionIds.length === 2);
    expect(executionIds[1]).toBe(executionIds[0]);
    expect((await service.get({ workspaceRoot: root, sessionId }))?.review).toMatchObject({
      phase: "remediation_running",
      remediationExecutionId: executionIds[0],
    });
  });

  test("restarts a failed remediation only after its durable backoff and never marks it finished", async () => {
    const sessionId = await rootGoal();
    const { claimId } = await rejectedReview(sessionId);
    const failedExecutionId = crypto.randomUUID();
    await service.markRemediationRunning({
      workspaceRoot: root,
      sessionId,
      authority: { kind: "runtime" },
      claimId,
      executionId: failedExecutionId,
    });
    const store = await stores.getOrLoad(sessionId, root);
    store.setState({ executions: [testExecutionRecord(failedExecutionId, "failed")] });
    const failedUsage = await service.recordUsage({
      workspaceRoot: root,
      sessionId,
      authority: { kind: "runtime" },
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, reasoningTokens: 0, cachedInputTokens: 0 },
      executionTimeMs: 1,
      outcome: "failed",
    });
    const launches: string[] = [];
    const coordinator = makeCoordinator(fakeExecutionManager({
      startCheckedExecution: mock(async (request: { executionId?: string }) => {
        launches.push(request.executionId!);
        return { executionId: request.executionId };
      }),
    }));

    await coordinator.reconcile({ workspaceRoot: root, projectSlug: "project", rootSessionId: sessionId });
    expect(launches).toEqual([]);
    expect((await service.get({ workspaceRoot: root, sessionId }))?.review).toMatchObject({
      phase: "remediation_running",
      remediationExecutionId: failedExecutionId,
    });

    await waitFor(() => launches.length === 1);
    expect(launches[0]).not.toBe(failedExecutionId);
    expect(await service.get({ workspaceRoot: root, sessionId })).toMatchObject({
      status: "active",
      failureCount: 1,
      nextRetryAt: failedUsage.nextRetryAt,
      review: { phase: "remediation_running", remediationExecutionId: launches[0] },
    });
  });

  test("treats waiting remediation without durable HITL as orphaned and starts a fresh Execution", async () => {
    const sessionId = await rootGoal();
    const { claimId } = await rejectedReview(sessionId);
    const orphanedExecutionId = crypto.randomUUID();
    await service.markRemediationRunning({
      workspaceRoot: root,
      sessionId,
      authority: { kind: "runtime" },
      claimId,
      executionId: orphanedExecutionId,
    });
    const store = await stores.getOrLoad(sessionId, root);
    store.setState({ executions: [testExecutionRecord(orphanedExecutionId, "waiting_for_human")] });
    const launches: string[] = [];
    const coordinator = makeCoordinator(fakeExecutionManager({
      startCheckedExecution: mock(async (request: { executionId?: string }) => {
        launches.push(request.executionId!);
        return { executionId: request.executionId };
      }),
    }));

    await coordinator.reconcile({ workspaceRoot: root, projectSlug: "project", rootSessionId: sessionId });
    expect(await service.get({ workspaceRoot: root, sessionId })).toMatchObject({
      failureCount: 1,
      review: { phase: "remediation_required" },
    });
    await waitFor(() => launches.length === 1);
    expect(launches[0]).not.toBe(orphanedExecutionId);
  });

  test("repairs persisted running remediation and starts exactly one replacement after restart", async () => {
    const sessionId = await rootGoal();
    const { claimId } = await rejectedReview(sessionId);
    const interruptedExecutionId = crypto.randomUUID();
    await service.markRemediationRunning({
      workspaceRoot: root,
      sessionId,
      authority: { kind: "runtime" },
      claimId,
      executionId: interruptedExecutionId,
    });
    const beforeRestart = await stores.getOrLoad(sessionId, root);
    beforeRestart.getState().append(testExecutionStart(interruptedExecutionId, "goal_remediation"));
    await stores.flushSession(sessionId, root);
    stores.clearAll();
    const repaired = await stores.getOrLoad(sessionId, root);
    expect(repaired.getState().executions).toEqual([
      expect.objectContaining({ id: interruptedExecutionId, status: "interrupted" }),
    ]);
    const launches: string[] = [];
    const coordinator = makeCoordinator(fakeExecutionManager({
      startCheckedExecution: mock(async (request: { executionId?: string }) => {
        launches.push(request.executionId!);
        return { executionId: request.executionId };
      }),
    }));
    const input = { workspaceRoot: root, projectSlug: "project", rootSessionId: sessionId };

    await Promise.all([coordinator.reconcile(input), coordinator.reconcile(input)]);
    await waitFor(() => launches.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(launches).toHaveLength(1);
    expect(launches[0]).not.toBe(interruptedExecutionId);
  });

  test("fresh-restarts a Reviewer waiting without a durable HITL batch", async () => {
    const sessionId = await rootGoal();
    await requestReview(sessionId);
    const requested = await service.get({ workspaceRoot: root, sessionId });
    const claimId = requested!.review!.claim.claimId;
    const reviewerSessionId = crypto.randomUUID();
    const reviewerExecutionId = crypto.randomUUID();
    await service.markReviewRunning({
      workspaceRoot: root,
      sessionId,
      authority: { kind: "runtime" },
      claimId,
      reviewerSessionId,
      reviewerExecutionId,
    });
    await stores.createSessionFile(root, {
      agentName: "reviewer",
      cwd: root,
      rootSessionId: sessionId,
      parentSessionId: sessionId,
    }, reviewerSessionId);
    const child = await stores.getOrLoad(reviewerSessionId, root);
    child.setState({ executions: [testExecutionRecord(reviewerExecutionId, "waiting_for_human")] });
    const launches: unknown[] = [];
    const coordinator = makeCoordinator(fakeExecutionManager({
      startRuntimeReviewChild: mock(async (_workspaceRoot: string, request: unknown) => {
        launches.push(request);
        return {} as ChildExecutionHandle;
      }),
    }));

    await coordinator.reconcile({ workspaceRoot: root, projectSlug: "project", rootSessionId: sessionId });

    expect(launches).toHaveLength(1);
    expect(await service.get({ workspaceRoot: root, sessionId })).toMatchObject({
      review: { phase: "review_running", attempt: 2 },
    });
  });

  test("does not complete a review across a pending user-input mutation and dispatches one successor", async () => {
    const sessionId = await rootGoal();
    await requestReview(sessionId);
    const requested = await service.get({ workspaceRoot: root, sessionId });
    const claimId = requested!.review!.claim.claimId;
    const reviewerSessionId = crypto.randomUUID();
    const reviewerExecutionId = crypto.randomUUID();
    await service.markReviewRunning({
      workspaceRoot: root,
      sessionId,
      authority: { kind: "runtime" },
      claimId,
      reviewerSessionId,
      reviewerExecutionId,
    });
    await stores.createSessionFile(root, {
      agentName: "reviewer",
      cwd: root,
      rootSessionId: sessionId,
      parentSessionId: sessionId,
    }, reviewerSessionId);
    const reviewer = await stores.getOrLoad(reviewerSessionId, root);
    reviewer.setState({ executions: [testExecutionRecord(reviewerExecutionId, "completed")] });

    const inputMutationEntered = deferred<void>();
    let userQueued = false;
    let successorStarts = 0;
    const queueStarts = mock(async () => {
      if (!userQueued) return undefined;
      successorStarts += 1;
      return { executionId: "user-successor" };
    });
    let inputMutationPending = true;
    const coordinator = makeCoordinator(fakeExecutionManager({
      tryRunSessionFamilyControl: mock(async () => {
        inputMutationEntered.resolve(undefined);
        return inputMutationPending
          ? { kind: "blocked" as const }
          : { kind: "executed" as const, result: { kind: "stale" as const } };
      }),
      tryStartQueuedExecution: queueStarts,
    }));
    const input = { workspaceRoot: root, projectSlug: "project", rootSessionId: sessionId };

    const settling = coordinator.reconcile(input);
    await inputMutationEntered.promise;
    await settling;
    expect((await service.get({ workspaceRoot: root, sessionId }))?.status).toBe("active");
    expect((await service.get({ workspaceRoot: root, sessionId }))?.review?.claim.claimId).toBe(claimId);

    // This is the durable user-message commit performed before the mutation
    // releases. It invalidates the claim; the release wake may only launch
    // the user's one queued successor, never complete the old review.
    await service.advanceUserInputCursor({ workspaceRoot: root, sessionId, authority: { kind: "runtime" } });
    inputMutationPending = false;
    userQueued = true;
    await coordinator.reconcile(input);

    expect(await service.get({ workspaceRoot: root, sessionId })).toMatchObject({ status: "active", review: undefined });
    expect(successorStarts).toBe(1);
  });

  test("replays a failed ordinary Goal continuation instead of leaving the Session idle", async () => {
    const sessionId = await rootGoal();
    const binding = evaluatorBinding();
    setContinueEvaluatorAdapter();
    let launches = 0;
    const coordinator = makeCoordinator(fakeExecutionManager({
      runSessionCommand: executeSessionCommand(binding),
      startCheckedExecution: mock(async () => {
        launches += 1;
        if (launches === 1) throw new Error("injected continuation launch failure");
        return { executionId: crypto.randomUUID() };
      }),
    }), {
      modelRuntime: evaluatorModelRuntime(),
      modelSelectionResolver: { resolve: () => binding } as unknown as ModelSelectionResolver,
    });
    const input = { workspaceRoot: root, projectSlug: "project", rootSessionId: sessionId };

    await expect(coordinator.reconcile(input)).rejects.toThrow("injected continuation launch failure");
    expect(await service.get({ workspaceRoot: root, sessionId })).toMatchObject({
      status: "active",
      failureCount: 1,
      evaluatorCount: 1,
    });

    await waitFor(() => launches === 2);
    expect(await service.get({ workspaceRoot: root, sessionId })).toMatchObject({
      status: "active",
      failureCount: 1,
      evaluatorCount: 2,
    });
  });

  test("blocks after three failed Evaluator admissions without scheduling another replay", async () => {
    const sessionId = await rootGoal();
    let attempts = 0;
    const coordinator = makeCoordinator(fakeExecutionManager({
      runSessionCommand: mock(async () => {
        attempts += 1;
        throw new Error("injected Evaluator admission failure");
      }),
    }), { modelRuntime: evaluatorModelRuntime() });
    const input = { workspaceRoot: root, projectSlug: "project", rootSessionId: sessionId };

    await expect(coordinator.reconcile(input)).rejects.toThrow("injected Evaluator admission failure");
    await waitFor(async () => (await service.get({ workspaceRoot: root, sessionId }))?.status === "blocked", 2_000);
    expect(await service.get({ workspaceRoot: root, sessionId })).toMatchObject({
      status: "blocked",
      failureCount: 3,
      blockedReason: "Goal runtime orchestration failed",
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(attempts).toBe(3);
  });

  test("holds Session family admission for the Evaluator and rechecks Queue after release", async () => {
    const sessionId = await rootGoal();
    let commandActive = false;
    const queueChecks: boolean[] = [];
    const binding = {
      modelInfo: { model: {}, redactSensitiveText: (text: string) => text },
      options: undefined,
    } as unknown as ExecutionModelBinding;
    setLlmAdapterForTest({
      generateText: mock(async () => ({
        text: "",
        toolCalls: [{
          toolName: "goal_evaluation",
          input: { decision: "continue", reason: "More work remains", madeProgress: true },
        }],
        usage: { inputTokens: 2, outputTokens: 1 },
      })) as never,
    });
    const executionManager = fakeExecutionManager({
      runSessionCommand: async (_input: unknown, execute: (binding: ExecutionModelBinding, signal: AbortSignal) => Promise<unknown>) => {
        commandActive = true;
        try {
          return { kind: "executed", result: await execute(binding, new AbortController().signal) };
        } finally {
          commandActive = false;
        }
      },
      tryStartQueuedExecution: async () => {
        queueChecks.push(commandActive);
        return queueChecks.length === 1 ? undefined : { executionId: "queued-user-input" };
      },
    });
    const coordinator = makeCoordinator(executionManager, {
      modelRuntime: { current: { getAgentDefault: () => ({ model: "test:model" }) } } as unknown as ModelRuntime,
      modelSelectionResolver: { resolve: () => binding } as unknown as ModelSelectionResolver,
    });

    await coordinator.reconcile({ workspaceRoot: root, projectSlug: "project", rootSessionId: sessionId });

    expect(queueChecks).toEqual([false, false]);
    expect(await service.get({ workspaceRoot: root, sessionId })).toMatchObject({
      lastEvaluator: { reason: "More work remains" },
      usage: {
        tokens: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
        executionCount: 1,
      },
    });
  });
});

async function rootGoal(): Promise<string> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "source.ts"), "export const ready = true;\n");
  const sessionId = crypto.randomUUID();
  await stores.createSessionFile(root, { agentName: "engineer", cwd: root }, sessionId);
  await service.create({
    workspaceRoot: root,
    sessionId,
    authority: { kind: "user_control" },
    objective: "Implement and independently verify the complete result.",
  });
  return sessionId;
}

async function requestReview(sessionId: string): Promise<void> {
  const created = await service.get({ workspaceRoot: root, sessionId });
  const basis = await new GoalReviewGate().createBasis(root, created!);
  await service.requestReview({
    workspaceRoot: root,
    sessionId,
    authority: { kind: "agent" },
    requestedBy: "engineer",
    reason: "ready",
    reviewContract: basis.contract,
    reviewContractHash: basis.contractHash,
    userInputCursor: 0,
    sourceMutationEpoch: 0,
    sourceFingerprint: basis.sourceFingerprint,
  });
}

async function git(args: readonly string[]): Promise<void> {
  const child = Bun.spawn(["git", "-C", root, ...args], { stderr: "pipe" });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(await new Response(child.stderr).text());
}

async function rejectedReview(sessionId: string): Promise<{ claimId: string }> {
  await requestReview(sessionId);
  const requested = await service.get({ workspaceRoot: root, sessionId });
  const claim = requested!.review!.claim;
  const reviewerSessionId = crypto.randomUUID();
  const reviewerExecutionId = crypto.randomUUID();
  const running = await service.markReviewRunning({
    workspaceRoot: root,
    sessionId,
    authority: { kind: "runtime" },
    claimId: claim.claimId,
    reviewerSessionId,
    reviewerExecutionId,
  });
  const receipt: SessionGoalReviewReceipt = {
    claimId: claim.claimId,
    attempt: running.review!.attempt,
    reviewerSessionId,
    reviewerExecutionId,
    verdict: "rejected",
    summary: "Verification failed",
    result: rejectedResult(),
    decidedAt: Date.now(),
  };
  await service.rejectReview({
    workspaceRoot: root,
    sessionId,
    authority: { kind: "runtime" },
    claimId: claim.claimId,
    receipt,
  });
  return { claimId: claim.claimId };
}

function rejectedResult(): ChildResult {
  return {
    status: "failed",
    summary: "The objective is not yet satisfied",
    deliverables: [],
    evidence: [],
    criteria: [{ id: "runtime-objective", status: "failed", evidenceRefs: [] }],
    verification: [{ check: "independent review", status: "failed" }],
    unresolved: [{ issue: "Required behavior is missing", blocking: true, nextOwner: "parent" }],
  };
}

function evaluatorBinding(): ExecutionModelBinding {
  return {
    modelInfo: { model: {}, redactSensitiveText: (text: string) => text },
    options: undefined,
  } as unknown as ExecutionModelBinding;
}

function evaluatorModelRuntime(): ModelRuntime {
  return { current: { getAgentDefault: () => ({ model: "test:model" }) } } as unknown as ModelRuntime;
}

function executeSessionCommand(binding: ExecutionModelBinding) {
  return async (_input: unknown, execute: (binding: ExecutionModelBinding, signal: AbortSignal) => Promise<unknown>) => ({
    kind: "executed" as const,
    result: await execute(binding, new AbortController().signal),
  });
}

function setContinueEvaluatorAdapter(): void {
  setLlmAdapterForTest({
    generateText: mock(async () => ({
      text: "",
      toolCalls: [{
        toolName: "goal_evaluation",
        input: { decision: "continue", reason: "More work remains", madeProgress: true },
      }],
      usage: { inputTokens: 2, outputTokens: 1 },
    })) as never,
  });
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 1_500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(`Condition was not met within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function fakeExecutionManager(overrides: Record<string, unknown> = {}): SessionExecutionManager {
  return {
    getSessionFamilyActivity: () => "idle",
    listSessionFamilyToolBatchHitlIds: async () => [],
    tryStartQueuedExecution: async () => undefined,
    tryRunSessionFamilyControl: async (_input: unknown, operation: () => Promise<unknown>) => ({
      kind: "executed" as const,
      result: await operation(),
    }),
    startRuntimeReviewChild: async () => ({} as ChildExecutionHandle),
    ...overrides,
  } as unknown as SessionExecutionManager;
}

function makeCoordinator(
  executionManager: SessionExecutionManager,
  overrides: { modelRuntime?: ModelRuntime; modelSelectionResolver?: ModelSelectionResolver } = {},
): SessionGoalCoordinator {
  const coordinator = new SessionGoalCoordinator({
    service,
    storeManager: stores,
    executionManager,
    modelRuntime: overrides.modelRuntime ?? ({} as ModelRuntime),
    modelSelectionResolver: overrides.modelSelectionResolver ?? ({} as ModelSelectionResolver),
    logger: silentLogger,
  });
  coordinators.push(coordinator);
  return coordinator;
}

class FakeReviewWatch {
  close(): void {}

  on(_event: "error", _listener: (error: Error) => void): this {
    return this;
  }
}
