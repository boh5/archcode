import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { CollisionLedger, canonicalTargetKey, normalizeWorkspaceRelativePath } from "./collision-ledger";
import { LoopStateManager, type CollisionTarget, type LoopConfig } from "./state";
import { FakeClock } from "./test-utils";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "collision-ledger");

const config: LoopConfig = {
  templateId: "watch_report",
  title: "Collision loop",
  schedule: { kind: "manual" },
  approvalPolicy: "interactive",
  limits: { maxIterationsPerRun: 4, softThresholdRatio: 0.8, hardThresholdRatio: 1 },
};

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
  await mkdir(TMP_DIR, { recursive: true });
});

afterAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
});

describe("CollisionLedger", () => {
  test("canonicalizes target keys for PR, issue, branch, and workspace-relative files", () => {
    expect(canonicalTargetKey({ type: "pr", owner: "test-owner", repo: "test-repo", number: 42 })).toBe("github:test-owner/test-repo:pr:42");
    expect(canonicalTargetKey({ type: "issue", owner: "test-owner", repo: "test-repo", number: 7 })).toBe("github:test-owner/test-repo:issue:7");
    expect(canonicalTargetKey({ type: "branch", owner: "test-owner", repo: "test-repo", branch: "main" })).toBe("git:test-owner/test-repo:branch:main");
    expect(canonicalTargetKey({ type: "file", path: "src/index.ts" })).toBe("file:src/index.ts");
  });

  test("same PR target conflict skips lower-priority newer lease", async () => {
    const fixture = await createFixture();
    const target: CollisionTarget = { type: "pr", owner: "test-owner", repo: "test-repo", number: 42 };
    const loopA = await fixture.stateManager.create("project-a", config);
    const loopB = await fixture.stateManager.create("project-a", config);

    const held = await fixture.ledger.acquire({ target, loopId: loopA.loopId, runId: "run-a", priority: 10 });
    const skipped = await fixture.ledger.acquire({ target, loopId: loopB.loopId, runId: "run-b", priority: 5 });

    expect(held.acquired).toBe(true);
    expect(skipped.acquired).toBe(false);
    expect(skipped.conflict).toMatchObject({ targetKey: "github:test-owner/test-repo:pr:42" });
    expect(skipped.conflict?.conflictingLease).toMatchObject({ loopId: loopA.loopId, runId: "run-a", priority: 10 });
    expect(await fixture.ledger.readActiveLeases()).toHaveLength(1);
  });

  test("stale lease cleanup removes expired leases and allows a new action", async () => {
    const fixture = await createFixture();
    const target: CollisionTarget = { type: "pr", owner: "test-owner", repo: "test-repo", number: 42 };
    const loopA = await fixture.stateManager.create("project-a", config);
    const loopB = await fixture.stateManager.create("project-a", config);

    await fixture.ledger.acquire({ target, loopId: loopA.loopId, runId: "run-a", priority: 10, expiresAt: fixture.clock.now() + 10 });
    fixture.clock.set(fixture.clock.now() + 11);

    const removed = await fixture.ledger.cleanupStale();
    const acquired = await fixture.ledger.acquire({ target, loopId: loopB.loopId, runId: "run-b", priority: 1 });

    expect(removed).toHaveLength(1);
    expect(acquired.acquired).toBe(true);
    expect(acquired.lease?.loopId).toBe(loopB.loopId);
  });

  test("higher priority replaces an existing lower-priority lease", async () => {
    const fixture = await createFixture();
    const target: CollisionTarget = { type: "issue", owner: "test-owner", repo: "test-repo", number: 9 };
    const loopA = await fixture.stateManager.create("project-a", config);
    const loopB = await fixture.stateManager.create("project-a", config);

    await fixture.ledger.acquire({ target, loopId: loopA.loopId, runId: "run-a", priority: 1 });
    const result = await fixture.ledger.acquire({ target, loopId: loopB.loopId, runId: "run-b", priority: 5 });

    expect(result.acquired).toBe(true);
    const active = await fixture.ledger.readActiveLeases();
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ loopId: loopB.loopId, runId: "run-b", priority: 5 });
  });

  test("same-priority older lease wins against newer lease", async () => {
    const fixture = await createFixture();
    const target: CollisionTarget = { type: "branch", owner: "test-owner", repo: "test-repo", branch: "feature/x" };
    const loopA = await fixture.stateManager.create("project-a", config);
    const loopB = await fixture.stateManager.create("project-a", config);

    await fixture.ledger.acquire({ target, loopId: loopA.loopId, runId: "run-a", priority: 3, createdAt: fixture.clock.now() });
    const result = await fixture.ledger.acquire({ target, loopId: loopB.loopId, runId: "run-b", priority: 3, createdAt: fixture.clock.now() + 1 });

    expect(result.acquired).toBe(false);
    expect(result.conflict?.conflictingLease).toMatchObject({ loopId: loopA.loopId, priority: 3 });
  });

  test("normalizes file targets after workspace containment", async () => {
    await mkdir(join(TMP_DIR, "src"), { recursive: true });
    await Bun.write(join(TMP_DIR, "src", "file.ts"), "export {};\n");

    expect(normalizeWorkspaceRelativePath("src/../src/file.ts", TMP_DIR)).toBe("src/file.ts");
    expect(() => normalizeWorkspaceRelativePath("../outside.ts", TMP_DIR)).toThrow("outside the workspace");
  });
});

async function createFixture() {
  const clock = new FakeClock(Date.UTC(2026, 6, 4, 12, 0, 0));
  const stateManager = new LoopStateManager(TMP_DIR);
  const ledger = new CollisionLedger({ stateManager, workspaceRoot: TMP_DIR, clock, leaseTtlMs: 60_000 });
  return { clock, stateManager, ledger };
}
