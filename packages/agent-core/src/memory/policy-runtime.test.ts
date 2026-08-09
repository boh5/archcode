import { describe, expect, test } from "bun:test";
import { MemoryPolicyRuntime } from "./policy-runtime";

describe("MemoryPolicyRuntime", () => {
  test("claims an immutable boot-scoped policy epoch", () => {
    const runtime = new MemoryPolicyRuntime(
      { useMemory: true, autoLearning: true },
      "boot-a",
    );

    expect(runtime.claim()).toEqual({
      policy: { useMemory: true, autoLearning: true },
      epoch: { bootId: "boot-a", generation: 0 },
    });
    expect(Object.isFrozen(runtime.claim())).toBe(true);
  });

  test("increments generation for every effective policy transition", async () => {
    const runtime = new MemoryPolicyRuntime(undefined, "boot-a");

    expect((await runtime.publish({ useMemory: false, autoLearning: true })).epoch.generation).toBe(1);
    expect((await runtime.publish({ useMemory: false, autoLearning: true })).epoch.generation).toBe(1);
    expect((await runtime.publish({ useMemory: true, autoLearning: true })).epoch.generation).toBe(2);
  });

  test("rejects stale and disabled automatic apply admission", async () => {
    const runtime = new MemoryPolicyRuntime(undefined, "boot-a");
    const oldEpoch = runtime.claim().epoch;
    await runtime.publish({ useMemory: true, autoLearning: false });

    let called = false;
    const result = await runtime.withApplyAdmission(oldEpoch, async () => {
      called = true;
    });

    expect(result.status).toBe("stale");
    expect(called).toBe(false);
  });

  test("a disabling commit waits for admitted apply and blocks the old epoch", async () => {
    const runtime = new MemoryPolicyRuntime(undefined, "boot-a");
    const epoch = runtime.claim().epoch;
    let releaseApply!: () => void;
    const applyBlocked = new Promise<void>((resolve) => {
      releaseApply = resolve;
    });
    const events: string[] = [];

    const applying = runtime.withApplyAdmission(epoch, async () => {
      events.push("apply:start");
      await applyBlocked;
      events.push("apply:end");
    });
    await Promise.resolve();
    const disabling = runtime.commitPolicy(
      { useMemory: true, autoLearning: false },
      async () => {
        events.push("config:commit");
      },
    );
    await Promise.resolve();

    expect(events).toEqual(["apply:start"]);
    releaseApply();
    await Promise.all([applying, disabling]);
    expect(events).toEqual(["apply:start", "apply:end", "config:commit"]);

    const stale = await runtime.withApplyAdmission(epoch, async () => undefined);
    expect(stale.status).toBe("stale");
  });

  test("does not publish a policy when the durable commit fails", async () => {
    const runtime = new MemoryPolicyRuntime(undefined, "boot-a");

    await expect(runtime.commitPolicy(
      { useMemory: false, autoLearning: false },
      async () => {
        throw new Error("disk failed");
      },
    )).rejects.toThrow("disk failed");
    expect(runtime.claim().epoch.generation).toBe(0);
    expect(runtime.claim().policy).toEqual({ useMemory: true, autoLearning: true });
  });

  test("admits enable-pending work only until the durable commit fails", async () => {
    const runtime = new MemoryPolicyRuntime(
      { useMemory: true, autoLearning: false },
      "boot-a",
    );
    let releaseCommit!: () => void;
    const commitBlocked = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    let markCommitStarted!: () => void;
    const commitStarted = new Promise<void>((resolve) => {
      markCommitStarted = resolve;
    });
    let failureObserved = false;
    runtime.subscribe({
      afterEnableFailure: () => {
        failureObserved = true;
      },
    });

    const enabling = runtime.commitPolicy(
      { useMemory: true, autoLearning: true },
      async () => {
        markCommitStarted();
        await commitBlocked;
        throw new Error("disk failed");
      },
    );
    await commitStarted;

    expect(runtime.current.policy.autoLearning).toBe(false);
    expect(runtime.autoLearningAdmission).toBe("enable_pending");
    releaseCommit();
    await expect(enabling).rejects.toThrow("disk failed");
    expect(failureObserved).toBe(true);
    expect(runtime.autoLearningAdmission).toBe("disabled");
    expect(runtime.current.epoch.generation).toBe(0);
  });

  test("runs before-enable listeners before commit and keeps policy unchanged on failure", async () => {
    const runtime = new MemoryPolicyRuntime(
      { useMemory: true, autoLearning: false },
      "boot-a",
    );
    let committed = false;
    runtime.subscribe({
      beforeEnable: async () => {
        throw new Error("skip failed");
      },
    });

    await expect(runtime.commitPolicy(
      { useMemory: true, autoLearning: true },
      async () => {
        committed = true;
      },
    )).rejects.toThrow("skip failed");

    expect(committed).toBe(false);
    expect(runtime.claim()).toEqual({
      policy: { useMemory: true, autoLearning: false },
      epoch: { bootId: "boot-a", generation: 0 },
    });
  });

  test("publishes the committed epoch and propagates after-commit failures", async () => {
    const runtime = new MemoryPolicyRuntime(undefined, "boot-a");
    const events: string[] = [];
    runtime.subscribe({
      afterCommit: async (snapshot, previous) => {
        events.push(`after:${previous.epoch.generation}->${snapshot.epoch.generation}`);
        throw new Error("observer failed");
      },
    });

    await expect(runtime.commitPolicy(
      { useMemory: true, autoLearning: false },
      async () => {
        events.push("config:commit");
      },
    )).rejects.toThrow("observer failed");

    expect(events).toEqual(["config:commit", "after:0->1"]);
    expect(runtime.claim()).toEqual({
      policy: { useMemory: true, autoLearning: false },
      epoch: { bootId: "boot-a", generation: 1 },
    });
  });
});
