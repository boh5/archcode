import {
  GITHUB_API_BASE_URL,
  GithubIntegrationTokenError,
  type GithubIntegrationConfig,
  type ResolvedGithubIntegrationConfig,
  resolveGithubIntegrationConfig,
} from "../config";
import { REDACTION_MARKER as SECURITY_REDACTION_MARKER, redactString } from "../tools/security";

export const GITHUB_REST_API_VERSION = "2022-11-28" as const;
export const REDACTION_MARKER = SECURITY_REDACTION_MARKER;

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

export interface GitHubListPullRequestsFilters {
  readonly state?: "open" | "closed" | "all";
  readonly head?: string;
  readonly base?: string;
  readonly sort?: "created" | "updated" | "popularity" | "long-running";
  readonly direction?: "asc" | "desc";
  readonly perPage?: number;
  readonly page?: number;
}

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

export type GitHubFetchAdapter = typeof fetch;

export interface GitHubIntegrationProvider {
  readonly apiBaseUrl: typeof GITHUB_API_BASE_URL;
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
  readonly apiBaseUrl: typeof GITHUB_API_BASE_URL = GITHUB_API_BASE_URL;

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
    let response: Response;

    try {
      response = await this.#fetchAdapter(url, {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${tokenState.token}`,
          "Content-Type": "application/json",
          "User-Agent": "ArchCode",
          "X-GitHub-Api-Version": GITHUB_REST_API_VERSION,
        },
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
      });
    } catch (error) {
      throw this.#error(
        "integration_bad_response",
        `GitHub request failed: ${error instanceof Error ? error.message : String(error)}`,
        { integrationId: request.integrationId, method, url, cause: error },
      );
    }

    const rateLimit = extractRateLimitMetadata(response.headers);
    const bodyText = await readResponseText(response, this.#lastToken);

    if (!response.ok) {
      throw this.#httpError({
        response,
        request,
        url,
        method,
        bodyText,
        rateLimit,
      });
    }

    const expectedStatus = request.expectedStatus ?? [200];
    if (!expectedStatus.includes(response.status)) {
      throw this.#error(
        "integration_bad_response",
        `GitHub returned unexpected status ${response.status} for ${method} ${url}.`,
        { integrationId: request.integrationId, status: response.status, method, url, rateLimit },
      );
    }

    const data = this.#parseSuccessBody(bodyText, request, response.status, method, url, rateLimit);

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
    const url = new URL(path, this.apiBaseUrl);
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

function expectVoid(value: unknown): void {
  if (value !== undefined) {
    const object = expectRecord(value, "empty response");
    if (Object.keys(object).length > 0) {
      throw new Error("response body must be empty");
    }
  }
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
  try {
    return await response.text();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new IntegrationError(
      "integration_bad_response",
      redactString(redactGitHubTokenValue(`Failed to read GitHub response body: ${message}`, token)),
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
  if (cause instanceof Error) {
    return new Error(redactString(cause.message) === cause.message ? redactedFallback : redactString(cause.message));
  }
  if (typeof cause === "string") return redactString(cause);
  return undefined;
}
