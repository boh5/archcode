import { describe, expect, test } from "bun:test";
import type { SessionExecutionRecord, SessionFamilyActivity, SessionGoal } from "@archcode/protocol";
import { AgentRunningError } from "./agents/errors";
import { reconcileActiveSessionGoal } from "./runtime";

type ExecutionStatus = SessionExecutionRecord["status"];
type GoalStatus = SessionGoal["status"];

function harness(overrides: {
  activity?: SessionFamilyActivity;
  hasHitl?: boolean;
  queued?: boolean;
  isRootLead?: boolean;
  goalStatus?: GoalStatus;
  executionStatus?: ExecutionStatus;
  startContinuation?: () => Promise<void>;
} = {}) {
  const calls: string[] = [];
  const dependencies = {
    getFamilyActivity: () => overrides.activity ?? "idle",
    hasUnresolvedToolBatchHitl: async () => {
      calls.push("hitl");
      return overrides.hasHitl ?? false;
    },
    startQueuedExecution: async () => {
      calls.push("queue");
      return overrides.queued ?? false;
    },
    loadSnapshot: async () => {
      calls.push("snapshot");
      return {
        isRootLead: overrides.isRootLead ?? true,
        goalStatus: overrides.goalStatus ?? "active" as const,
        lastRootExecutionStatus: overrides.executionStatus ?? "completed" as const,
      };
    },
    startContinuation: async () => {
      calls.push("continuation");
      await overrides.startContinuation?.();
    },
  };
  return { calls, dependencies };
}

describe("stateless active Goal continuation", () => {
  for (const executionStatus of ["completed", "max_steps"] as const) {
    test(`continues after a root ${executionStatus} terminal`, async () => {
      const { calls, dependencies } = harness({ executionStatus });
      await reconcileActiveSessionGoal({ forceStartupRecovery: false }, dependencies);
      expect(calls).toEqual(["hitl", "queue", "snapshot", "continuation"]);
    });
  }

  test("startup recovery deliberately ignores the previous root terminal", async () => {
    const { calls, dependencies } = harness({ executionStatus: "failed" });
    await reconcileActiveSessionGoal({ forceStartupRecovery: true }, dependencies);
    expect(calls).toContain("continuation");
  });

  test("queued user input takes precedence over autonomous continuation", async () => {
    const { calls, dependencies } = harness({ queued: true });
    await reconcileActiveSessionGoal({ forceStartupRecovery: false }, dependencies);
    expect(calls).toEqual(["hitl", "queue"]);
  });

  test("non-idle family and unresolved HITL/tool batches block continuation before queue admission", async () => {
    const active = harness({ activity: "running" });
    await reconcileActiveSessionGoal({ forceStartupRecovery: false }, active.dependencies);
    expect(active.calls).toEqual([]);

    const blocked = harness({ hasHitl: true });
    await reconcileActiveSessionGoal({ forceStartupRecovery: false }, blocked.dependencies);
    expect(blocked.calls).toEqual(["hitl"]);
  });

  test("only an active root Lead is eligible", async () => {
    const child = harness({ isRootLead: false });
    await reconcileActiveSessionGoal({ forceStartupRecovery: false }, child.dependencies);
    expect(child.calls).not.toContain("continuation");

    for (const goalStatus of ["paused", "blocked", "budget_limited", "complete"] as const) {
      const inactive = harness({ goalStatus });
      await reconcileActiveSessionGoal({ forceStartupRecovery: false }, inactive.dependencies);
      expect(inactive.calls, goalStatus).not.toContain("continuation");
    }
  });

  test("ordinary recovery does not retry prohibited root terminals", async () => {
    const statuses = [
      "running",
      "failed",
      "timed_out",
      "aborted",
      "cancelled",
      "interrupted",
      "waiting_for_human",
    ] as const;
    for (const executionStatus of statuses) {
      const terminal = harness({ executionStatus });
      await reconcileActiveSessionGoal({ forceStartupRecovery: false }, terminal.dependencies);
      expect(terminal.calls, executionStatus).not.toContain("continuation");
    }
  });

  test("concurrent triggers coalesce at Runtime execution admission", async () => {
    let admitted = false;
    let starts = 0;
    const startContinuation = async () => {
      if (admitted) throw new AgentRunningError();
      admitted = true;
      starts += 1;
      await Promise.resolve();
    };
    const first = harness({ startContinuation });
    const second = harness({ startContinuation });

    await Promise.all([
      reconcileActiveSessionGoal({ forceStartupRecovery: false }, first.dependencies),
      reconcileActiveSessionGoal({ forceStartupRecovery: false }, second.dependencies),
    ]);
    expect(starts).toBe(1);
  });
});
