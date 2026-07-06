import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import type {
  GitHubCiFailureSubject,
  GitHubCiPollingConnectorApi,
  GitHubPullRequest,
  GitHubReadCiFailuresForRefOptions,
  GitHubReadCiFailuresForRefResult,
  GitHubResponse,
} from "../integrations/github";
import { LoopJobQueue } from "./job-queue";
import { LoopPollStateManager } from "./poll-state";
import { LoopStateManager, type LoopConfig } from "./state";
import { FakeClock } from "./test-utils";
import { LoopTriggerPoller, type LocalBranchHead, type LoopLocalGitReader } from "./triggers";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "loop-triggers");

const baseConfig: LoopConfig = {
  title: "Trigger loop",
  schedule: { kind: "manual" },
  runKind: "session",
  mode: "report",
  approvalPolicy: "interactive",
  limits: { maxIterationsPerRun: 8 },
  taskPrompt: "Investigate trigger event",
};

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
  await mkdir(TMP_DIR, { recursive: true });
});

afterAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
});

describe("LoopTriggerPoller", () => {
  test("dedupes repeated branch SHAs with poll-state cursors", async () => {
    const { poller, queue, stateManager } = makeHarness({ localHead: { repoId: "archcode/workbench", branch: "main", sha: "abc123" } });
    const loop = await stateManager.create("project-a", { ...baseConfig, triggers: [{ kind: "on_commit", branch: "main" }] });

    const first = await poller.pollLoop(loop.loopId);
    const second = await poller.pollLoop(loop.loopId);

    expect(first.enqueued).toHaveLength(1);
    expect(second.enqueued).toHaveLength(0);
    expect(second.skipped).toContain("commit main@abc123 already observed");
    expect(await queue.list()).toHaveLength(1);
    expect((await queue.list())[0]?.dedupeKey).toBe(`${loop.loopId}:on_commit:commit:archcode/workbench:main`);
    expect((await queue.list())[0]?.eventSummaries[0]?.payloadSha).toBe("abc123");
  });

  test("coalesces a new branch SHA into the running on_commit branch job", async () => {
    const oldSha = "1111111111111111111111111111111111111111";
    const newSha = "2222222222222222222222222222222222222222";
    let currentSha = oldSha;
    const localGit: LoopLocalGitReader = {
      readBranchHead: async (branch) => ({ repoId: "archcode/workbench", branch: branch ?? "main", sha: currentSha }),
    };
    const { poller, queue, stateManager, clock } = makeHarness({ localGit });
    const loop = await stateManager.create("project-a", { ...baseConfig, triggers: [{ kind: "on_commit", branch: "main" }] });

    await poller.pollLoop(loop.loopId);
    const [runningCandidate] = await queue.list();
    await queue.update(runningCandidate!.jobId, { status: "running", startedAt: 1_500, leaseExpiresAt: 9_000, attempts: 1 });

    currentSha = newSha;
    clock.set(2_000);
    const duplicate = await poller.pollLoop(loop.loopId);
    const jobs = await queue.list();

    expect(duplicate.enqueued[0]).toMatchObject({ created: false, coalesced: true, rerunAfterCurrent: true });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      status: "running",
      rerunAfterCurrent: true,
      subjectKey: "commit:archcode/workbench:main",
      dedupeKey: `${loop.loopId}:on_commit:commit:archcode/workbench:main`,
      resolvedHeadSha: newSha,
    });
    expect(jobs[0]?.eventSummaries.map((entry) => entry.payloadSha)).toEqual([oldSha, newSha]);
    expect(jobs[0]?.eventSummaries.map((entry) => entry.summary)).toEqual([
      "Observed commit 111111111111 on main",
      "Observed commit 222222222222 on main",
    ]);
  });

  test("coalesces running duplicate trigger subjects into rerunAfterCurrent", async () => {
    const github = new FakeGitHub();
    const failure = makeCiFailure({ sha: "def456", context: "ci/build" });
    github.ciResults.push({ failures: [failure], health: { triggerKind: "on_ci_fail", status: "healthy", lastPollAt: 1_000, lastSuccessAt: 1_000 }, shouldEnqueue: true });
    github.ciResults.push({ failures: [failure], health: { triggerKind: "on_ci_fail", status: "healthy", lastPollAt: 2_000, lastSuccessAt: 2_000 }, shouldEnqueue: true });
    const { poller, queue, stateManager, clock } = makeHarness({ github });
    const loop = await stateManager.create("project-a", { ...baseConfig, triggers: [{ kind: "on_ci_fail", branch: "main" }] });

    await poller.pollLoop(loop.loopId);
    const [job] = await queue.list();
    await queue.update(job!.jobId, { status: "running", startedAt: 1_500, leaseExpiresAt: 9_000, attempts: 1 });
    clock.set(2_000);
    const duplicate = await poller.pollLoop(loop.loopId);

    expect(duplicate.enqueued[0]).toMatchObject({ created: false, coalesced: true, rerunAfterCurrent: true });
    expect(await queue.list()).toHaveLength(1);
    expect((await queue.list())[0]).toMatchObject({ status: "running", rerunAfterCurrent: true });
  });

  test("filters pull requests by configured base branch", async () => {
    const github = new FakeGitHub();
    github.prPages.push([
      makePr({ number: 1, baseRef: "develop", headSha: "aaa111" }),
      makePr({ number: 2, baseRef: "main", headSha: "bbb222" }),
    ]);
    github.prPages.push([makePr({ number: 2, baseRef: "main", headSha: "bbb222" })]);
    const { poller, queue, stateManager } = makeHarness({ github });
    const loop = await stateManager.create("project-a", { ...baseConfig, triggers: [{ kind: "on_pr", baseBranch: "main" }] });

    await poller.pollLoop(loop.loopId);

    const jobs = await queue.list();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.subjectKey).toBe("pr:archcode/workbench#2:bbb222");
  });

  test("honors assigned pull request scope", async () => {
    const github = new FakeGitHub();
    github.prPages.push([
      makePr({ number: 1, baseRef: "main", headSha: "aaa111" }),
      makePr({ number: 2, baseRef: "main", headSha: "bbb222", assignees: [{ login: "maintainer" }] }),
    ]);
    github.prPages.push([makePr({ number: 2, baseRef: "main", headSha: "bbb222", assignees: [{ login: "maintainer" }] })]);
    const { poller, queue, stateManager } = makeHarness({ github });
    const loop = await stateManager.create("project-a", { ...baseConfig, triggers: [{ kind: "on_pr", baseBranch: "main", prScope: "assigned" }] });

    const result = await poller.pollLoop(loop.loopId);

    expect(result.enqueued).toHaveLength(1);
    expect((await queue.list()).map((job) => job.subjectKey)).toEqual(["pr:archcode/workbench#2:bbb222"]);
  });

  test("does not treat authored pull request scope as open without actor identity", async () => {
    const github = new FakeGitHub();
    github.prPages.push([makePr({ number: 3, baseRef: "main", headSha: "ccc333", authorLogin: "someone" })]);
    const { poller, queue, stateManager } = makeHarness({ github });
    const loop = await stateManager.create("project-a", { ...baseConfig, triggers: [{ kind: "on_pr", baseBranch: "main", prScope: "authored" }] });

    const result = await poller.pollLoop(loop.loopId);

    expect(result.enqueued).toEqual([]);
    expect(await queue.list()).toEqual([]);
    expect(github.prCalls).toHaveLength(1);
  });

  test("honors review_requested pull request scope", async () => {
    const github = new FakeGitHub();
    github.prPages.push([
      makePr({ number: 1, baseRef: "main", headSha: "aaa111", assignees: [{ login: "maintainer" }] }),
      makePr({ number: 2, baseRef: "main", headSha: "bbb222", requestedReviewers: [{ login: "reviewer" }] }),
    ]);
    github.prPages.push([makePr({ number: 2, baseRef: "main", headSha: "bbb222", requestedReviewers: [{ login: "reviewer" }] })]);
    const { poller, queue, stateManager } = makeHarness({ github });
    const loop = await stateManager.create("project-a", { ...baseConfig, triggers: [{ kind: "on_pr", baseBranch: "main", prScope: "review_requested" }] });

    const result = await poller.pollLoop(loop.loopId);

    expect(result.enqueued).toHaveLength(1);
    expect((await queue.list()).map((job) => job.subjectKey)).toEqual(["pr:archcode/workbench#2:bbb222"]);
  });

  test("skips superseded pull request SHA after immediate revalidation", async () => {
    const github = new FakeGitHub();
    github.prPages.push([makePr({ number: 7, baseRef: "main", headSha: "oldsha" })]);
    github.prPages.push([makePr({ number: 7, baseRef: "main", headSha: "newsha" })]);
    const { poller, queue, stateManager, pollState } = makeHarness({ github });
    const loop = await stateManager.create("project-a", { ...baseConfig, triggers: [{ kind: "on_pr", baseBranch: "main" }] });

    const result = await poller.pollLoop(loop.loopId);
    const persisted = await pollState.read(loop.loopId);

    expect(result.enqueued).toEqual([]);
    expect(result.skipped).toContain("PR #7 was superseded or closed before enqueue");
    expect(await queue.list()).toEqual([]);
    expect(persisted.cursors["kind=on_pr|base=main"]?.pullRequests?.["7"]?.headSha).toBe("newsha");
  });

  test("enqueues one normalized CI failure job for deduped checks and statuses", async () => {
    const github = new FakeGitHub();
    github.ciResults.push({
      failures: [makeCiFailure({ source: "checks+statuses", checkRunIds: [501], statusIds: [701] })],
      health: { triggerKind: "on_ci_fail", status: "healthy", lastPollAt: 5_000, lastSuccessAt: 5_000 },
      shouldEnqueue: true,
    });
    const { poller, queue, stateManager } = makeHarness({ github, now: 5_000 });
    const loop = await stateManager.create("project-a", { ...baseConfig, triggers: [{ kind: "on_ci_fail", branch: "main", checkName: "ci/build" }] });

    const result = await poller.pollLoop(loop.loopId);

    const jobs = await queue.list();
    expect(result.enqueued).toHaveLength(1);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      triggerKind: "on_ci_fail",
      subjectKey: "ci:archcode/workbench:ci/build:abc123",
      dedupeKey: `${loop.loopId}:on_ci_fail:ci:archcode/workbench:ci/build:abc123`,
      resolvedHeadSha: "abc123",
    });
  });

  test("records GitHub backoff health and does not enqueue while no-token backoff is active", async () => {
    const github = new FakeGitHub();
    github.ciResults.push({
      failures: [],
      health: {
        triggerKind: "on_ci_fail",
        status: "degraded",
        lastPollAt: 10_000,
        lastError: "Missing GitHub token ghp_never_persist_this",
        retryAfterMs: 60_000,
      },
      shouldEnqueue: false,
    });
    const { poller, queue, stateManager, clock } = makeHarness({ github, now: 10_000 });
    const loop = await stateManager.create("project-a", { ...baseConfig, triggers: [{ kind: "on_ci_fail", branch: "main" }] });

    const first = await poller.pollLoop(loop.loopId);
    clock.set(20_000);
    const second = await poller.pollLoop(loop.loopId);
    const state = await stateManager.read(loop.loopId);

    expect(first.enqueued).toEqual([]);
    expect(second.enqueued).toEqual([]);
    expect(second.skipped).toContain("on_ci_fail backoff active");
    expect(await queue.list()).toEqual([]);
    expect(github.ciCalls).toHaveLength(1);
    expect(state.triggerHealth?.[0]).toMatchObject({ status: "blocked", retryAfterMs: 50_000 });
    expect(JSON.stringify(state.triggerHealth)).not.toContain("ghp_never_persist_this");
  });
});

function makeHarness(options: {
  readonly github?: FakeGitHub;
  readonly localHead?: LocalBranchHead;
  readonly localGit?: LoopLocalGitReader;
  readonly now?: number;
} = {}): {
  readonly clock: FakeClock;
  readonly stateManager: LoopStateManager;
  readonly queue: LoopJobQueue;
  readonly pollState: LoopPollStateManager;
  readonly poller: LoopTriggerPoller;
} {
  const clock = new FakeClock(options.now ?? 1_000);
  const stateManager = new LoopStateManager(TMP_DIR);
  const queue = new LoopJobQueue({ workspaceRoot: TMP_DIR, clock });
  const pollState = new LoopPollStateManager({ workspaceRoot: TMP_DIR, clock });
  const localGit: LoopLocalGitReader = options.localGit ?? {
    readBranchHead: async (branch) => options.localHead === undefined ? undefined : { ...options.localHead, branch: branch ?? options.localHead.branch },
  };
  const poller = new LoopTriggerPoller({
    workspaceRoot: TMP_DIR,
    stateManager,
    queue,
    pollState,
    github: (options.github ?? new FakeGitHub()) as unknown as GitHubCiPollingConnectorApi,
    repository: { owner: "archcode", repo: "workbench", defaultBranch: "main" },
    localGit,
    clock,
  });
  return { clock, stateManager, queue, pollState, poller };
}

class FakeGitHub {
  readonly prPages: GitHubPullRequest[][] = [];
  readonly ciResults: GitHubReadCiFailuresForRefResult[] = [];
  readonly prCalls: unknown[] = [];
  readonly ciCalls: unknown[] = [];

  async listOpenPullRequests(_owner: string, _repo: string, filters?: unknown): Promise<GitHubResponse<readonly GitHubPullRequest[]>> {
    this.prCalls.push(filters);
    return { data: this.prPages.shift() ?? [], status: 200 };
  }

  async readCiFailuresForRef(_owner: string, _repo: string, ref: string, options?: GitHubReadCiFailuresForRefOptions): Promise<GitHubReadCiFailuresForRefResult> {
    this.ciCalls.push({ ref, options });
    return this.ciResults.shift() ?? {
      failures: [],
      health: { triggerKind: "on_ci_fail", status: "healthy", lastPollAt: options?.lastPollAt ?? Date.now(), lastSuccessAt: options?.lastPollAt ?? Date.now() },
      shouldEnqueue: false,
    };
  }
}

function makePr(input: {
  readonly number: number;
  readonly baseRef: string;
  readonly headSha: string;
  readonly headRef?: string;
  readonly authorLogin?: string;
  readonly assignees?: readonly { readonly login: string }[];
  readonly requestedReviewers?: readonly { readonly login: string }[];
}): GitHubPullRequest {
  return {
    number: input.number,
    state: "open",
    title: `PR ${input.number}`,
    user: { login: input.authorLogin ?? `author-${input.number}` },
    head: { ref: input.headRef ?? `feature/${input.number}`, sha: input.headSha },
    base: { ref: input.baseRef },
    assignees: input.assignees,
    requested_reviewers: input.requestedReviewers,
    updated_at: `2026-07-05T00:00:0${input.number}Z`,
  };
}

function makeCiFailure(overrides: Partial<GitHubCiFailureSubject> = {}): GitHubCiFailureSubject {
  return {
    owner: "archcode",
    repo: "workbench",
    repoId: "archcode/workbench",
    branch: "main",
    sha: "abc123",
    context: "ci/build",
    source: "checks+statuses",
    checkRunIds: [],
    statusIds: [],
    checkSuiteIds: [],
    appSlugs: [],
    runAttempts: [],
    dedupeInputs: { owner: "archcode", repo: "workbench", sha: "abc123", context: "ci/build" },
    subjectKey: "ci:archcode/workbench:ci/build:abc123",
    dedupeKey: "archcode/workbench:abc123:ci/build",
    sourceSummaries: [],
    ...overrides,
  };
}
