import { describe, expect, test } from "bun:test";
import {
  createSessionSnapshotRecoveryRetry,
  SESSION_SNAPSHOT_RECOVERY_RETRY_MAX_MS,
} from "./session-snapshot-recovery-retry";

interface ScheduledRetry {
  callback: () => void;
  delayMs: number;
  cancelled: boolean;
}

function createHarness() {
  const recovery = {
    status: "awaiting" as "live" | "awaiting",
    generation: 1,
  };
  const scheduled: ScheduledRetry[] = [];
  let refetchCount = 0;
  const controller = createSessionSnapshotRecoveryRetry({
    readRecoveryState: () => recovery,
    refetch: () => {
      refetchCount += 1;
    },
    schedule: (callback, delayMs) => {
      const retry = { callback, delayMs, cancelled: false };
      scheduled.push(retry);
      return retry;
    },
    cancel: (timer) => {
      (timer as ScheduledRetry).cancelled = true;
    },
  });
  return {
    controller,
    recovery,
    scheduled,
    refetchCount: () => refetchCount,
  };
}

describe("Session snapshot recovery retry", () => {
  test("terminal request failures keep the recovery gate and schedule bounded newer attempts", () => {
    const harness = createHarness();
    const terminalFailure = { terminalFailure: true, fetching: false };

    harness.controller.update(terminalFailure);
    expect(harness.scheduled.map((retry) => retry.delayMs)).toEqual([1_000]);

    for (let attempt = 0; attempt < 6; attempt += 1) {
      harness.scheduled.at(-1)?.callback();
      expect(harness.recovery.status).toBe("awaiting");
      expect(harness.refetchCount()).toBe(attempt + 1);
      harness.controller.update(terminalFailure);
    }

    expect(harness.scheduled.map((retry) => retry.delayMs)).toEqual([
      1_000,
      2_000,
      4_000,
      8_000,
      SESSION_SNAPSHOT_RECOVERY_RETRY_MAX_MS,
      SESSION_SNAPSHOT_RECOVERY_RETRY_MAX_MS,
      SESSION_SNAPSHOT_RECOVERY_RETRY_MAX_MS,
    ]);
  });

  test("a successful current-generation snapshot stops recovery retries", () => {
    const harness = createHarness();
    harness.controller.update({ terminalFailure: true, fetching: false });
    const pending = harness.scheduled[0]!;

    harness.recovery.status = "live";
    harness.controller.update({ terminalFailure: false, fetching: false });

    expect(pending.cancelled).toBe(true);
    pending.callback();
    expect(harness.refetchCount()).toBe(0);
    expect(harness.scheduled).toHaveLength(1);
  });

  test("a newer generation and disposal prevent old retry timers from driving requests", () => {
    const harness = createHarness();
    const terminalFailure = { terminalFailure: true, fetching: false };
    harness.controller.update(terminalFailure);
    const oldGenerationRetry = harness.scheduled[0]!;

    harness.recovery.generation = 2;
    harness.controller.update(terminalFailure);
    const currentGenerationRetry = harness.scheduled[1]!;

    expect(oldGenerationRetry.cancelled).toBe(true);
    expect(currentGenerationRetry.delayMs).toBe(1_000);
    oldGenerationRetry.callback();
    expect(harness.refetchCount()).toBe(0);

    harness.controller.dispose();
    expect(currentGenerationRetry.cancelled).toBe(true);
    currentGenerationRetry.callback();
    expect(harness.refetchCount()).toBe(0);
  });

  test("ordinary terminal query failure does not create recovery retries while the gate is live", () => {
    const harness = createHarness();
    harness.recovery.status = "live";

    harness.controller.update({ terminalFailure: true, fetching: false });

    expect(harness.scheduled).toEqual([]);
    expect(harness.refetchCount()).toBe(0);
  });
});
