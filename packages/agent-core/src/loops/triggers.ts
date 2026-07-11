import type {
  GitHubCiFailureSubject,
  GitHubCiPollingConnectorApi,
  GitHubPullRequest,
  GitHubReadCiFailuresForRefResult,
} from "../integrations/github";
import { IntegrationError, createGitHubConnector } from "../integrations/github";
import { createProcessRunner } from "../process/runner";
import type { ProcessRunner } from "../process/types";
import { REDACTION_MARKER } from "../tools/security";
import { canonicalTargetKey } from "./collision-ledger";
import { LoopJobQueue, type EnqueueLoopJobResult } from "./job-queue";
import { LoopPollStateManager, type LoopPollCursorEntry } from "./poll-state";
import type { LoopState, LoopStateManager, LoopTriggerHealth, LoopTriggerSpec } from "./state";

export interface LoopTriggerPollerClock {
  now(): number;
}

export interface LoopTriggerRepository {
  readonly owner: string;
  readonly repo: string;
  readonly defaultBranch?: string;
}

export interface LocalBranchHead {
  readonly repoId: string;
  readonly branch: string;
  readonly sha: string;
}

interface GitHubPullRequestScopeFields {
  readonly assignee?: GitHubUserLike | null;
  readonly assignees?: readonly (GitHubUserLike | null)[];
  readonly requested_reviewers?: readonly (GitHubUserLike | null)[];
  readonly requested_teams?: readonly unknown[];
}

interface GitHubUserLike {
  readonly login?: string;
}

export interface LoopLocalGitReader {
  readBranchHead(branch?: string): Promise<LocalBranchHead | undefined>;
}

export interface LoopTriggerPollerOptions {
  readonly workspaceRoot: string;
  readonly stateManager: LoopStateManager;
  readonly queue: LoopJobQueue;
  readonly pollState?: LoopPollStateManager;
  readonly github?: GitHubCiPollingConnectorApi;
  readonly repository?: LoopTriggerRepository;
  readonly localGit?: LoopLocalGitReader;
  readonly processRunner?: ProcessRunner;
  readonly clock?: LoopTriggerPollerClock;
}

export interface LoopTriggerPollResult {
  readonly loopId: string;
  readonly checked: number;
  readonly enqueued: readonly EnqueueLoopJobResult[];
  readonly skipped: readonly string[];
  readonly health: readonly LoopTriggerHealth[];
}

const systemClock: LoopTriggerPollerClock = {
  now: () => Date.now(),
};

export class LoopTriggerPoller {
  readonly #stateManager: LoopStateManager;
  readonly #queue: LoopJobQueue;
  readonly #pollState: LoopPollStateManager;
  readonly #github: GitHubCiPollingConnectorApi;
  readonly #repository?: LoopTriggerRepository;
  readonly #localGit: LoopLocalGitReader;
  readonly #clock: LoopTriggerPollerClock;

  constructor(options: LoopTriggerPollerOptions) {
    this.#stateManager = options.stateManager;
    this.#queue = options.queue;
    this.#clock = options.clock ?? systemClock;
    this.#pollState = options.pollState ?? new LoopPollStateManager({ workspaceRoot: options.workspaceRoot, clock: this.#clock });
    this.#github = options.github ?? createGitHubConnector();
    this.#repository = options.repository;
    this.#localGit = options.localGit ?? new GitCliLocalGitReader(options.workspaceRoot, options.processRunner);
  }

  async pollLoop(loopId: string): Promise<LoopTriggerPollResult> {
    return await this.pollLoopState(await this.#stateManager.read(loopId));
  }

  async pollLoopState(loop: LoopState): Promise<LoopTriggerPollResult> {
    if (loop.status !== "active") {
      return { loopId: loop.loopId, checked: 0, enqueued: [], skipped: [`Loop is ${loop.status}`], health: loop.triggerHealth ?? [] };
    }

    const triggers = loop.config.triggers ?? [];
    const enqueued: EnqueueLoopJobResult[] = [];
    const skipped: string[] = [];
    const health: LoopTriggerHealth[] = [];

    for (const trigger of triggers) {
      const result = await this.pollTrigger(loop, trigger);
      enqueued.push(...result.enqueued);
      skipped.push(...result.skipped);
      if (result.health !== undefined) health.push(result.health);
    }

    return { loopId: loop.loopId, checked: triggers.length, enqueued, skipped, health };
  }

  private async pollTrigger(loop: LoopState, trigger: LoopTriggerSpec): Promise<{ enqueued: EnqueueLoopJobResult[]; skipped: string[]; health?: LoopTriggerHealth }> {
    const cursorKey = cursorKeyForTrigger(trigger);
    const cursor = (await this.#pollState.read(loop.loopId)).cursors[cursorKey];
    const backoffHealth = await this.backoffHealth(loop, trigger, cursor);
    if (backoffHealth !== undefined) return { enqueued: [], skipped: [`${trigger.kind} backoff active`], health: backoffHealth };

    if (trigger.kind === "on_commit") return await this.pollCommit(loop, trigger, cursorKey, cursor);
    if (trigger.kind === "on_pr") return await this.pollPullRequests(loop, trigger, cursorKey, cursor);
    return await this.pollCiFailures(loop, trigger, cursorKey, cursor);
  }

  private async pollCommit(loop: LoopState, trigger: Extract<LoopTriggerSpec, { kind: "on_commit" }>, cursorKey: string, cursor: LoopPollCursorEntry | undefined): Promise<{ enqueued: EnqueueLoopJobResult[]; skipped: string[]; health: LoopTriggerHealth }> {
    const now = this.#clock.now();
    const head = await this.#localGit.readBranchHead(trigger.branch);
    if (head === undefined) {
      const health = await this.recordHealth(loop, trigger, { status: "degraded", lastCheckedAt: now, lastError: "Local git branch HEAD is unavailable." }, cursorKey, cursor);
      return { enqueued: [], skipped: ["local branch unavailable"], health };
    }

    const previousSha = cursor?.localBranchHeads?.[head.branch];
    const nextCursor = await this.#pollState.updateCursor(loop.loopId, cursorKey, (current) => ({
      cursorKey,
      kind: "on_commit",
      ...current,
      lastCheckedAt: now,
      lastSuccessAt: now,
      lastError: undefined,
      backoffUntilAt: undefined,
      localBranchHeads: { ...(current?.localBranchHeads ?? {}), [head.branch]: head.sha },
    }));
    const health = await this.recordHealth(loop, trigger, { status: "healthy", lastCheckedAt: now, lastSuccessAt: now }, cursorKey, nextCursor);
    if (previousSha === head.sha) return { enqueued: [], skipped: [`commit ${head.branch}@${shortSha(head.sha)} already observed`], health };

    const event = normalizeCommitTriggerEvent(loop.loopId, head);
    const result = await this.#queue.enqueue({
      loopId: loop.loopId,
      triggerKind: "on_commit",
      subjectKey: event.subjectKey,
      repoId: head.repoId,
      branch: head.branch,
      collisionTarget: { type: "branch", owner: event.owner, repo: event.repo, branch: head.branch },
      baseSha: head.sha,
      queuedAt: now,
      eventSummary: { summary: `Observed commit ${shortSha(head.sha)} on ${head.branch}`, source: "loop-trigger:on_commit", payloadSha: head.sha },
    });
    return { enqueued: [result], skipped: [], health };
  }

  private async pollPullRequests(loop: LoopState, trigger: Extract<LoopTriggerSpec, { kind: "on_pr" }>, cursorKey: string, cursor: LoopPollCursorEntry | undefined): Promise<{ enqueued: EnqueueLoopJobResult[]; skipped: string[]; health: LoopTriggerHealth }> {
    const now = this.#clock.now();
    const repo = this.requireRepository();
    try {
      const observed = await this.listOpenPullRequests(trigger);
      const enqueued: EnqueueLoopJobResult[] = [];
      const skipped: string[] = [];
      const nextPullRequests: NonNullable<LoopPollCursorEntry["pullRequests"]> = { ...(cursor?.pullRequests ?? {}) };

      for (const pr of observed) {
        const normalized = normalizePullRequestTriggerEvent(loop.loopId, repo, pr);
        if (normalized === undefined || !matchesPullRequestTrigger(pr, trigger)) continue;

        const validation = await this.validatePullRequest(trigger, normalized.number, normalized.headSha);
        if (validation.valid === false) {
          if (validation.latest !== undefined) {
            nextPullRequests[String(validation.latest.number)] = validation.latest;
          }
          skipped.push(`PR #${normalized.number} was superseded or closed before enqueue`);
          continue;
        }

        const previous = cursor?.pullRequests?.[String(normalized.number)];
        const changed = previous?.headSha !== normalized.headSha || previous?.updatedAt !== normalized.updatedAt;
        nextPullRequests[String(normalized.number)] = {
          number: normalized.number,
          headSha: normalized.headSha,
          updatedAt: normalized.updatedAt,
          observedAt: now,
        };
        if (!changed) {
          skipped.push(`PR #${normalized.number} already observed`);
          continue;
        }

        enqueued.push(await this.#queue.enqueue({
          loopId: loop.loopId,
          triggerKind: "on_pr",
          subjectKey: normalized.subjectKey,
          repoId: normalized.repoId,
          branch: normalized.headRef,
          collisionTarget: { type: "pr", owner: repo.owner, repo: repo.repo, number: normalized.number },
          collisionKey: canonicalTargetKey({ type: "pr", owner: repo.owner, repo: repo.repo, number: normalized.number }),
          baseSha: normalized.headSha,
          queuedAt: now,
          eventSummary: { summary: `Observed PR #${normalized.number} at ${shortSha(normalized.headSha)}`, source: "loop-trigger:on_pr" },
        }));
      }

      const nextCursor = await this.#pollState.updateCursor(loop.loopId, cursorKey, (current) => ({
        cursorKey,
        kind: "on_pr",
        ...current,
        lastCheckedAt: now,
        lastSuccessAt: now,
        lastError: undefined,
        backoffUntilAt: undefined,
        pullRequests: nextPullRequests,
      }));
      const health = await this.recordHealth(loop, trigger, { status: "healthy", lastCheckedAt: now, lastSuccessAt: now }, cursorKey, nextCursor);
      return { enqueued, skipped, health };
    } catch (error) {
      const health = await this.recordGitHubError(loop, trigger, cursorKey, cursor, error, now);
      return { enqueued: [], skipped: [`GitHub PR polling failed: ${health.lastError ?? "unknown error"}`], health };
    }
  }

  private async pollCiFailures(loop: LoopState, trigger: Extract<LoopTriggerSpec, { kind: "on_ci_fail" }>, cursorKey: string, cursor: LoopPollCursorEntry | undefined): Promise<{ enqueued: EnqueueLoopJobResult[]; skipped: string[]; health: LoopTriggerHealth }> {
    const now = this.#clock.now();
    const repo = this.requireRepository();
    const candidates: GitHubCiFailureSubject[] = [];
    const skipped: string[] = [];
    const nextFailures: NonNullable<LoopPollCursorEntry["ciFailures"]> = { ...(cursor?.ciFailures ?? {}) };

    const refs = await this.ciRefsFor(trigger);
    let lastResult: GitHubReadCiFailuresForRefResult | undefined;
    for (const ref of refs) {
      const result = await this.#github.readCiFailuresForRef(repo.owner, repo.repo, ref.ref, {
        branch: ref.branch,
        pullRequestNumber: ref.pullRequestNumber,
        pullRequestHeadRef: ref.pullRequestHeadRef,
        pullRequestBaseRef: ref.pullRequestBaseRef,
        checkName: trigger.checkName ?? trigger.workflowName,
        filter: "latest",
        lastPollAt: now,
        lastSuccessAt: cursor?.lastSuccessAt,
      });
      lastResult = result;
      if (result.health.status === "degraded") break;
      if (!result.shouldEnqueue) continue;

      for (const failure of result.failures) {
        if (!matchesCiFailureTrigger(failure, trigger)) continue;
        if (ref.pullRequestNumber !== undefined && !(await this.isPullRequestHeadCurrent(trigger, ref.pullRequestNumber, failure.sha))) {
          skipped.push(`CI failure for PR #${ref.pullRequestNumber} was superseded before enqueue`);
          continue;
        }
        nextFailures[failure.subjectKey] = {
          subjectKey: failure.subjectKey,
          sha: failure.sha,
          context: failure.context,
          observedAt: now,
        };
        candidates.push(failure);
      }
    }

    const retryAfterMs = lastResult?.health.retryAfterMs;
    const status = lastResult?.health.status === "degraded" ? "degraded" : "healthy";
    const nextCursor = await this.#pollState.updateCursor(loop.loopId, cursorKey, (current) => ({
      cursorKey,
      kind: "on_ci_fail",
      ...current,
      lastCheckedAt: now,
      lastSuccessAt: status === "healthy" ? now : current?.lastSuccessAt,
      lastError: status === "healthy" ? undefined : sanitizeHealthError(lastResult?.health.lastError),
      backoffUntilAt: retryAfterMs === undefined ? undefined : now + retryAfterMs,
      ciFailures: nextFailures,
    }));
    const health = await this.recordHealth(loop, trigger, {
      status,
      lastCheckedAt: now,
      lastSuccessAt: status === "healthy" ? now : cursor?.lastSuccessAt,
      lastError: status === "healthy" ? undefined : sanitizeHealthError(lastResult?.health.lastError),
      retryAfterMs,
    }, cursorKey, nextCursor);
    if (status !== "healthy") return { enqueued: [], skipped, health };

    const enqueued: EnqueueLoopJobResult[] = [];
    for (const failure of candidates) {
      enqueued.push(await this.enqueueCiFailure(loop.loopId, failure, now));
    }
    return { enqueued, skipped, health };
  }

  private async enqueueCiFailure(loopId: string, failure: GitHubCiFailureSubject, now: number): Promise<EnqueueLoopJobResult> {
    return await this.#queue.enqueue({
      loopId,
      triggerKind: "on_ci_fail",
      subjectKey: failure.subjectKey,
      repoId: failure.repoId,
      branch: failure.branch ?? failure.pullRequestHeadRef,
      collisionTarget: failure.pullRequestNumber === undefined
        ? (failure.branch === undefined ? undefined : { type: "branch", owner: failure.owner, repo: failure.repo, branch: failure.branch })
        : { type: "pr", owner: failure.owner, repo: failure.repo, number: failure.pullRequestNumber },
      baseSha: failure.sha,
      queuedAt: now,
      eventSummary: { summary: `Observed CI failure ${failure.context} at ${shortSha(failure.sha)}`, source: "loop-trigger:on_ci_fail" },
    });
  }

  private async ciRefsFor(trigger: Extract<LoopTriggerSpec, { kind: "on_ci_fail" }>): Promise<readonly CiRef[]> {
    const repo = this.requireRepository();
    if (trigger.baseBranch !== undefined) {
      const prs = await this.listOpenPullRequests({ baseBranch: trigger.baseBranch, branch: trigger.branch });
      return prs
        .map((pr): CiRef | undefined => {
          const headSha = pr.head?.sha;
          if (!headSha) return undefined;
          return {
            ref: headSha,
            branch: pr.head?.ref,
            pullRequestNumber: pr.number,
            pullRequestHeadRef: pr.head?.ref,
            pullRequestBaseRef: pr.base?.ref,
          };
        })
        .filter((ref): ref is CiRef => ref !== undefined);
    }
    const branch = trigger.branch ?? repo.defaultBranch ?? "main";
    return [{ ref: branch, branch }];
  }

  private async listOpenPullRequests(trigger: Pick<Extract<LoopTriggerSpec, { kind: "on_pr" }>, "branch" | "baseBranch">): Promise<readonly GitHubPullRequest[]> {
    const repo = this.requireRepository();
    const response = await this.#github.listOpenPullRequests(repo.owner, repo.repo, {
      base: trigger.baseBranch,
      head: trigger.branch === undefined ? undefined : `${repo.owner}:${trigger.branch}`,
      sort: "updated",
      direction: "desc",
      perPage: 100,
    });
    return response.data;
  }

  private async validatePullRequest(trigger: Extract<LoopTriggerSpec, { kind: "on_pr" }>, number: number, expectedSha: string): Promise<{ valid: true } | { valid: false; latest?: NonNullable<LoopPollCursorEntry["pullRequests"]>[string] }> {
    const now = this.#clock.now();
    const latest = (await this.listOpenPullRequests(trigger)).find((pr) => pr.number === number);
    if (latest === undefined || !matchesPullRequestTrigger(latest, trigger)) return { valid: false };
    const latestSha = latest.head?.sha;
    if (latestSha !== expectedSha) {
      return {
        valid: false,
        latest: latestSha === undefined ? undefined : {
          number,
          headSha: latestSha,
          updatedAt: latest.updated_at,
          observedAt: now,
        },
      };
    }
    return { valid: true };
  }

  private async isPullRequestHeadCurrent(trigger: Extract<LoopTriggerSpec, { kind: "on_ci_fail" }>, number: number, expectedSha: string): Promise<boolean> {
    const prs = await this.listOpenPullRequests({ baseBranch: trigger.baseBranch, branch: trigger.branch });
    const pr = prs.find((candidate) => candidate.number === number);
    return pr?.head?.sha === expectedSha;
  }

  private async backoffHealth(loop: LoopState, trigger: LoopTriggerSpec, cursor: LoopPollCursorEntry | undefined): Promise<LoopTriggerHealth | undefined> {
    const now = this.#clock.now();
    const backoffUntilAt = cursor?.backoffUntilAt;
    if (backoffUntilAt === undefined || backoffUntilAt <= now) return undefined;
    return await this.recordHealth(loop, trigger, {
      status: "blocked",
      lastCheckedAt: now,
      lastSuccessAt: cursor?.lastSuccessAt,
      lastError: cursor?.lastError,
      retryAfterMs: backoffUntilAt - now,
    }, cursorKeyForTrigger(trigger), cursor);
  }

  private async recordGitHubError(loop: LoopState, trigger: LoopTriggerSpec, cursorKey: string, cursor: LoopPollCursorEntry | undefined, error: unknown, now: number): Promise<LoopTriggerHealth> {
    const retryAfterMs = error instanceof IntegrationError ? error.rateLimit?.retryAfterMs : undefined;
    const message = sanitizeHealthError(error instanceof Error ? error.message : String(error));
    const nextCursor = await this.#pollState.updateCursor(loop.loopId, cursorKey, (current) => ({
      cursorKey,
      kind: trigger.kind,
      ...current,
      lastCheckedAt: now,
      lastError: message,
      backoffUntilAt: retryAfterMs === undefined ? current?.backoffUntilAt : now + retryAfterMs,
    }));
    return await this.recordHealth(loop, trigger, {
      status: retryAfterMs === undefined ? "degraded" : "blocked",
      lastCheckedAt: now,
      lastSuccessAt: cursor?.lastSuccessAt,
      lastError: message,
      retryAfterMs,
    }, cursorKey, nextCursor);
  }

  private async recordHealth(loop: LoopState, trigger: LoopTriggerSpec, health: Omit<LoopTriggerHealth, "triggerKind" | "cadenceMs">, _cursorKey: string, _cursor: LoopPollCursorEntry | undefined): Promise<LoopTriggerHealth> {
    const next: LoopTriggerHealth = {
      triggerKind: trigger.kind,
      cadenceMs: trigger.cadenceMs,
      ...health,
      lastError: sanitizeHealthError(health.lastError),
    };
    const latest = await this.#stateManager.read(loop.loopId);
    await this.#stateManager.update(loop.loopId, {
      triggerHealth: [
        ...(latest.triggerHealth ?? []).filter((entry) => entry.triggerKind !== trigger.kind),
        next,
      ],
    });
    return next;
  }

  private requireRepository(): LoopTriggerRepository {
    if (this.#repository === undefined) throw new Error("LoopTriggerPoller requires repository owner/repo for GitHub triggers.");
    return this.#repository;
  }
}

export function cursorKeyForTrigger(trigger: LoopTriggerSpec): string {
  const parts = [`kind=${trigger.kind}`];
  if ("branch" in trigger && trigger.branch !== undefined) parts.push(`branch=${trigger.branch}`);
  if ("baseBranch" in trigger && trigger.baseBranch !== undefined) parts.push(`base=${trigger.baseBranch}`);
  if ("prScope" in trigger && trigger.prScope !== undefined) parts.push(`scope=${trigger.prScope}`);
  if ("checkName" in trigger && trigger.checkName !== undefined) parts.push(`check=${trigger.checkName}`);
  if ("workflowName" in trigger && trigger.workflowName !== undefined) parts.push(`workflow=${trigger.workflowName}`);
  return parts.join("|");
}

export function normalizeCommitTriggerEvent(loopId: string, head: LocalBranchHead): { subjectKey: string; owner: string; repo: string } {
  const [owner = "local", repo = head.repoId] = head.repoId.split("/");
  void loopId;
  return {
    subjectKey: `commit:${head.repoId}:${head.branch}`,
    owner,
    repo,
  };
}

export function normalizePullRequestTriggerEvent(loopId: string, repo: LoopTriggerRepository, pr: GitHubPullRequest): { number: number; repoId: string; headRef: string; headSha: string; baseRef?: string; updatedAt?: string; subjectKey: string } | undefined {
  const headRef = pr.head?.ref;
  const headSha = pr.head?.sha;
  if (!headRef || !headSha) return undefined;
  const repoId = `${repo.owner}/${repo.repo}`;
  void loopId;
  return {
    number: pr.number,
    repoId,
    headRef,
    headSha,
    baseRef: pr.base?.ref,
    updatedAt: pr.updated_at,
    subjectKey: `pr:${repoId}#${pr.number}:${headSha}`,
  };
}

class GitCliLocalGitReader implements LoopLocalGitReader {
  readonly #git: ProcessRunner;

  constructor(
    private readonly workspaceRoot: string,
    processRunner: ProcessRunner = createProcessRunner(),
  ) {
    this.#git = processRunner;
  }

  async readBranchHead(branch?: string): Promise<LocalBranchHead | undefined> {
    const visibleBranch = branch ?? await this.git(["branch", "--show-current"]);
    if (!visibleBranch) return undefined;
    const ref = branch === undefined ? "HEAD" : `refs/heads/${branch}`;
    const sha = await this.git(["rev-parse", "--verify", ref]);
    if (!sha) return undefined;
    return { repoId: "local", branch: visibleBranch, sha };
  }

  private async git(args: readonly string[]): Promise<string | undefined> {
    const result = await this.#git.run({
      argv: ["git", ...args],
      cwd: this.workspaceRoot,
      env: { ...Bun.env, GIT_TERMINAL_PROMPT: "0" },
      maxOutputBytes: 64 * 1024,
    });
    if (result.kind !== "success") return undefined;
    const value = result.output.stdout.trim();
    return value === "" ? undefined : value;
  }
}

interface CiRef {
  readonly ref: string;
  readonly branch?: string;
  readonly pullRequestNumber?: number;
  readonly pullRequestHeadRef?: string;
  readonly pullRequestBaseRef?: string;
}

function matchesPullRequestTrigger(pr: GitHubPullRequest, trigger: Extract<LoopTriggerSpec, { kind: "on_pr" }>): boolean {
  if (pr.state !== undefined && pr.state !== "open") return false;
  if (trigger.baseBranch !== undefined && pr.base?.ref !== trigger.baseBranch) return false;
  if (trigger.branch !== undefined && pr.head?.ref !== trigger.branch) return false;
  return matchesPullRequestScope(pr, trigger.prScope);
}

function matchesPullRequestScope(pr: GitHubPullRequest, scope: Extract<LoopTriggerSpec, { kind: "on_pr" }>["prScope"]): boolean {
  if (scope === undefined || scope === "open") return true;
  const scoped = pr as GitHubPullRequest & GitHubPullRequestScopeFields;
  if (scope === "authored") return false;
  if (scope === "assigned") return scoped.assignee !== null && scoped.assignee !== undefined || (scoped.assignees ?? []).some((user) => user !== null && user?.login !== undefined);
  return (scoped.requested_reviewers ?? []).some((user) => user !== null && user?.login !== undefined) || (scoped.requested_teams ?? []).length > 0;
}

function matchesCiFailureTrigger(failure: GitHubCiFailureSubject, trigger: Extract<LoopTriggerSpec, { kind: "on_ci_fail" }>): boolean {
  if (trigger.branch !== undefined && failure.branch !== undefined && failure.branch !== trigger.branch && failure.pullRequestHeadRef !== trigger.branch) return false;
  if (trigger.baseBranch !== undefined && failure.pullRequestBaseRef !== undefined && failure.pullRequestBaseRef !== trigger.baseBranch) return false;
  const expectedContext = (trigger.checkName ?? trigger.workflowName)?.trim().toLowerCase();
  if (expectedContext !== undefined && failure.context !== expectedContext) return false;
  return true;
}

function sanitizeHealthError(message: string | undefined): string | undefined {
  if (message === undefined) return undefined;
  return message.replace(/(?:ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)\S+/gi, REDACTION_MARKER);
}

function shortSha(sha: string): string {
  return sha.slice(0, 12);
}
