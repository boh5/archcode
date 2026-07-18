import { HTTP_USER_AGENT } from "@archcode/protocol";
import {
  GithubIntegrationTokenError,
  type GithubIntegrationConfig,
  type ResolvedGithubIntegrationConfig,
  resolveGithubIntegrationConfig,
} from "../config";
import { REDACTION_MARKER as SECURITY_REDACTION_MARKER, redactString } from "../security";
import { BoundedByteBuffer } from "../utils/bounded-byte-buffer";

export const GITHUB_REST_API_VERSION = "2022-11-28" as const;
export const REDACTION_MARKER = SECURITY_REDACTION_MARKER;
const GITHUB_API_BASE_URL = "https://api.github.com";
/** Hard network/parse boundary; artifact policy is not an HTTP memory budget. */
export const MAX_GITHUB_RESPONSE_BYTES = 8 * 1024 * 1024;

export type IntegrationErrorCode =
  | "integration_auth_missing"
  | "integration_rate_limited"
  | "integration_not_found"
  | "integration_forbidden"
  | "integration_bad_response";

export type GitHubIntegrationId = "github" | "github_actions";

export interface GitHubRateLimitMetadata {
  readonly limit?: number;
  readonly remaining?: number;
  readonly used?: number;
  readonly resetEpochSeconds?: number;
  readonly resetAt?: string;
  readonly retryAfterMs?: number;
  readonly resource?: string;
}

export class IntegrationError extends Error {
  constructor(
    public readonly code: IntegrationErrorCode,
    message: string,
    options: {
      readonly integrationId?: GitHubIntegrationId;
      readonly status?: number;
      readonly method?: string;
      readonly url?: string;
      readonly rateLimit?: GitHubRateLimitMetadata;
      readonly cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = "IntegrationError";
    this.options = { ...options, cause: sanitizeErrorCause(options.cause, message) };
  }

  readonly options: {
    readonly integrationId?: GitHubIntegrationId;
    readonly status?: number;
    readonly method?: string;
    readonly url?: string;
    readonly rateLimit?: GitHubRateLimitMetadata;
    readonly cause?: unknown;
  };

  get integrationId(): GitHubIntegrationId {
    return this.options.integrationId ?? "github";
  }

  get status(): number | undefined {
    return this.options.status;
  }

  get method(): string | undefined {
    return this.options.method;
  }

  get url(): string | undefined {
    return this.options.url;
  }

  get rateLimit(): GitHubRateLimitMetadata | undefined {
    return this.options.rateLimit;
  }
}

export interface GitHubResponse<T> {
  readonly data: T;
  readonly status: number;
  readonly rateLimit?: GitHubRateLimitMetadata;
}

export interface GitHubTokenResolutionMetadata {
  readonly tokenSource?: string;
  readonly redactedToken: typeof REDACTION_MARKER;
}

export interface GitHubUser {
  readonly login?: string;
  readonly id?: number;
  readonly html_url?: string;
  readonly [key: string]: unknown;
}

export interface GitHubPullRequestRef {
  readonly ref?: string;
  readonly sha?: string;
  readonly repo?: Record<string, unknown> | null;
  readonly [key: string]: unknown;
}

export interface GitHubPullRequest {
  readonly number: number;
  readonly title?: string;
  readonly state?: string;
  readonly html_url?: string;
  readonly user?: GitHubUser | null;
  readonly head?: GitHubPullRequestRef;
  readonly base?: GitHubPullRequestRef;
  readonly created_at?: string;
  readonly updated_at?: string;
  readonly [key: string]: unknown;
}

export interface GitHubPullRequestFile {
  readonly sha?: string;
  readonly filename: string;
  readonly status?: string;
  readonly additions?: number;
  readonly deletions?: number;
  readonly changes?: number;
  readonly patch?: string;
  readonly blob_url?: string;
  readonly raw_url?: string;
  readonly contents_url?: string;
  readonly [key: string]: unknown;
}

export interface GitHubIssueComment {
  readonly id: number;
  readonly body?: string;
  readonly user?: GitHubUser | null;
  readonly html_url?: string;
  readonly created_at?: string;
  readonly updated_at?: string;
  readonly [key: string]: unknown;
}

export interface GitHubWorkflowRun {
  readonly id: number;
  readonly name?: string;
  readonly status?: string;
  readonly conclusion?: string | null;
  readonly head_branch?: string | null;
  readonly head_sha?: string;
  readonly html_url?: string;
  readonly created_at?: string;
  readonly updated_at?: string;
  readonly [key: string]: unknown;
}

export interface GitHubWorkflowRunsPage {
  readonly total_count?: number;
  readonly workflow_runs: readonly GitHubWorkflowRun[];
  readonly [key: string]: unknown;
}

export interface GitHubCheckRunPullRequest {
  readonly number?: number;
  readonly head?: GitHubPullRequestRef;
  readonly base?: GitHubPullRequestRef;
  readonly [key: string]: unknown;
}

export interface GitHubCheckRun {
  readonly id: number;
  readonly name: string;
  readonly head_sha: string;
  readonly status?: string;
  readonly conclusion?: string | null;
  readonly html_url?: string;
  readonly details_url?: string;
  readonly started_at?: string;
  readonly completed_at?: string | null;
  readonly check_suite?: { readonly id?: number; readonly [key: string]: unknown } | null;
  readonly app?: { readonly id?: number; readonly slug?: string; readonly [key: string]: unknown } | null;
  readonly output?: { readonly title?: string | null; readonly summary?: string | null; readonly [key: string]: unknown } | null;
  readonly pull_requests?: readonly GitHubCheckRunPullRequest[];
  readonly run_attempt?: number;
  readonly [key: string]: unknown;
}

export interface GitHubCheckRunsPage {
  readonly total_count?: number;
  readonly check_runs: readonly GitHubCheckRun[];
  readonly [key: string]: unknown;
}

export interface GitHubCommitStatus {
  readonly id: number;
  readonly state: string;
  readonly context: string;
  readonly description?: string | null;
  readonly target_url?: string | null;
  readonly created_at?: string;
  readonly updated_at?: string;
  readonly [key: string]: unknown;
}

export interface GitHubCombinedStatus {
  readonly state: string;
  readonly sha: string;
  readonly total_count?: number;
  readonly statuses: readonly GitHubCommitStatus[];
  readonly [key: string]: unknown;
}

export interface GitHubListPullRequestsFilters {
  readonly state?: "open" | "closed" | "all";
  readonly head?: string;
  readonly base?: string;
  readonly sort?: "created" | "updated" | "popularity" | "long-running";
  readonly direction?: "asc" | "desc";
  readonly perPage?: number;
  readonly page?: number;
}

export type GitHubListOpenPullRequestsFilters = Omit<GitHubListPullRequestsFilters, "state">;

export interface GitHubListWorkflowRunsFilters {
  readonly actor?: string;
  readonly branch?: string;
  readonly event?: string;
  readonly status?:
    | "completed"
    | "action_required"
    | "cancelled"
    | "failure"
    | "neutral"
    | "skipped"
    | "stale"
    | "success"
    | "timed_out"
    | "in_progress"
    | "queued"
    | "requested"
    | "waiting"
    | "pending";
  readonly created?: string;
  readonly headSha?: string;
  readonly perPage?: number;
  readonly page?: number;
}

export interface GitHubListCheckRunsForRefFilters {
  readonly checkName?: string;
  readonly status?:
    | "queued"
    | "in_progress"
    | "completed"
    | "waiting"
    | "requested"
    | "pending";
  readonly filter?: "latest" | "all";
  readonly appId?: number;
  readonly perPage?: number;
  readonly page?: number;
}

export interface GitHubCiFailureDedupeInputs {
  readonly owner: string;
  readonly repo: string;
  readonly sha: string;
  readonly context: string;
}

export interface GitHubCiFailureSourceSummary {
  readonly source: "checks" | "statuses";
  readonly context: string;
  readonly checkRunId?: number;
  readonly statusId?: number;
  readonly checkSuiteId?: number;
  readonly appSlug?: string;
  readonly status?: string;
  readonly conclusion?: string | null;
  readonly state?: string;
  readonly runAttempt?: number;
  readonly title?: string;
  readonly summary?: string;
  readonly description?: string;
  readonly targetUrl?: string;
}

export interface GitHubCiFailureSubject {
  readonly owner: string;
  readonly repo: string;
  readonly repoId: string;
  readonly branch?: string;
  readonly pullRequestNumber?: number;
  readonly pullRequestHeadRef?: string;
  readonly pullRequestBaseRef?: string;
  readonly sha: string;
  readonly context: string;
  readonly checkName?: string;
  readonly statusContext?: string;
  readonly source: "checks" | "statuses" | "checks+statuses";
  readonly status?: string;
  readonly conclusion?: string | null;
  readonly state?: string;
  readonly checkRunIds: readonly number[];
  readonly statusIds: readonly number[];
  readonly checkSuiteIds: readonly number[];
  readonly appSlugs: readonly string[];
  readonly runAttempts: readonly number[];
  readonly dedupeInputs: GitHubCiFailureDedupeInputs;
  readonly subjectKey: string;
  readonly dedupeKey: string;
  readonly sourceSummaries: readonly GitHubCiFailureSourceSummary[];
}

export interface GitHubCiFailureNormalizationInput {
  readonly owner: string;
  readonly repo: string;
  readonly branch?: string;
  readonly pullRequestNumber?: number;
  readonly pullRequestHeadRef?: string;
  readonly pullRequestBaseRef?: string;
  readonly sha?: string;
  readonly checks?: GitHubCheckRunsPage;
  readonly combinedStatus?: GitHubCombinedStatus;
}

export interface GitHubCiPollingHealth {
  readonly triggerKind: "on_ci_fail";
  readonly status: "healthy" | "degraded";
  readonly lastPollAt: number;
  readonly lastSuccessAt?: number;
  readonly lastError?: string;
  readonly retryAfterMs?: number;
  readonly rateLimitRemaining?: number;
}

export interface GitHubReadCiFailuresForRefOptions extends GitHubListCheckRunsForRefFilters {
  readonly branch?: string;
  readonly pullRequestNumber?: number;
  readonly pullRequestHeadRef?: string;
  readonly pullRequestBaseRef?: string;
  readonly lastPollAt?: number;
  readonly lastSuccessAt?: number;
}

export interface GitHubReadCiFailuresForRefResult {
  readonly failures: readonly GitHubCiFailureSubject[];
  readonly health: GitHubCiPollingHealth;
  readonly shouldEnqueue: boolean;
}

export type GitHubFetchAdapter = typeof fetch;

export interface GitHubIntegrationProvider {
  resolveTokenMetadata(): GitHubTokenResolutionMetadata;
  requestJson<T>(request: GitHubRequest<T>): Promise<GitHubResponse<T>>;
  redactMessage(message: string): string;
  redactValue<T>(value: T): T;
}

export interface GitHubConnectorApi {
  getPullRequest(owner: string, repo: string, number: number): Promise<GitHubResponse<GitHubPullRequest>>;
  listPullRequests(
    owner: string,
    repo: string,
    filters?: GitHubListPullRequestsFilters,
  ): Promise<GitHubResponse<readonly GitHubPullRequest[]>>;
  getPullRequestFiles(
    owner: string,
    repo: string,
    number: number,
    options?: GitHubPaginationOptions,
  ): Promise<GitHubResponse<readonly GitHubPullRequestFile[]>>;
  listIssueComments(
    owner: string,
    repo: string,
    issueNumber: number,
    options?: GitHubPaginationOptions,
  ): Promise<GitHubResponse<readonly GitHubIssueComment[]>>;
  createIssueComment(
    owner: string,
    repo: string,
    issueNumber: number,
    body: string,
  ): Promise<GitHubResponse<GitHubIssueComment>>;
  listWorkflowRuns(
    owner: string,
    repo: string,
    filters?: GitHubListWorkflowRunsFilters,
  ): Promise<GitHubResponse<GitHubWorkflowRunsPage>>;
  getWorkflowRun(owner: string, repo: string, runId: number): Promise<GitHubResponse<GitHubWorkflowRun>>;
  rerunWorkflowRun(owner: string, repo: string, runId: number): Promise<GitHubResponse<void>>;
}

export interface GitHubCiPollingConnectorApi extends GitHubConnectorApi {
  listOpenPullRequests(
    owner: string,
    repo: string,
    filters?: GitHubListOpenPullRequestsFilters,
  ): Promise<GitHubResponse<readonly GitHubPullRequest[]>>;
  listCheckRunsForRef(
    owner: string,
    repo: string,
    ref: string,
    filters?: GitHubListCheckRunsForRefFilters,
  ): Promise<GitHubResponse<GitHubCheckRunsPage>>;
  getCombinedStatusForRef(owner: string, repo: string, ref: string): Promise<GitHubResponse<GitHubCombinedStatus>>;
  readCiFailuresForRef(
    owner: string,
    repo: string,
    ref: string,
    options?: GitHubReadCiFailuresForRefOptions,
  ): Promise<GitHubReadCiFailuresForRefResult>;
}

export interface GitHubPaginationOptions {
  readonly perPage?: number;
  readonly page?: number;
}

export interface GitHubRestProviderOptions {
  readonly config?: GithubIntegrationConfig;
  readonly resolvedConfig?: ResolvedGithubIntegrationConfig;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchAdapter?: GitHubFetchAdapter;
}

export interface GitHubConnectorOptions extends GitHubRestProviderOptions {
  readonly provider?: GitHubIntegrationProvider;
}

export interface GitHubRequest<T> {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly query?: Record<string, string | number | undefined>;
  readonly body?: unknown;
  readonly expectedStatus?: readonly number[];
  readonly integrationId?: GitHubIntegrationId;
  readonly validate: (value: unknown) => T;
}

interface ResolvedTokenState {
  readonly token: string;
  readonly tokenSource?: string;
}

const GITHUB_TOKEN_PREFIXES = ["ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_"];

export class GitHubRestProvider implements GitHubIntegrationProvider {
  readonly #config?: GithubIntegrationConfig;
  readonly #resolvedConfig?: ResolvedGithubIntegrationConfig;
  readonly #env: NodeJS.ProcessEnv;
  readonly #fetchAdapter: GitHubFetchAdapter;
  #lastToken = "";

  constructor(options: GitHubRestProviderOptions = {}) {
    this.#config = options.config;
    this.#resolvedConfig = options.resolvedConfig;
    this.#env = options.env ?? process.env;
    this.#fetchAdapter = options.fetchAdapter ?? globalThis.fetch.bind(globalThis);
  }

  resolveTokenMetadata(): GitHubTokenResolutionMetadata {
    const tokenState = this.#resolveToken();
    this.#lastToken = tokenState.token;
    return {
      tokenSource: tokenState.tokenSource,
      redactedToken: REDACTION_MARKER,
    };
  }

  async requestJson<T>(request: GitHubRequest<T>): Promise<GitHubResponse<T>> {
    const tokenState = this.#resolveToken();
    this.#lastToken = tokenState.token;

    const method = request.method;
    const url = this.#buildUrl(request.path, request.query);
    const displayUrl = stripUrlQuery(url);
    let response: Response;

    try {
      response = await this.#fetchAdapter(url, {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${tokenState.token}`,
          "Content-Type": "application/json",
          "User-Agent": HTTP_USER_AGENT,
          "X-GitHub-Api-Version": GITHUB_REST_API_VERSION,
        },
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
      });
    } catch (error) {
      throw this.#error(
        "integration_bad_response",
        "GitHub request failed.",
        { integrationId: request.integrationId, method, url: displayUrl, cause: error },
      );
    }

    const rateLimit = extractRateLimitMetadata(response.headers);
    const bodyText = await readResponseText(response, this.#lastToken);

    if (!response.ok) {
      throw this.#httpError({
        response,
        request,
        url: displayUrl,
        method,
        bodyText,
        rateLimit,
      });
    }

    const expectedStatus = request.expectedStatus ?? [200];
    if (!expectedStatus.includes(response.status)) {
      throw this.#error(
        "integration_bad_response",
        `GitHub returned unexpected status ${response.status} for ${method} ${displayUrl}.`,
        { integrationId: request.integrationId, status: response.status, method, url: displayUrl, rateLimit },
      );
    }

    const data = this.#parseSuccessBody(bodyText, request, response.status, method, displayUrl, rateLimit);

    return {
      data: this.redactValue(data),
      status: response.status,
      rateLimit,
    };
  }

  redactMessage(message: string): string {
    return redactString(redactGitHubTokenValue(message, this.#lastToken));
  }

  redactValue<T>(value: T): T {
    return redactGitHubTokenValueInValue(value, this.#lastToken);
  }

  #resolveToken(): ResolvedTokenState {
    let resolved: ResolvedGithubIntegrationConfig;
    try {
      resolved = this.#resolvedConfig ?? resolveGithubIntegrationConfig(this.#config, this.#env);
    } catch (error) {
      if (error instanceof GithubIntegrationTokenError) {
        throw this.#error(
          "integration_auth_missing",
          `Missing GitHub token. Set integrations.github.tokenEnv, GITHUB_TOKEN, or GH_TOKEN. Attempted env names: ${error.attemptedEnvNames.join(", ")}.`,
          { cause: error },
        );
      }

      throw this.#error(
        "integration_auth_missing",
        `Missing GitHub token. ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }

    if (!resolved.enabled || !resolved.token) {
      throw this.#error(
        "integration_auth_missing",
        "GitHub integration is disabled or has no token. Configure integrations.github and set integrations.github.tokenEnv, GITHUB_TOKEN, or GH_TOKEN.",
      );
    }

    return { token: resolved.token, tokenSource: resolved.tokenSource };
  }

  #buildUrl(path: string, query?: Record<string, string | number | undefined>): string {
    const url = new URL(path, GITHUB_API_BASE_URL);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
    return url.href;
  }

  #parseSuccessBody<T>(
    bodyText: string,
    request: GitHubRequest<T>,
    status: number,
    method: string,
    url: string,
    rateLimit?: GitHubRateLimitMetadata,
  ): T {
    if (bodyText.trim() === "") {
      try {
        return request.validate(undefined);
      } catch (error) {
        throw this.#error(
          "integration_bad_response",
          `GitHub returned an empty response body for ${method} ${url}.`,
          { integrationId: request.integrationId, status, method, url, rateLimit, cause: error },
        );
      }
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch (error) {
      throw this.#error(
        "integration_bad_response",
        `GitHub returned invalid JSON for ${method} ${url}.`,
        { integrationId: request.integrationId, status, method, url, rateLimit, cause: error },
      );
    }

    try {
      return request.validate(parsed);
    } catch (error) {
      throw this.#error(
        "integration_bad_response",
        `GitHub returned an unexpected response shape for ${method} ${url}: ${error instanceof Error ? error.message : String(error)}.`,
        { integrationId: request.integrationId, status, method, url, rateLimit, cause: error },
      );
    }
  }

  #httpError(input: {
    readonly response: Response;
    readonly request: GitHubRequest<unknown>;
    readonly url: string;
    readonly method: string;
    readonly bodyText: string;
    readonly rateLimit?: GitHubRateLimitMetadata;
  }): IntegrationError {
    const { response, request, url, method, bodyText, rateLimit } = input;
    const responseMessage = parseGitHubErrorMessage(bodyText);
    const suffix = responseMessage ? `: ${responseMessage}` : "";

    if (isRateLimitedResponse(response, responseMessage, rateLimit)) {
      return this.#error(
        "integration_rate_limited",
        `GitHub rate limit reached for ${method} ${url}${suffix}.`,
        { integrationId: request.integrationId, status: response.status, method, url, rateLimit },
      );
    }

    if (response.status === 404) {
      return this.#error(
        "integration_not_found",
        `GitHub resource not found for ${method} ${url}${suffix}.`,
        { integrationId: request.integrationId, status: response.status, method, url, rateLimit },
      );
    }

    if (response.status === 401 || response.status === 403) {
      return this.#error(
        "integration_forbidden",
        `GitHub request forbidden for ${method} ${url}${suffix}.`,
        { integrationId: request.integrationId, status: response.status, method, url, rateLimit },
      );
    }

    return this.#error(
      "integration_bad_response",
      `GitHub returned HTTP ${response.status} for ${method} ${url}${suffix}.`,
      { integrationId: request.integrationId, status: response.status, method, url, rateLimit },
    );
  }

  #error(
    code: IntegrationErrorCode,
    message: string,
    options: ConstructorParameters<typeof IntegrationError>[2] = {},
  ): IntegrationError {
    return new IntegrationError(code, this.redactMessage(message), options);
  }
}

export class GitHubConnector implements GitHubConnectorApi {
  readonly #provider: GitHubIntegrationProvider;

  constructor(options: GitHubConnectorOptions = {}) {
    this.#provider = options.provider ?? new GitHubRestProvider(options);
  }

  getPullRequest(owner: string, repo: string, number: number): Promise<GitHubResponse<GitHubPullRequest>> {
    return this.#provider.requestJson({
      method: "GET",
      path: repoPath(owner, repo, `pulls/${number}`),
      validate: expectPullRequest,
    });
  }

  listPullRequests(
    owner: string,
    repo: string,
    filters: GitHubListPullRequestsFilters = {},
  ): Promise<GitHubResponse<readonly GitHubPullRequest[]>> {
    return this.#provider.requestJson({
      method: "GET",
      path: repoPath(owner, repo, "pulls"),
      query: {
        state: filters.state,
        head: filters.head,
        base: filters.base,
        sort: filters.sort,
        direction: filters.direction,
        per_page: filters.perPage,
        page: filters.page,
      },
      validate: expectPullRequestArray,
    });
  }

  listOpenPullRequests(
    owner: string,
    repo: string,
    filters: GitHubListOpenPullRequestsFilters = {},
  ): Promise<GitHubResponse<readonly GitHubPullRequest[]>> {
    return this.listPullRequests(owner, repo, { ...filters, state: "open" });
  }

  getPullRequestFiles(
    owner: string,
    repo: string,
    number: number,
    options: GitHubPaginationOptions = {},
  ): Promise<GitHubResponse<readonly GitHubPullRequestFile[]>> {
    return this.#provider.requestJson({
      method: "GET",
      path: repoPath(owner, repo, `pulls/${number}/files`),
      query: { per_page: options.perPage, page: options.page },
      validate: expectPullRequestFileArray,
    });
  }

  listIssueComments(
    owner: string,
    repo: string,
    issueNumber: number,
    options: GitHubPaginationOptions = {},
  ): Promise<GitHubResponse<readonly GitHubIssueComment[]>> {
    return this.#provider.requestJson({
      method: "GET",
      path: repoPath(owner, repo, `issues/${issueNumber}/comments`),
      query: { per_page: options.perPage, page: options.page },
      validate: expectIssueCommentArray,
    });
  }

  createIssueComment(
    owner: string,
    repo: string,
    issueNumber: number,
    body: string,
  ): Promise<GitHubResponse<GitHubIssueComment>> {
    return this.#provider.requestJson({
      method: "POST",
      path: repoPath(owner, repo, `issues/${issueNumber}/comments`),
      body: { body },
      expectedStatus: [201],
      validate: expectIssueComment,
    });
  }

  listWorkflowRuns(
    owner: string,
    repo: string,
    filters: GitHubListWorkflowRunsFilters = {},
  ): Promise<GitHubResponse<GitHubWorkflowRunsPage>> {
    return this.#provider.requestJson({
      method: "GET",
      path: repoPath(owner, repo, "actions/runs"),
      query: {
        actor: filters.actor,
        branch: filters.branch,
        event: filters.event,
        status: filters.status,
        created: filters.created,
        head_sha: filters.headSha,
        per_page: filters.perPage,
        page: filters.page,
      },
      integrationId: "github_actions",
      validate: expectWorkflowRunsPage,
    });
  }

  getWorkflowRun(owner: string, repo: string, runId: number): Promise<GitHubResponse<GitHubWorkflowRun>> {
    return this.#provider.requestJson({
      method: "GET",
      path: repoPath(owner, repo, `actions/runs/${runId}`),
      integrationId: "github_actions",
      validate: expectWorkflowRun,
    });
  }

  rerunWorkflowRun(owner: string, repo: string, runId: number): Promise<GitHubResponse<void>> {
    return this.#provider.requestJson({
      method: "POST",
      path: repoPath(owner, repo, `actions/runs/${runId}/rerun`),
      expectedStatus: [201, 202, 204],
      integrationId: "github_actions",
      validate: expectVoid,
    });
  }

  listCheckRunsForRef(
    owner: string,
    repo: string,
    ref: string,
    filters: GitHubListCheckRunsForRefFilters = {},
  ): Promise<GitHubResponse<GitHubCheckRunsPage>> {
    return this.#provider.requestJson({
      method: "GET",
      path: repoPath(owner, repo, `commits/${encodePathSegment(ref)}/check-runs`),
      query: {
        check_name: filters.checkName,
        status: filters.status,
        filter: filters.filter,
        app_id: filters.appId,
        per_page: filters.perPage,
        page: filters.page,
      },
      integrationId: "github_actions",
      validate: expectCheckRunsPage,
    });
  }

  getCombinedStatusForRef(owner: string, repo: string, ref: string): Promise<GitHubResponse<GitHubCombinedStatus>> {
    return this.#provider.requestJson({
      method: "GET",
      path: repoPath(owner, repo, `commits/${encodePathSegment(ref)}/status`),
      validate: expectCombinedStatus,
    });
  }

  async readCiFailuresForRef(
    owner: string,
    repo: string,
    ref: string,
    options: GitHubReadCiFailuresForRefOptions = {},
  ): Promise<GitHubReadCiFailuresForRefResult> {
    const lastPollAt = options.lastPollAt ?? Date.now();

    try {
      const [checks, combinedStatus] = await Promise.all([
        this.listCheckRunsForRef(owner, repo, ref, options),
        this.getCombinedStatusForRef(owner, repo, ref),
      ]);
      const failures = normalizeGitHubCiFailures({
        owner,
        repo,
        branch: options.branch,
        pullRequestNumber: options.pullRequestNumber,
        pullRequestHeadRef: options.pullRequestHeadRef,
        pullRequestBaseRef: options.pullRequestBaseRef,
        sha: combinedStatus.data.sha,
        checks: checks.data,
        combinedStatus: combinedStatus.data,
      });

      return {
        failures,
        health: {
          triggerKind: "on_ci_fail",
          status: "healthy",
          lastPollAt,
          lastSuccessAt: lastPollAt,
          rateLimitRemaining: minRateLimitRemaining(checks.rateLimit, combinedStatus.rateLimit),
        },
        shouldEnqueue: failures.length > 0,
      };
    } catch (error) {
      if (error instanceof IntegrationError) {
        return {
          failures: [],
          health: {
            triggerKind: "on_ci_fail",
            status: "degraded",
            lastPollAt,
            lastSuccessAt: options.lastSuccessAt,
            lastError: error.message,
            retryAfterMs: error.rateLimit?.retryAfterMs,
            rateLimitRemaining: error.rateLimit?.remaining,
          },
          shouldEnqueue: false,
        };
      }

      throw error;
    }
  }
}

export function createGitHubConnector(options: GitHubConnectorOptions = {}): GitHubConnector {
  return new GitHubConnector(options);
}

export function redactGitHubTokenValue(message: string, token: string): string {
  if (!token) return message;

  let result = message;
  for (const prefix of GITHUB_TOKEN_PREFIXES) {
    if (token.startsWith(prefix)) {
      result = result.replace(new RegExp(`${escapeRegExp(prefix)}\\S+`, "gi"), REDACTION_MARKER);
    }
  }

  return result.replace(new RegExp(escapeRegExp(token), "g"), REDACTION_MARKER);
}

function redactGitHubTokenValueInValue<T>(value: T, token: string): T {
  if (!token) return value;
  if (typeof value === "string") return redactGitHubTokenValue(value, token) as T;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactGitHubTokenValueInValue(item, token)) as T;

  const redacted: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    redacted[key] = redactGitHubTokenValueInValue(item, token);
  }
  return redacted as T;
}

function repoPath(owner: string, repo: string, suffix: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${suffix}`;
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

function expectPullRequest(value: unknown): GitHubPullRequest {
  const object = expectRecord(value, "pull request");
  if (typeof object.number !== "number") {
    throw new Error("pull request.number must be a number");
  }
  return object as GitHubPullRequest;
}

function expectPullRequestArray(value: unknown): readonly GitHubPullRequest[] {
  return expectArray(value, "pull requests").map(expectPullRequest);
}

function expectPullRequestFile(value: unknown): GitHubPullRequestFile {
  const object = expectRecord(value, "pull request file");
  if (typeof object.filename !== "string") {
    throw new Error("pull request file.filename must be a string");
  }
  return object as GitHubPullRequestFile;
}

function expectPullRequestFileArray(value: unknown): readonly GitHubPullRequestFile[] {
  return expectArray(value, "pull request files").map(expectPullRequestFile);
}

function expectIssueComment(value: unknown): GitHubIssueComment {
  const object = expectRecord(value, "issue comment");
  if (typeof object.id !== "number") {
    throw new Error("issue comment.id must be a number");
  }
  return object as GitHubIssueComment;
}

function expectIssueCommentArray(value: unknown): readonly GitHubIssueComment[] {
  return expectArray(value, "issue comments").map(expectIssueComment);
}

function expectWorkflowRun(value: unknown): GitHubWorkflowRun {
  const object = expectRecord(value, "workflow run");
  if (typeof object.id !== "number") {
    throw new Error("workflow run.id must be a number");
  }
  return object as GitHubWorkflowRun;
}

function expectWorkflowRunsPage(value: unknown): GitHubWorkflowRunsPage {
  const object = expectRecord(value, "workflow runs page");
  if (!Array.isArray(object.workflow_runs)) {
    throw new Error("workflow runs page.workflow_runs must be an array");
  }
  return {
    ...object,
    workflow_runs: object.workflow_runs.map(expectWorkflowRun),
  } as GitHubWorkflowRunsPage;
}

function expectCheckRun(value: unknown): GitHubCheckRun {
  const object = expectRecord(value, "check run");
  if (typeof object.id !== "number") {
    throw new Error("check run.id must be a number");
  }
  if (typeof object.name !== "string") {
    throw new Error("check run.name must be a string");
  }
  if (typeof object.head_sha !== "string") {
    throw new Error("check run.head_sha must be a string");
  }
  return object as GitHubCheckRun;
}

function expectCheckRunsPage(value: unknown): GitHubCheckRunsPage {
  const object = expectRecord(value, "check runs page");
  if (!Array.isArray(object.check_runs)) {
    throw new Error("check runs page.check_runs must be an array");
  }
  return {
    ...object,
    check_runs: object.check_runs.map(expectCheckRun),
  } as GitHubCheckRunsPage;
}

function expectCommitStatus(value: unknown): GitHubCommitStatus {
  const object = expectRecord(value, "commit status");
  if (typeof object.id !== "number") {
    throw new Error("commit status.id must be a number");
  }
  if (typeof object.state !== "string") {
    throw new Error("commit status.state must be a string");
  }
  if (typeof object.context !== "string") {
    throw new Error("commit status.context must be a string");
  }
  return object as GitHubCommitStatus;
}

function expectCombinedStatus(value: unknown): GitHubCombinedStatus {
  const object = expectRecord(value, "combined status");
  if (typeof object.state !== "string") {
    throw new Error("combined status.state must be a string");
  }
  if (typeof object.sha !== "string") {
    throw new Error("combined status.sha must be a string");
  }
  if (!Array.isArray(object.statuses)) {
    throw new Error("combined status.statuses must be an array");
  }
  const state = object.state;
  const sha = object.sha;
  return {
    ...object,
    state,
    sha,
    statuses: object.statuses.map(expectCommitStatus),
  };
}

function expectVoid(value: unknown): void {
  if (value !== undefined) {
    const object = expectRecord(value, "empty response");
    if (Object.keys(object).length > 0) {
      throw new Error("response body must be empty");
    }
  }
}

export function normalizeGitHubCiFailures(input: GitHubCiFailureNormalizationInput): readonly GitHubCiFailureSubject[] {
  const owner = input.owner;
  const repo = input.repo;
  const repoId = `${owner}/${repo}`;
  const byKey = new Map<string, MutableCiFailureSubject>();

  for (const checkRun of input.checks?.check_runs ?? []) {
    if (!isFailingCheckConclusion(checkRun.conclusion)) continue;
    const context = normalizeCiContext(checkRun.name);
    const sha = checkRun.head_sha || input.sha;
    if (!sha || !context) continue;
    const pullRequest = firstCheckRunPullRequest(checkRun);
    const subject = getOrCreateCiFailureSubject(byKey, {
      owner,
      repo,
      repoId,
      branch: input.branch ?? pullRequest?.head?.ref,
      pullRequestNumber: input.pullRequestNumber ?? pullRequest?.number,
      pullRequestHeadRef: input.pullRequestHeadRef ?? pullRequest?.head?.ref,
      pullRequestBaseRef: input.pullRequestBaseRef ?? pullRequest?.base?.ref,
      sha,
      context,
    });

    subject.checkName = checkRun.name;
    subject.status = checkRun.status;
    subject.conclusion = checkRun.conclusion;
    subject.checkRunIds = appendUniqueNumber(subject.checkRunIds, checkRun.id);
    subject.checkSuiteIds = appendUniqueNumber(subject.checkSuiteIds, checkRun.check_suite?.id);
    subject.appSlugs = appendUniqueString(subject.appSlugs, checkRun.app?.slug);
    subject.runAttempts = appendUniqueNumber(subject.runAttempts, checkRun.run_attempt);
    subject.sourceSummaries.push({
      source: "checks",
      context,
      checkRunId: checkRun.id,
      checkSuiteId: checkRun.check_suite?.id,
      appSlug: checkRun.app?.slug,
      status: checkRun.status,
      conclusion: checkRun.conclusion,
      runAttempt: checkRun.run_attempt,
      title: safeAuditText(checkRun.output?.title),
      summary: safeAuditText(checkRun.output?.summary),
    });
  }

  const combinedSha = input.combinedStatus?.sha ?? input.sha;
  for (const status of input.combinedStatus?.statuses ?? []) {
    if (!isFailingCommitStatusState(status.state)) continue;
    const context = normalizeCiContext(status.context);
    const sha = combinedSha;
    if (!sha || !context) continue;
    const subject = getOrCreateCiFailureSubject(byKey, {
      owner,
      repo,
      repoId,
      branch: input.branch,
      pullRequestNumber: input.pullRequestNumber,
      pullRequestHeadRef: input.pullRequestHeadRef,
      pullRequestBaseRef: input.pullRequestBaseRef,
      sha,
      context,
    });

    subject.statusContext = status.context;
    subject.state = status.state;
    subject.statusIds = appendUniqueNumber(subject.statusIds, status.id);
    subject.sourceSummaries.push({
      source: "statuses",
      context,
      statusId: status.id,
      state: status.state,
      description: safeAuditText(status.description),
      targetUrl: safeAuditText(status.target_url),
    });
  }

  return [...byKey.values()].map(finalizeCiFailureSubject);
}

interface MutableCiFailureSubject {
  readonly owner: string;
  readonly repo: string;
  readonly repoId: string;
  branch?: string;
  pullRequestNumber?: number;
  pullRequestHeadRef?: string;
  pullRequestBaseRef?: string;
  readonly sha: string;
  readonly context: string;
  checkName?: string;
  statusContext?: string;
  status?: string;
  conclusion?: string | null;
  state?: string;
  checkRunIds: number[];
  statusIds: number[];
  checkSuiteIds: number[];
  appSlugs: string[];
  runAttempts: number[];
  readonly dedupeInputs: GitHubCiFailureDedupeInputs;
  readonly subjectKey: string;
  readonly dedupeKey: string;
  readonly sourceSummaries: GitHubCiFailureSourceSummary[];
}

function getOrCreateCiFailureSubject(
  byKey: Map<string, MutableCiFailureSubject>,
  input: {
    readonly owner: string;
    readonly repo: string;
    readonly repoId: string;
    readonly branch?: string;
    readonly pullRequestNumber?: number;
    readonly pullRequestHeadRef?: string;
    readonly pullRequestBaseRef?: string;
    readonly sha: string;
    readonly context: string;
  },
): MutableCiFailureSubject {
  const key = `${input.repoId}:${input.sha}:${input.context}`;
  const existing = byKey.get(key);
  if (existing) {
    existing.branch ??= input.branch;
    existing.pullRequestNumber ??= input.pullRequestNumber;
    existing.pullRequestHeadRef ??= input.pullRequestHeadRef;
    existing.pullRequestBaseRef ??= input.pullRequestBaseRef;
    return existing;
  }

  const subject: MutableCiFailureSubject = {
    owner: input.owner,
    repo: input.repo,
    repoId: input.repoId,
    branch: input.branch,
    pullRequestNumber: input.pullRequestNumber,
    pullRequestHeadRef: input.pullRequestHeadRef,
    pullRequestBaseRef: input.pullRequestBaseRef,
    sha: input.sha,
    context: input.context,
    checkRunIds: [],
    statusIds: [],
    checkSuiteIds: [],
    appSlugs: [],
    runAttempts: [],
    dedupeInputs: {
      owner: input.owner,
      repo: input.repo,
      sha: input.sha,
      context: input.context,
    },
    subjectKey: `ci:${input.repoId}:${input.context}:${input.sha}`,
    dedupeKey: `${input.repoId}:${input.sha}:${input.context}`,
    sourceSummaries: [],
  };
  byKey.set(key, subject);
  return subject;
}

function finalizeCiFailureSubject(subject: MutableCiFailureSubject): GitHubCiFailureSubject {
  return {
    owner: subject.owner,
    repo: subject.repo,
    repoId: subject.repoId,
    branch: subject.branch,
    pullRequestNumber: subject.pullRequestNumber,
    pullRequestHeadRef: subject.pullRequestHeadRef,
    pullRequestBaseRef: subject.pullRequestBaseRef,
    sha: subject.sha,
    context: subject.context,
    checkName: subject.checkName,
    statusContext: subject.statusContext,
    source: ciFailureSource(subject),
    status: subject.status,
    conclusion: subject.conclusion,
    state: subject.state,
    checkRunIds: subject.checkRunIds,
    statusIds: subject.statusIds,
    checkSuiteIds: subject.checkSuiteIds,
    appSlugs: subject.appSlugs,
    runAttempts: subject.runAttempts,
    dedupeInputs: subject.dedupeInputs,
    subjectKey: subject.subjectKey,
    dedupeKey: subject.dedupeKey,
    sourceSummaries: subject.sourceSummaries,
  };
}

function ciFailureSource(subject: MutableCiFailureSubject): GitHubCiFailureSubject["source"] {
  const hasChecks = subject.sourceSummaries.some((summary) => summary.source === "checks");
  const hasStatuses = subject.sourceSummaries.some((summary) => summary.source === "statuses");
  if (hasChecks && hasStatuses) return "checks+statuses";
  return hasChecks ? "checks" : "statuses";
}

function firstCheckRunPullRequest(checkRun: GitHubCheckRun): GitHubCheckRunPullRequest | undefined {
  return checkRun.pull_requests?.find((pullRequest) => typeof pullRequest.number === "number") ?? checkRun.pull_requests?.[0];
}

function normalizeCiContext(value: string): string {
  return value.trim().toLowerCase();
}

function isFailingCheckConclusion(value: string | null | undefined): boolean {
  return value === "failure" || value === "timed_out" || value === "cancelled" || value === "action_required";
}

function isFailingCommitStatusState(value: string): boolean {
  return value === "error" || value === "failure";
}

function appendUniqueNumber(values: number[], value: number | undefined): number[] {
  if (value === undefined || values.includes(value)) return values;
  return [...values, value];
}

function appendUniqueString(values: string[], value: string | undefined): string[] {
  if (value === undefined || value.trim() === "" || values.includes(value)) return values;
  return [...values, value];
}

function safeAuditText(value: string | null | undefined): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return redactString(redactKnownGitHubTokenPrefixes(value));
}

function redactKnownGitHubTokenPrefixes(value: string): string {
  let result = value;
  for (const prefix of GITHUB_TOKEN_PREFIXES) {
    result = result.replace(new RegExp(`${escapeRegExp(prefix)}\\S+`, "gi"), REDACTION_MARKER);
  }
  return result;
}

function minRateLimitRemaining(...metadata: readonly (GitHubRateLimitMetadata | undefined)[]): number | undefined {
  const remaining = metadata.map((item) => item?.remaining).filter((value): value is number => value !== undefined);
  if (remaining.length === 0) return undefined;
  return Math.min(...remaining);
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function expectArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value;
}

function extractRateLimitMetadata(headers: Headers): GitHubRateLimitMetadata | undefined {
  const retryAfterMs = parseRetryAfterMs(headers.get("retry-after"));
  const resetEpochSeconds = parseOptionalInt(headers.get("x-ratelimit-reset"));
  const metadata: GitHubRateLimitMetadata = {
    limit: parseOptionalInt(headers.get("x-ratelimit-limit")),
    remaining: parseOptionalInt(headers.get("x-ratelimit-remaining")),
    used: parseOptionalInt(headers.get("x-ratelimit-used")),
    resetEpochSeconds,
    resetAt: resetEpochSeconds === undefined ? undefined : new Date(resetEpochSeconds * 1000).toISOString(),
    retryAfterMs,
    resource: headers.get("x-ratelimit-resource") ?? undefined,
  };

  return Object.values(metadata).some((value) => value !== undefined) ? metadata : undefined;
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return undefined;
  return Math.max(0, timestamp - Date.now());
}

function parseOptionalInt(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function readResponseText(response: Response, token: string): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && Number.parseInt(declaredLength, 10) > MAX_GITHUB_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new IntegrationError(
      "integration_bad_response",
      "GitHub response body exceeded the 8 MiB safety limit.",
      { status: response.status },
    );
  }
  if (response.body === null) return "";
  try {
    const reader = response.body.getReader();
    const buffer = new BoundedByteBuffer(MAX_GITHUB_RESPONSE_BYTES);
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value === undefined) continue;
        if (!buffer.append(value)) {
          await reader.cancel().catch(() => undefined);
          throw new IntegrationError(
            "integration_bad_response",
            "GitHub response body exceeded the 8 MiB safety limit.",
            { status: response.status },
          );
        }
      }
    } finally {
      reader.releaseLock();
    }
    return new TextDecoder().decode(buffer.bytes());
  } catch (error) {
    if (error instanceof IntegrationError) throw error;
    throw new IntegrationError(
      "integration_bad_response",
      redactString(redactGitHubTokenValue("Failed to read GitHub response body.", token)),
      { status: response.status, cause: error },
    );
  }
}

function parseGitHubErrorMessage(bodyText: string): string | undefined {
  if (bodyText.trim() === "") return undefined;

  try {
    const parsed = JSON.parse(bodyText) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const message = (parsed as Record<string, unknown>).message;
      return typeof message === "string" ? message : undefined;
    }
  } catch {
    return bodyText.slice(0, 500);
  }

  return undefined;
}

function isRateLimitedResponse(
  response: Response,
  responseMessage: string | undefined,
  rateLimit: GitHubRateLimitMetadata | undefined,
): boolean {
  if (response.status === 429) return true;
  if (response.headers.has("retry-after")) return true;
  if (response.status === 403 && rateLimit?.remaining === 0) return true;
  if (response.status === 403 && responseMessage && /rate limit|secondary rate limit/i.test(responseMessage)) return true;
  return false;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sanitizeErrorCause(cause: unknown, redactedFallback: string): unknown {
  if (cause === undefined) return undefined;
  if (cause instanceof Error || typeof cause === "string") return new Error(redactedFallback);
  return undefined;
}

function stripUrlQuery(value: string): string {
  const url = new URL(value);
  url.search = "";
  url.hash = "";
  return url.href;
}
