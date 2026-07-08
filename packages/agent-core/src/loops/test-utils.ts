/**
 * Shared Loop test fixtures, fake services, and assertion utilities.
 *
 * These helpers are test-only. Production code must not import from this module.
 *
 * Deterministic by default: every factory accepts an optional `overrides` argument
 * and produces stable IDs/timestamps when explicit values are provided.
 */

import {
  type CollisionConflict,
  type CollisionLease,
  type CollisionTarget,
  type LoopBudgetConfig,
  type LoopBudgetUsage,
  type LoopIntegrationError,
  type LoopRunReport,
} from "@archcode/protocol";
import { z } from "zod";
import type { AnyToolDescriptor, ToolTraits } from "../tools/types";

// ────────────────────────────────────────────
//  Fixture factories
// ────────────────────────────────────────────

/**
 * Returns a deterministic project slug for test use.
 */
export function fixtureProjectSlug(): string {
  return "test-project";
}

let _nextSequence = 1;

/**
 * Returns a deterministic loop ID with optional override.
 */
export function fixtureLoopId(overrides?: { loopId?: string }): string {
  return overrides?.loopId ?? `test-loop-${_nextSequence++}`;
}

/**
 * Returns a deterministic run ID with optional override.
 */
export function fixtureRunId(overrides?: { runId?: string }): string {
  return overrides?.runId ?? `test-run-${_nextSequence++}`;
}

/**
 * Resets the internal sequence counter. Call in `beforeEach` or `afterAll`.
 */
export function resetSequenceCounter(): void {
  _nextSequence = 1;
}

/**
 * Returns a normalized LoopBudgetConfig with sensible defaults.
 *
 * All values can be overridden. Defaults match conservative local-report budgets:
 *   maxIterationsPerRun: 8
 *   softThresholdRatio: 0.8
 *   hardThresholdRatio: 1.0
 *   maxTokensPerRun: 120_000
 *   maxWallClockMsPerRun: 900_000 (15 min)
 *   maxRunsPerDay: 2
 *   maxEstimatedUsdPerRun: undefined (pricing unavailable)
 */
export function fixtureLoopBudgetConfig(
  overrides?: Partial<LoopBudgetConfig>,
): LoopBudgetConfig {
  return {
    maxIterationsPerRun: 8,
    softThresholdRatio: 0.8,
    hardThresholdRatio: 1.0,
    maxTokensPerRun: 120_000,
    maxWallClockMsPerRun: 900_000,
    maxRunsPerDay: 2,
    maxEstimatedUsdPerRun: undefined,
    ...overrides,
  };
}

/**
 * Returns a deterministic LoopBudgetUsage with defaults that represent moderate usage.
 *
 * Defaults:
 *   iterations: 4
 *   inputTokens: 12_000
 *   outputTokens: 6_000
 *   totalTokens: 18_000
 *   wallClockMs: 45_000
 *   runsToday: 1
 *   resetDateUtc: "2026-07-04"
 *   pricingUnavailable: true
 */
export function fixtureLoopBudgetUsage(
  overrides?: Partial<LoopBudgetUsage>,
): LoopBudgetUsage {
  return {
    iterations: 4,
    inputTokens: 12_000,
    outputTokens: 6_000,
    totalTokens: 18_000,
    wallClockMs: 45_000,
    runsToday: 1,
    resetDateUtc: "2026-07-04",
    pricingUnavailable: true,
    ...overrides,
  };
}

/**
 * Returns a deterministic PR CollisionTarget.
 */
export function fixtureCollisionTarget(
  overrides?: { type?: CollisionTarget["type"]; owner?: string; repo?: string; number?: number; branch?: string; path?: string },
): CollisionTarget {
  if (overrides?.type === "issue") {
    return { type: "issue", owner: overrides.owner ?? "test-owner", repo: overrides.repo ?? "test-repo", number: overrides.number ?? 42 };
  }
  if (overrides?.type === "branch") {
    return { type: "branch", owner: overrides.owner ?? "test-owner", repo: overrides.repo ?? "test-repo", branch: overrides.branch ?? "main" };
  }
  if (overrides?.type === "file") {
    return { type: "file", path: overrides.path ?? ".archcode/config.json" };
  }
  return { type: "pr", owner: overrides?.owner ?? "test-owner", repo: overrides?.repo ?? "test-repo", number: overrides?.number ?? 42 };
}

/**
 * Returns a deterministic CollisionLease.
 *
 * Defaults hold a PR #42 lease for `test-loop-1` / `test-run-1` with
 * priority 10 and a 5-minute expiry starting from `utcEpochMs`.
 */
export function fixtureCollisionLease(
  overrides?: Partial<CollisionLease>,
): CollisionLease {
  const now = utcEpochMs();
  return {
    targetKey: "github:test-owner/test-repo:pr:42",
    target: { type: "pr", owner: "test-owner", repo: "test-repo", number: 42 },
    loopId: "test-loop-1",
    runId: "test-run-1",
    priority: 10,
    createdAt: now,
    expiresAt: now + 300_000,
    ...overrides,
  };
}

/**
 * Returns a deterministic CollisionConflict from two leases.
 */
export function fixtureCollisionConflict(
  overrides?: Partial<CollisionConflict>,
): CollisionConflict {
  const now = utcEpochMs();
  const holder = fixtureCollisionLease();
  const conflictor: CollisionLease = {
    ...holder,
    loopId: "test-loop-2",
    runId: "test-run-2",
    priority: 5,
    createdAt: now + 10,
    expiresAt: now + 300_010,
  };
  return {
    targetKey: holder.targetKey,
    target: holder.target,
    conflictingLease: conflictor,
    detectedAt: now + 10,
    ...overrides,
  };
}

/**
 * Returns a deterministic LoopIntegrationError.
 */
export function fixtureIntegrationError(
  overrides?: Partial<LoopIntegrationError>,
): LoopIntegrationError {
  return {
    integrationId: "github",
    reason: "integration_auth_missing",
    message: "GitHub token is not configured",
    occurredAt: utcEpochMs(),
    ...overrides,
  };
}

/**
 * Returns a deterministic LoopRunReport.
 *
 * Defaults produce a succeeded session run with moderate budget usage
 * and collision/pr information filled.
 */
export function fixtureLoopRunReport(
  overrides?: Partial<LoopRunReport>,
): LoopRunReport {
  const now = utcEpochMs();
  return {
    runId: "test-run-1",
    loopId: "test-loop-1",
    status: "succeeded",
    trigger: "manual",
    startedAt: now,
    endedAt: now + 60_000,
    reason: "completed",
    ...overrides,
  };
}

/**
 * Returns a deterministic kill state object.
 */
export function fixtureKillState(
  overrides?: {
    globalKillActive?: boolean;
    activatedAt?: number;
    activatedBy?: string;
    reason?: string;
  },
): {
  globalKillActive: boolean;
  activatedAt?: number;
  activatedBy?: string;
  reason?: string;
} {
  return {
    globalKillActive: false,
    ...overrides,
  };
}

// ────────────────────────────────────────────
//  Fake clock (UTC-aware)
// ────────────────────────────────────────────

/**
 * A deterministic fake clock for scheduler/timer/budget tests.
 *
 * Supports `now()`, `set()`, and `utcDateKey()` for UTC date-based
 * daily budget reset tests.
 */
export class FakeClock {
  #value: number;

  constructor(value: number = utcEpochMs()) {
    this.#value = value;
  }

  /** Returns the current fake time as ms since epoch. */
  now(): number {
    return this.#value;
  }

  /** Sets the current fake time in ms since epoch. */
  set(value: number): void {
    this.#value = value;
  }

  /**
   * Returns the UTC date string for the current fake time in YYYY-MM-DD format.
   *
   * This is the key used for daily budget reset: when the UTC date changes,
   * the daily run counter resets.
   *
   * Example:
   *   clock.set(Date.UTC(2026, 6, 4, 23, 59, 59, 999))  → "2026-07-04"
   *   clock.set(Date.UTC(2026, 6, 5, 0, 0, 0, 0))        → "2026-07-05"
   */
  utcDateKey(): string {
    const d = new Date(this.#value);
    const year = d.getUTCFullYear();
    const month = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  /** Returns the current value as an ISO 8601 string (UTC). */
  toISOString(): string {
    return new Date(this.#value).toISOString();
  }
}

/**
 * Returns the UTC epoch reference (Jan 1 2026 00:00:00 UTC) in ms.
 * Used as default "zero" for deterministic timestamp tests.
 */
export function utcEpochMs(): number {
  return Date.UTC(2026, 0, 1, 0, 0, 0, 0);
}

// ────────────────────────────────────────────
//  Fake SessionExecutionManager adapter
// ────────────────────────────────────────────

export interface FakeSessionExecutionManagerCall {
  method: "abort" | "abortAndWait" | "abortAll" | "isRunning";
  workspaceRoot?: string;
  sessionId?: string;
  args: readonly unknown[];
  timestamp: number;
}

/**
 * A lightweight fake SessionExecutionManager adapter that records calls
 * and can be controlled with deterministic return values.
 *
 * Use this in tests that need to assert that budget/kill/collision guardrails
 * call the appropriate abort methods.
 */
export class FakeSessionExecutionManager {
  readonly #calls: FakeSessionExecutionManagerCall[] = [];
  #isRunningResult = false;
  #abortResult = true;
  #abortAndWaitResult: Promise<void> = Promise.resolve();
  #abortAllResult: Promise<void> = Promise.resolve();

  get calls(): readonly FakeSessionExecutionManagerCall[] {
    return this.#calls;
  }

  /** Configure what `isRunning` returns (default: false). */
  setIsRunning(value: boolean): void {
    this.#isRunningResult = value;
  }

  /** Configure what `abort` returns (default: true). */
  setAbortResult(value: boolean): void {
    this.#abortResult = value;
  }

  /** Returns calls with the given method name. */
  getCalls(method: FakeSessionExecutionManagerCall["method"]): FakeSessionExecutionManagerCall[] {
    return this.#calls.filter((c) => c.method === method);
  }

  /** Asserts that a specific method was called exactly N times. */
  assertCallCount(method: FakeSessionExecutionManagerCall["method"], expected: number): void {
    const count = this.getCalls(method).length;
    if (count !== expected) {
      throw new Error(
        `Expected ${method} to be called ${expected} time(s), but was called ${count} time(s)`,
      );
    }
  }

  /** Clears all recorded calls. */
  clear(): void {
    this.#calls.length = 0;
  }

  // --- Adapter interface ---

  abort(workspaceRoot: string, sessionId: string): boolean {
    this.#calls.push({
      method: "abort",
      workspaceRoot,
      sessionId,
      args: [workspaceRoot, sessionId],
      timestamp: Date.now(),
    });
    return this.#abortResult;
  }

  async abortAndWait(workspaceRoot: string, sessionId: string): Promise<void> {
    this.#calls.push({
      method: "abortAndWait",
      workspaceRoot,
      sessionId,
      args: [workspaceRoot, sessionId],
      timestamp: Date.now(),
    });
    return this.#abortAndWaitResult;
  }

  async abortAll(): Promise<void> {
    this.#calls.push({
      method: "abortAll",
      args: [],
      timestamp: Date.now(),
    });
    return this.#abortAllResult;
  }

  isRunning(workspaceRoot: string, sessionId: string): boolean {
    this.#calls.push({
      method: "isRunning",
      workspaceRoot,
      sessionId,
      args: [workspaceRoot, sessionId],
      timestamp: Date.now(),
    });
    return this.#isRunningResult;
  }
}

// ────────────────────────────────────────────
//  Fake ToolRegistry / tool descriptors
// ────────────────────────────────────────────

/**
 * Creates a minimal ToolDescriptor for test use.
 *
 * @param name - Tool name
 * @param readOnly - Whether the tool is read-only (default: true)
 * @param destructive - Whether the tool is destructive (default: false)
 */
export function makeTestToolDescriptor(
  name: string,
  readOnly: boolean = true,
  destructive: boolean = false,
): AnyToolDescriptor {
  const traits: ToolTraits = { readOnly, destructive, concurrencySafe: readOnly };
  return {
    name,
    description: `Test tool: ${name}`,
    inputSchema: z.object({}).strict(),
    traits,
    execute: async () => ({ output: `fake-${name}`, isError: false }),
  };
}

/**
 * Returns a set of read-only tool descriptors for test use.
 * Tools that exist in the default Loop `loop_local_report` profile.
 */
export function makeReadOnlyTestTools(): AnyToolDescriptor[] {
  const names = [
    "file_read",
    "grep",
    "glob",
    "git_status",
    "git_diff",
    "lsp_diagnostics",
    "lsp_goto_definition",
    "lsp_find_references",
    "lsp_symbols",
    "web_fetch",
    "todo_write",
    "ask_user",
    "wait_for_reminder",
    "background_output",
    "view_tool_output",
    "memory_read",
  ];
  return names.map((name) => makeTestToolDescriptor(name, true, false));
}

/**
 * Returns a set of effectful (non-read-only) tool descriptors for test use.
 * Tools that appear in `loop_local_maintenance` or `loop_goal_action` profiles.
 */
export function makeEffectfulTestTools(): AnyToolDescriptor[] {
  const names = [
    "file_write",
    "file_edit",
    "ast_grep_search",
    "ast_grep_replace",
    "bash",
    "delegate",
    "memory_write",
    "goal_manage",
  ];
  return names.map((name) => makeTestToolDescriptor(name, false, false));
}

/**
 * Returns a combined set of test tool descriptors.
 */
export function makeAllTestTools(): AnyToolDescriptor[] {
  return [...makeReadOnlyTestTools(), ...makeEffectfulTestTools()];
}

// ────────────────────────────────────────────
//  Fake GitHub fetch adapter
// ────────────────────────────────────────────

export interface FakeGitHubRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  timestamp: number;
}

export interface FakeGitHubPullRequest {
  number: number;
  title: string;
  state: "open" | "closed" | "merged";
  html_url: string;
  owner: string;
  repo: string;
  created_at: string;
  updated_at: string;
}

export interface FakeGitHubCheckRun {
  id: number;
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: string | null;
  started_at: string;
  completed_at: string | null;
}

export interface FakeGitHubWorkflowRun {
  id: number;
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: string | null;
  head_branch: string;
  html_url: string;
  created_at: string;
  updated_at: string;
}

export interface FakeGitHubIssueComment {
  id: number;
  body: string;
  user: string;
  created_at: string;
}

const TOKEN_REDACTION_MARKER = "[REDACTED:SECRET]";

/**
 * A fake GitHub fetch adapter that records request headers and returns
 * deterministic responses for PR, check, workflow, and comment endpoints.
 *
 * Token values passed to `withToken` or configured via `defaultToken` are
 * automatically redacted from thrown error messages and failure outputs.
 */
export class FakeGitHubFetchAdapter {
  readonly #requests: FakeGitHubRequest[] = [];
  #defaultToken: string = "";
  #responses: Map<string, unknown> = new Map();
  #throwOnNextCall: Error | null = null;

  /** Configure the default Bearer token for request assertions. */
  setDefaultToken(token: string): void {
    this.#defaultToken = token;
  }

  /** Returns the default token (used for assertions about redaction). */
  getDefaultToken(): string {
    return this.#defaultToken;
  }

  /** Returns all recorded requests. */
  get requests(): readonly FakeGitHubRequest[] {
    return this.#requests;
  }

  /** Clears recorded requests and custom responses. Does not clear the token. */
  clearRequests(): void {
    this.#requests.length = 0;
    this.#responses.clear();
  }

  /** Registers a custom response for a URL pattern (exact match). */
  setResponse(url: string, response: unknown): void {
    this.#responses.set(url, response);
  }

  /** Configures the next fetch call to throw an error. */
  setThrowOnNextCall(error: Error): void {
    this.#throwOnNextCall = error;
  }

  /**
   * Creates a fetch-compatible function that records all calls.
   */
  createFetch(): (url: string, init?: RequestInit) => Promise<Response> {
    const adapter = this;

    return async function fakeFetch(
      url: string,
      init?: RequestInit,
    ): Promise<Response> {
      const method = (init?.method as string) ?? "GET";
      const headers: Record<string, string> = {};
      if (init?.headers) {
        const h = init.headers as Record<string, string>;
        for (const key of Object.keys(h)) {
          headers[key] = h[key];
        }
      }

      adapter.#requests.push({
        url,
        method,
        headers,
        timestamp: Date.now(),
      });

      // If configured to throw, redact the token from the error message
      if (adapter.#throwOnNextCall) {
        const error = adapter.#throwOnNextCall;
        adapter.#throwOnNextCall = null;
        const redactedMessage = redactTokenValue(error.message, adapter.#defaultToken);
        throw new Error(redactedMessage);
      }

      // Check for a custom response
      const customResponse = adapter.#responses.get(url);
      if (customResponse !== undefined) {
        return new Response(JSON.stringify(customResponse), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      // Default: return an empty JSON response
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
  }

  // ─── Deterministic response builders ───

  makePullRequest(
    overrides?: Partial<FakeGitHubPullRequest>,
  ): FakeGitHubPullRequest {
    return {
      number: 42,
      title: "Test PR title",
      state: "open",
      html_url: "https://github.com/test-owner/test-repo/pull/42",
      owner: "test-owner",
      repo: "test-repo",
      created_at: "2026-07-04T10:00:00Z",
      updated_at: "2026-07-04T12:00:00Z",
      ...overrides,
    };
  }

  makeCheckRun(overrides?: Partial<FakeGitHubCheckRun>): FakeGitHubCheckRun {
    return {
      id: 1001,
      name: "test / lint",
      status: "completed",
      conclusion: "success",
      started_at: "2026-07-04T10:00:00Z",
      completed_at: "2026-07-04T10:05:00Z",
      ...overrides,
    };
  }

  makeWorkflowRun(
    overrides?: Partial<FakeGitHubWorkflowRun>,
  ): FakeGitHubWorkflowRun {
    return {
      id: 2001,
      name: "CI",
      status: "completed",
      conclusion: "success",
      head_branch: "main",
      html_url: "https://github.com/test-owner/test-repo/actions/runs/2001",
      created_at: "2026-07-04T10:00:00Z",
      updated_at: "2026-07-04T10:10:00Z",
      ...overrides,
    };
  }

  makeIssueComment(
    overrides?: Partial<FakeGitHubIssueComment>,
  ): FakeGitHubIssueComment {
    return {
      id: 3001,
      body: "This is a test comment",
      user: "test-user",
      created_at: "2026-07-04T10:00:00Z",
      ...overrides,
    };
  }
}

/**
 * Redacts a configured token value from a message string.
 * Returns the message unchanged if no token is configured or not found.
 */
export function redactTokenValue(message: string, token: string): string {
  if (!token || token.length === 0) return message;
  // Also redact common token prefixes to avoid partial leakage
  let result = message;
  const prefixes = ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"];
  for (const prefix of prefixes) {
    if (token.startsWith(prefix)) {
      // Also redact the prefix pattern since tokens can partially match
      result = result.replace(new RegExp(prefix + "\\S+", "gi"), TOKEN_REDACTION_MARKER);
    }
  }
  result = result.replace(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), TOKEN_REDACTION_MARKER);
  return result;
}

// ────────────────────────────────────────────
//  Run-log JSONL assertion utilities
// ────────────────────────────────────────────

/**
 * Parses a JSONL string into an array of parsed objects.
 * Skips empty/whitespace-only lines. Throws on malformed JSON.
 */
export function parseJsonl<T = unknown>(jsonl: string): T[] {
  const results: T[] = [];
  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      results.push(JSON.parse(trimmed) as T);
    } catch (err) {
      throw new Error(
        `Failed to parse JSONL line: ${trimmed.slice(0, 200)}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return results;
}

/**
 * Asserts that a JSONL string contains exactly `expectedCount` run reports
 * and returns the parsed array for further assertions.
 */
export function expectJsonlRunCount(jsonl: string, expectedCount: number): LoopRunReport[] {
  const reports = parseJsonl<LoopRunReport>(jsonl);
  if (reports.length !== expectedCount) {
    throw new Error(
      `Expected ${expectedCount} run report(s) in JSONL, but found ${reports.length}`,
    );
  }
  return reports;
}

/**
 * Finds run reports in JSONL matching a predicate function.
 */
export function findJsonlRuns(
  jsonl: string,
  predicate: (report: LoopRunReport) => boolean,
): LoopRunReport[] {
  const reports = parseJsonl<LoopRunReport>(jsonl);
  return reports.filter(predicate);
}
