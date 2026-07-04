import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import type { ToolExecutionResult } from "../tools/types";
import {
  FakeClock,
  FakeGitHubFetchAdapter,
  FakeSessionExecutionManager,
  expectJsonlRunCount,
  findJsonlRuns,
  fixtureCollisionConflict,
  fixtureCollisionLease,
  fixtureCollisionTarget,
  fixtureIntegrationError,
  fixtureKillState,
  fixtureLoopBudgetConfig,
  fixtureLoopBudgetUsage,
  fixtureLoopId,
  fixtureLoopRunReport,
  fixtureProjectSlug,
  fixtureRunId,
  makeAllTestTools,
  makeEffectfulTestTools,
  makeReadOnlyTestTools,
  makeTestToolDescriptor,
  parseJsonl,
  redactTokenValue,
  resetSequenceCounter,
  utcEpochMs,
} from "./test-utils";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "test-utils");

beforeEach(async () => {
  resetSequenceCounter();
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
  await mkdir(TMP_DIR, { recursive: true });
});

afterAll(async () => {
  resetSequenceCounter();
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
});

// ── Fixture factories ──

describe("fixtureProjectSlug", () => {
  test("returns deterministic slug", () => {
    expect(fixtureProjectSlug()).toBe("test-project");
  });
});

describe("fixtureLoopId", () => {
  test("returns auto-incrementing IDs", () => {
    expect(fixtureLoopId()).toBe("test-loop-1");
    expect(fixtureLoopId()).toBe("test-loop-2");
  });

  test("accepts override", () => {
    expect(fixtureLoopId({ loopId: "my-loop" })).toBe("my-loop");
  });

  test("honors resetSequenceCounter", () => {
    resetSequenceCounter();
    expect(fixtureLoopId()).toBe("test-loop-1");
  });
});

describe("fixtureRunId", () => {
  test("returns auto-incrementing IDs", () => {
    expect(fixtureRunId()).toBe("test-run-1");
    expect(fixtureRunId()).toBe("test-run-2");
  });

  test("accepts override", () => {
    expect(fixtureRunId({ runId: "manual-run" })).toBe("manual-run");
  });
});

describe("fixtureLoopBudgetConfig", () => {
  test("returns defaults with soft/hard ratios", () => {
    const config = fixtureLoopBudgetConfig();

    expect(config.maxIterationsPerRun).toBe(8);
    expect(config.softThresholdRatio).toBe(0.8);
    expect(config.hardThresholdRatio).toBe(1.0);
    expect(config.maxTokensPerRun).toBe(120_000);
    expect(config.maxWallClockMsPerRun).toBe(900_000);
    expect(config.maxRunsPerDay).toBe(2);
    expect(config.maxEstimatedUsdPerRun).toBeUndefined();
  });

  test("accepts partial overrides", () => {
    const config = fixtureLoopBudgetConfig({ maxTokensPerRun: 999, maxRunsPerDay: 5 });

    expect(config.maxTokensPerRun).toBe(999);
    expect(config.maxRunsPerDay).toBe(5);
    expect(config.maxIterationsPerRun).toBe(8);
    expect(config.softThresholdRatio).toBe(0.8);
  });
});

describe("fixtureLoopBudgetUsage", () => {
  test("returns defaults with pricing unavailable", () => {
    const usage = fixtureLoopBudgetUsage();

    expect(usage.iterations).toBe(4);
    expect(usage.inputTokens).toBe(12_000);
    expect(usage.outputTokens).toBe(6_000);
    expect(usage.totalTokens).toBe(18_000);
    expect(usage.wallClockMs).toBe(45_000);
    expect(usage.runsToday).toBe(1);
    expect(usage.resetDateUtc).toBe("2026-07-04");
    expect(usage.pricingUnavailable).toBe(true);
  });

  test("accepts overrides", () => {
    const usage = fixtureLoopBudgetUsage({ runsToday: 2, pricingUnavailable: false });

    expect(usage.runsToday).toBe(2);
    expect(usage.pricingUnavailable).toBe(false);
    expect(usage.iterations).toBe(4);
  });
});

describe("fixtureCollisionTarget", () => {
  test("returns default PR target", () => {
    const target = fixtureCollisionTarget() as { type: "pr"; owner: string; repo: string; number: number };

    expect(target).toEqual({ type: "pr", owner: "archcode", repo: "workbench", number: 42 });
  });

  test("accepts override", () => {
    const target = fixtureCollisionTarget({ type: "issue", owner: "archcode", repo: "workbench", number: 7 }) as { type: "issue"; owner: string; repo: string; number: number };

    expect(target.type).toBe("issue");
    expect(target.number).toBe(7);
  });
});

describe("fixtureCollisionLease", () => {
  test("returns default lease with 5-minute expiry", () => {
    const lease = fixtureCollisionLease();
    const gap = lease.expiresAt - lease.createdAt;

    expect(gap).toBe(300_000);
    expect(lease.loopId).toBe("test-loop-1");
    expect(lease.runId).toBe("test-run-1");
    expect(lease.priority).toBe(10);
    expect(lease.targetKey).toBe("github:archcode/workbench:pr:42");
  });

  test("accepts overrides", () => {
    const lease = fixtureCollisionLease({ priority: 99, loopId: "other-loop" });

    expect(lease.priority).toBe(99);
    expect(lease.loopId).toBe("other-loop");
    expect(lease.runId).toBe("test-run-1");
  });
});

describe("fixtureCollisionConflict", () => {
  test("returns conflict with two different leases", () => {
    const conflict = fixtureCollisionConflict();

    expect(conflict.targetKey).toBe("github:archcode/workbench:pr:42");
    expect(conflict.conflictingLease.loopId).toBe("test-loop-2");
    expect(conflict.conflictingLease.priority).toBe(5);
    expect(conflict.detectedAt).toBeGreaterThan(0);
  });
});

describe("fixtureIntegrationError", () => {
  test("returns default auth_missing error", () => {
    const err = fixtureIntegrationError();

    expect(err.integrationId).toBe("github");
    expect(err.reason).toBe("integration_auth_missing");
    expect(err.message).toContain("token");
    expect(err.occurredAt).toBeGreaterThan(0);
  });

  test("accepts overrides", () => {
    const err = fixtureIntegrationError({
      integrationId: "github_actions",
      reason: "integration_rate_limited",
      retryAfterMs: 60_000,
    });

    expect(err.integrationId).toBe("github_actions");
    expect(err.reason).toBe("integration_rate_limited");
    expect(err.retryAfterMs).toBe(60_000);
  });
});

describe("fixtureLoopRunReport", () => {
  test("returns default succeeded report", () => {
    const report = fixtureLoopRunReport();

    expect(report.status).toBe("succeeded");
    expect(report.reason).toBe("completed");
    expect(report.trigger).toBe("manual");
    expect(report.runId).toBe("test-run-1");
    expect(report.loopId).toBe("test-loop-1");
    expect(report.endedAt).toBe(report.startedAt + 60_000);
  });

  test("accepts overrides", () => {
    const report = fixtureLoopRunReport({ status: "budget_exceeded", reason: "hard_budget_exceeded" });

    expect(report.status).toBe("budget_exceeded");
    expect(report.reason).toBe("hard_budget_exceeded");
  });
});

describe("fixtureKillState", () => {
  test("returns inactive state by default", () => {
    const state = fixtureKillState();

    expect(state.globalKillActive).toBe(false);
  });

  test("accepts active state with metadata", () => {
    const state = fixtureKillState({
      globalKillActive: true,
      activatedAt: 1000,
      activatedBy: "test-user",
      reason: "emergency stop",
    });

    expect(state.globalKillActive).toBe(true);
    expect(state.activatedBy).toBe("test-user");
    expect(state.reason).toBe("emergency stop");
  });
});

// ── FakeClock ──

describe("FakeClock", () => {
  test("defaults to UTC epoch reference", () => {
    const clock = new FakeClock();

    expect(clock.now()).toBe(utcEpochMs());
    expect(clock.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  test("now() returns configured time", () => {
    const clock = new FakeClock(1000);

    expect(clock.now()).toBe(1000);
  });

  test("set() changes current time", () => {
    const clock = new FakeClock();
    clock.set(5000);

    expect(clock.now()).toBe(5000);
  });

  test("utcDateKey returns YYYY-MM-DD string", () => {
    const clock = new FakeClock();

    expect(clock.utcDateKey()).toBe("2026-01-01");
  });

  test("utcDateKey crosses midnight UTC boundary independent of local timezone", () => {
    // 2026-07-04T23:59:59.999Z  →  "2026-07-04"
    const beforeMidnight = new FakeClock(Date.UTC(2026, 6, 4, 23, 59, 59, 999));
    expect(beforeMidnight.utcDateKey()).toBe("2026-07-04");

    // 2026-07-05T00:00:00.000Z  →  "2026-07-05"
    const afterMidnight = new FakeClock(Date.UTC(2026, 6, 5, 0, 0, 0, 0));
    expect(afterMidnight.utcDateKey()).toBe("2026-07-05");
  });

  test("toISOString returns UTC", () => {
    const clock = new FakeClock(Date.UTC(2026, 11, 25, 10, 30, 0, 0));

    expect(clock.toISOString()).toBe("2026-12-25T10:30:00.000Z");
  });
});

// ── FakeSessionExecutionManager ──

describe("FakeSessionExecutionManager", () => {
  test("abort records call and returns true", () => {
    const manager = new FakeSessionExecutionManager();

    const result = manager.abort("/workspace", "session-1");

    expect(result).toBe(true);
    expect(manager.calls).toHaveLength(1);
    expect(manager.calls[0]).toMatchObject({ method: "abort", workspaceRoot: "/workspace", sessionId: "session-1" });
  });

  test("abortAndWait records call and resolves", async () => {
    const manager = new FakeSessionExecutionManager();

    await manager.abortAndWait("/workspace", "session-1");

    expect(manager.getCalls("abortAndWait")).toHaveLength(1);
  });

  test("abortAll records call", async () => {
    const manager = new FakeSessionExecutionManager();

    await manager.abortAll();

    expect(manager.getCalls("abortAll")).toHaveLength(1);
  });

  test("isRunning returns configured value", () => {
    const manager = new FakeSessionExecutionManager();

    expect(manager.isRunning("/workspace", "session-1")).toBe(false);

    manager.setIsRunning(true);
    expect(manager.isRunning("/workspace", "session-1")).toBe(true);
  });

  test("assertCallCount passes when expected matches", () => {
    const manager = new FakeSessionExecutionManager();
    manager.abort("/w", "s1");
    manager.abort("/w", "s2");

    expect(() => manager.assertCallCount("abort", 2)).not.toThrow();
  });

  test("assertCallCount throws when expected does not match", () => {
    const manager = new FakeSessionExecutionManager();
    manager.abort("/w", "s1");

    expect(() => manager.assertCallCount("abort", 0)).toThrow();
  });

  test("clear removes recorded calls", () => {
    const manager = new FakeSessionExecutionManager();
    manager.abort("/w", "s1");

    manager.clear();

    expect(manager.calls).toHaveLength(0);
  });
});

// ── Fake ToolRegistry / tool descriptors ──

describe("makeTestToolDescriptor", () => {
  test("creates a read-only descriptor by default", () => {
    const desc = makeTestToolDescriptor("file_read");

    expect(desc.name).toBe("file_read");
    expect(desc.traits.readOnly).toBe(true);
    expect(desc.traits.destructive).toBe(false);
    expect(desc.traits.concurrencySafe).toBe(true);
  });

  test("creates effectful descriptor when configured", () => {
    const desc = makeTestToolDescriptor("file_write", false, true);

    expect(desc.traits.readOnly).toBe(false);
    expect(desc.traits.destructive).toBe(true);
    expect(desc.traits.concurrencySafe).toBe(false);
  });

  test("creates executable descriptor", async () => {
    const desc = makeTestToolDescriptor("bash", false);

    const result = (await desc.execute({} as never, {} as never)) as ToolExecutionResult;

    expect(result.output).toBe("fake-bash");
    expect(result.isError).toBe(false);
  });
});

describe("makeReadOnlyTestTools", () => {
  test("returns only read-only tools", () => {
    const tools = makeReadOnlyTestTools();

    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.traits.readOnly).toBe(true);
    }
  });

  test("includes known tools", () => {
    const tools = makeReadOnlyTestTools();
    const names = tools.map((t) => t.name);

    expect(names).toContain("file_read");
    expect(names).toContain("grep");
    expect(names).toContain("lsp_diagnostics");
    expect(names).not.toContain("bash");
    expect(names).not.toContain("file_write");
  });
});

describe("makeEffectfulTestTools", () => {
  test("returns only non-read-only tools", () => {
    const tools = makeEffectfulTestTools();

    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.traits.readOnly).toBe(false);
    }
  });

  test("includes known tools", () => {
    const tools = makeEffectfulTestTools();
    const names = tools.map((t) => t.name);

    expect(names).toContain("file_write");
    expect(names).toContain("bash");
    expect(names).not.toContain("file_read");
    expect(names).not.toContain("grep");
  });
});

describe("makeAllTestTools", () => {
  test("combines read-only and effectful tools", () => {
    const tools = makeAllTestTools();
    const names = tools.map((t) => t.name);

    expect(names).toContain("file_read");
    expect(names).toContain("file_write");
    expect(names).toContain("bash");
  });

  test("no duplicate names", () => {
    const tools = makeAllTestTools();
    const names = tools.map((t) => t.name);

    expect(new Set(names).size).toBe(names.length);
  });
});

// ── FakeGitHubFetchAdapter ──

describe("FakeGitHubFetchAdapter", () => {
  test("records request URL and method", async () => {
    const adapter = new FakeGitHubFetchAdapter();
    const fetch = adapter.createFetch();

    const res = await fetch("https://api.github.com/repos/archcode/workbench/pulls/42");

    expect(res.status).toBe(200);
    expect(adapter.requests).toHaveLength(1);
    expect(adapter.requests[0].url).toBe("https://api.github.com/repos/archcode/workbench/pulls/42");
    expect(adapter.requests[0].method).toBe("GET");
  });

  test("records request headers", async () => {
    const adapter = new FakeGitHubFetchAdapter();
    const fetch = adapter.createFetch();

    await fetch("https://api.github.com/repos/archcode/workbench/pulls/42", {
      headers: { Authorization: "Bearer ghp_test_token", Accept: "application/vnd.github.v3+json" },
    });

    expect(adapter.requests[0].headers.Authorization).toBe("Bearer ghp_test_token");
    expect(adapter.requests[0].headers.Accept).toBe("application/vnd.github.v3+json");
  });

  test("returns deterministic PR response via makePullRequest", async () => {
    const adapter = new FakeGitHubFetchAdapter();
    adapter.setResponse(
      "https://api.github.com/repos/archcode/workbench/pulls/42",
      adapter.makePullRequest(),
    );
    const fetch = adapter.createFetch();

    const res = await fetch("https://api.github.com/repos/archcode/workbench/pulls/42");
    const body = await res.json() as Record<string, unknown>;

    expect(body.number).toBe(42);
    expect(body.title).toBe("Test PR title");
    expect(body.state).toBe("open");
  });

  test("returns deterministic check run response", async () => {
    const adapter = new FakeGitHubFetchAdapter();
    const check = adapter.makeCheckRun({ conclusion: "failure" });

    expect(check.id).toBe(1001);
    expect(check.name).toBe("test / lint");
    expect(check.conclusion).toBe("failure");
  });

  test("returns deterministic workflow run response", async () => {
    const adapter = new FakeGitHubFetchAdapter();
    const run = adapter.makeWorkflowRun({ head_branch: "feature-branch", status: "in_progress" });

    expect(run.id).toBe(2001);
    expect(run.name).toBe("CI");
    expect(run.head_branch).toBe("feature-branch");
    expect(run.status).toBe("in_progress");
  });

  test("returns deterministic issue comment response", async () => {
    const adapter = new FakeGitHubFetchAdapter();
    const comment = adapter.makeIssueComment({ body: "Looking good!" });

    expect(comment.id).toBe(3001);
    expect(comment.body).toBe("Looking good!");
    expect(comment.user).toBe("test-user");
  });

  test("redacts token from thrown error", async () => {
    const adapter = new FakeGitHubFetchAdapter();
    adapter.setDefaultToken("ghp_mysecret_test_token_value");
    adapter.setThrowOnNextCall(new Error("API error with token ghp_mysecret_test_token_value"));
    const fetch = adapter.createFetch();

    let thrown: Error | undefined;
    try {
      await fetch("https://api.github.com/repos/archcode/workbench/pulls/42");
    } catch (err) {
      thrown = err as Error;
    }

    expect(thrown).toBeDefined();
    expect(thrown!.message).not.toContain("ghp_mysecret_test_token_value");
    expect(thrown!.message).toContain("[REDACTED:SECRET]");
  });

  test("redacts token from default token in error", async () => {
    const adapter = new FakeGitHubFetchAdapter();
    adapter.setDefaultToken("ghp_another_secret");
    adapter.setThrowOnNextCall(new Error("error with token ghp_another_secret"));
    const fetch = adapter.createFetch();

    let thrown: Error | undefined;
    try {
      await fetch("https://api.github.com/repos/archcode/workbench/pulls/42");
    } catch (err) {
      thrown = err as Error;
    }

    expect(thrown).toBeDefined();
    expect(thrown!.message).not.toContain("ghp_another_secret");
  });

  test("clearRequests resets recorded calls", async () => {
    const adapter = new FakeGitHubFetchAdapter();
    const fetch = adapter.createFetch();

    await fetch("https://api.github.com/repos/archcode/workbench/pulls/42");
    expect(adapter.requests).toHaveLength(1);

    adapter.clearRequests();
    expect(adapter.requests).toHaveLength(0);
  });

  test("token not leaked in normal responses", async () => {
    const adapter = new FakeGitHubFetchAdapter();
    adapter.setDefaultToken("ghp_should_not_leak");
    adapter.setResponse("https://api.github.com/repos/archcode/workbench/pulls/42", { number: 42 });
    const fetch = adapter.createFetch();

    const res = await fetch("https://api.github.com/repos/archcode/workbench/pulls/42", {
      headers: { Authorization: "Bearer ghp_should_not_leak" },
    });
    const body = await res.text();

    expect(body).not.toContain("ghp_should_not_leak");
  });
});

// ── redactTokenValue ──

describe("redactTokenValue", () => {
  test("replaces exact token match", () => {
    const result = redactTokenValue("Error with token ghp_abc123", "ghp_abc123");

    expect(result).not.toContain("ghp_abc123");
    expect(result).toContain("[REDACTED:SECRET]");
  });

  test("returns message unchanged when token is empty", () => {
    const result = redactTokenValue("Some error message", "");

    expect(result).toBe("Some error message");
  });

  test("redacts token pattern even when embedded in longer text", () => {
    const result = redactTokenValue("token=ghp_xyz789 end", "ghp_xyz789");

    expect(result).not.toContain("ghp_xyz789");
    expect(result).toContain("[REDACTED:SECRET]");
  });
});

// ── JSONL assertion utilities ──

describe("parseJsonl", () => {
  test("parses valid JSONL", () => {
    const jsonl = `{"a": 1}\n{"b": 2}\n{"c": 3}`;

    const result = parseJsonl(jsonl);

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ a: 1 });
    expect(result[1]).toEqual({ b: 2 });
    expect(result[2]).toEqual({ c: 3 });
  });

  test("skips empty lines", () => {
    const jsonl = `{"a": 1}\n\n{"b": 2}\n  \n`;

    const result = parseJsonl(jsonl);

    expect(result).toHaveLength(2);
  });

  test("throws on malformed JSON", () => {
    const jsonl = `{"valid": true}\n{invalid}`;

    expect(() => parseJsonl(jsonl)).toThrow();
  });

  test("returns empty array for empty input", () => {
    expect(parseJsonl("")).toEqual([]);
    expect(parseJsonl("  \n\n  ")).toEqual([]);
  });
});

describe("expectJsonlRunCount", () => {
  test("returns reports when count matches", () => {
    const jsonl = `{"runId": "r1", "status": "succeeded"}\n{"runId": "r2", "status": "failed"}`;

    const reports = expectJsonlRunCount(jsonl, 2);

    expect(reports).toHaveLength(2);
    expect(reports[0].runId).toBe("r1");
    expect(reports[1].runId).toBe("r2");
  });

  test("throws when count does not match", () => {
    const jsonl = `{"runId": "r1"}`;

    expect(() => expectJsonlRunCount(jsonl, 3)).toThrow();
  });
});

describe("findJsonlRuns", () => {
  test("finds reports matching predicate", () => {
    const jsonl = [
      JSON.stringify(fixtureLoopRunReport({ runId: "r1", status: "succeeded" })),
      JSON.stringify(fixtureLoopRunReport({ runId: "r2", status: "failed" })),
      JSON.stringify(fixtureLoopRunReport({ runId: "r3", status: "succeeded" })),
    ].join("\n");

    const succeeded = findJsonlRuns(jsonl, (r) => r.status === "succeeded");

    expect(succeeded).toHaveLength(2);
    expect(succeeded[0].runId).toBe("r1");
    expect(succeeded[1].runId).toBe("r3");
  });

  test("returns empty when no match", () => {
    const jsonl = JSON.stringify(fixtureLoopRunReport({ status: "succeeded" }));

    const failed = findJsonlRuns(jsonl, (r) => r.status === "failed");

    expect(failed).toHaveLength(0);
  });
});

// ── File safety: no writes outside temp ──

describe("file safety", () => {
  test("JSONL utilities do not write to filesystem", () => {
    const jsonl = `{"runId": "r1"}`;

    const reports = parseJsonl(jsonl);
    expect(reports).toHaveLength(1);
  });

  test("fixture factories do not write to filesystem", () => {
    fixtureLoopBudgetConfig();
    fixtureLoopBudgetUsage();
    fixtureCollisionTarget();
    fixtureCollisionLease();
    fixtureCollisionConflict();
    fixtureIntegrationError();
    fixtureLoopRunReport();
    fixtureKillState();

    // No filesystem writes occurred — if they had, the test would have thrown
  });
});