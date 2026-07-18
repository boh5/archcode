import { describe, expect, mock, test } from "bun:test";
import {
  GITHUB_REST_API_VERSION,
  MAX_GITHUB_RESPONSE_BYTES,
  GitHubConnector,
  GitHubRestProvider,
  IntegrationError,
  REDACTION_MARKER,
  createGitHubConnector,
  normalizeGitHubCiFailures,
  redactGitHubTokenValue,
  type GitHubFetchAdapter,
} from "./github";

interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
}

class MockGitHubFetch {
  readonly requests: RecordedRequest[] = [];
  #responses: Response[] = [];
  #throwNext: Error | undefined;

  queueJson(value: unknown, init: ResponseInit = {}): void {
    this.#responses.push(new Response(JSON.stringify(value), {
      status: init.status ?? 200,
      headers: {
        "content-type": "application/json",
        ...headersToRecord(init.headers),
      },
    }));
  }

  queueText(value: string, init: ResponseInit = {}): void {
    this.#responses.push(new Response(value, init));
  }

  throwOnNext(error: Error): void {
    this.#throwNext = error;
  }

  createFetch(): GitHubFetchAdapter {
    return mock(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      this.requests.push({
        url,
        method: init?.method ?? "GET",
        headers: headersToRecord(init?.headers),
        body: typeof init?.body === "string" ? init.body : undefined,
      });

      if (this.#throwNext) {
        const error = this.#throwNext;
        this.#throwNext = undefined;
        throw error;
      }

      return this.#responses.shift() ?? new Response("{}", { status: 200 });
    }) as unknown as GitHubFetchAdapter;
  }
}

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  const result: Record<string, string> = {};

  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  }

  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      result[key] = value;
    }
    return result;
  }

  return { ...headers };
}

async function captureIntegrationError(input: () => Promise<unknown>): Promise<IntegrationError> {
  try {
    await input();
  } catch (error) {
    expect(error).toBeInstanceOf(IntegrationError);
    return error as IntegrationError;
  }
  throw new Error("Expected IntegrationError to be thrown");
}

describe("GitHubRestProvider token resolution", () => {
  test("uses configured tokenEnv before default GitHub variables", async () => {
    const fetcher = new MockGitHubFetch();
    fetcher.queueJson({ number: 42, token_echo: "ghp_configured_secret" });
    const connector = new GitHubConnector({
      config: { tokenEnv: "ARCHCODE_GITHUB_TOKEN" },
      env: {
        ARCHCODE_GITHUB_TOKEN: "ghp_configured_secret",
        GITHUB_TOKEN: "ghp_default_secret",
        GH_TOKEN: "ghp_gh_secret",
      },
      fetchAdapter: fetcher.createFetch(),
    });

    const result = await connector.getPullRequest("test-owner", "test-repo", 42);

    expect(fetcher.requests[0].headers.Authorization).toBe("Bearer ghp_configured_secret");
    expect(result.data.token_echo).toBe(REDACTION_MARKER);
  });

  test("falls back from GITHUB_TOKEN to GH_TOKEN", async () => {
    const fetcher = new MockGitHubFetch();
    fetcher.queueJson({ number: 42 });
    const connector = new GitHubConnector({
      config: {},
      env: { GITHUB_TOKEN: "", GH_TOKEN: "ghp_gh_secret" },
      fetchAdapter: fetcher.createFetch(),
    });

    await connector.getPullRequest("test-owner", "test-repo", 42);

    expect(fetcher.requests[0].headers.Authorization).toBe("Bearer ghp_gh_secret");
  });

  test("supports env-expanded token references without exposing the token in metadata", () => {
    const provider = new GitHubRestProvider({
      config: { tokenEnv: "${ARCHCODE_GITHUB_TOKEN}" },
      env: { ARCHCODE_GITHUB_TOKEN: "ghp_expanded_secret" },
      fetchAdapter: new MockGitHubFetch().createFetch(),
    });

    const metadata = provider.resolveTokenMetadata();

    expect(metadata).toEqual({ tokenSource: "integrations.github.tokenEnv", redactedToken: REDACTION_MARKER });
    expect(JSON.stringify(metadata)).not.toContain("ghp_expanded_secret");
  });

  test("maps missing token to integration_auth_missing without leaking secret-looking values", async () => {
    const connector = createGitHubConnector({
      config: { tokenEnv: "ARCHCODE_GITHUB_TOKEN" },
      env: { GITHUB_TOKEN: "", GH_TOKEN: "" },
      fetchAdapter: new MockGitHubFetch().createFetch(),
    });

    const error = await captureIntegrationError(() => connector.getPullRequest("test-owner", "test-repo", 42));

    expect(error.name).toBe("IntegrationError");
    expect(error.code).toBe("integration_auth_missing");
    expect(error.message).toContain("ARCHCODE_GITHUB_TOKEN");
    expect(error.message).not.toContain("ghp_");
  });
});

describe("GitHubConnector REST methods", () => {
  test("parses a no-content-length response delivered as one-byte chunks", async () => {
    const bytes = new TextEncoder().encode('{"number":42,"title":"one-byte"}');
    let index = 0;
    const fetchAdapter = mock(async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index >= bytes.byteLength) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.subarray(index, index + 1));
        index += 1;
      },
    }), { headers: { "content-type": "application/json" } })) as unknown as GitHubFetchAdapter;
    const connector = new GitHubConnector({
      config: {},
      env: { GITHUB_TOKEN: "ghp_one_byte_secret" },
      fetchAdapter,
    });

    const result = await connector.getPullRequest("owner", "repo", 42);

    expect(result.data).toMatchObject({ number: 42, title: "one-byte" });
  });

  test("cancels a no-content-length response immediately after the 8 MiB pre-parse cap", async () => {
    let emitted = 0;
    let cancelled = 0;
    const chunk = new Uint8Array(64 * 1024).fill(0x61);
    const fetchAdapter = mock(async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        emitted += chunk.byteLength;
        controller.enqueue(chunk);
      },
      cancel() { cancelled += 1; },
    }, { highWaterMark: 0 }), { headers: { "content-type": "application/json" } })) as unknown as GitHubFetchAdapter;
    const connector = new GitHubConnector({
      config: {},
      env: { GITHUB_TOKEN: "ghp_cap_secret" },
      fetchAdapter,
    });

    const error = await captureIntegrationError(() => connector.getPullRequest("owner", "repo", 42));

    expect(error.message).toContain("8 MiB");
    expect(emitted).toBe(MAX_GITHUB_RESPONSE_BYTES + chunk.byteLength);
    expect(cancelled).toBe(1);
    expect(JSON.stringify(error)).not.toContain("ghp_cap_secret");
  });

  test("getPullRequest sends GitHub REST headers", async () => {
    const fetcher = new MockGitHubFetch();
    fetcher.queueJson({ number: 42, title: "Add connector" });
    const connector = new GitHubConnector({ config: {}, env: { GITHUB_TOKEN: "ghp_header_secret" }, fetchAdapter: fetcher.createFetch() });

    const result = await connector.getPullRequest("test-owner", "test-repo", 42);

    expect(result.status).toBe(200);
    expect(result.data.number).toBe(42);
    expect(fetcher.requests[0]).toMatchObject({
      url: "https://api.github.com/repos/test-owner/test-repo/pulls/42",
      method: "GET",
    });
    expect(fetcher.requests[0].headers.Accept).toBe("application/vnd.github+json");
    expect(fetcher.requests[0].headers.Authorization).toBe("Bearer ghp_header_secret");
    expect(fetcher.requests[0].headers["X-GitHub-Api-Version"]).toBe(GITHUB_REST_API_VERSION);
  });

  test("listPullRequests maps filter names to query parameters", async () => {
    const fetcher = new MockGitHubFetch();
    fetcher.queueJson([{ number: 1 }, { number: 2 }]);
    const connector = new GitHubConnector({ config: {}, env: { GITHUB_TOKEN: "ghp_list_secret" }, fetchAdapter: fetcher.createFetch() });

    const result = await connector.listPullRequests("test-owner", "test-repo", {
      state: "all",
      base: "main",
      head: "test-owner:feature",
      sort: "updated",
      direction: "desc",
      perPage: 50,
      page: 2,
    });

    expect(result.data).toHaveLength(2);
    const url = new URL(fetcher.requests[0].url);
    expect(url.pathname).toBe("/repos/test-owner/test-repo/pulls");
    expect(url.searchParams.get("per_page")).toBe("50");
    expect(url.searchParams.get("page")).toBe("2");
    expect(url.searchParams.get("head")).toBe("test-owner:feature");
  });

  test("listOpenPullRequests scopes polling to open PR filters", async () => {
    const fetcher = new MockGitHubFetch();
    fetcher.queueJson([{ number: 7, state: "open", base: { ref: "main" } }]);
    const connector = new GitHubConnector({ config: {}, env: { GITHUB_TOKEN: "ghp_open_pr_secret" }, fetchAdapter: fetcher.createFetch() });

    const result = await connector.listOpenPullRequests("test-owner", "test-repo", {
      base: "main",
      head: "test-owner:feature",
      sort: "updated",
      direction: "desc",
      perPage: 25,
    });

    expect(result.data[0].number).toBe(7);
    const url = new URL(fetcher.requests[0].url);
    expect(url.pathname).toBe("/repos/test-owner/test-repo/pulls");
    expect(url.searchParams.get("state")).toBe("open");
    expect(url.searchParams.get("base")).toBe("main");
    expect(url.searchParams.get("head")).toBe("test-owner:feature");
    expect(url.searchParams.get("per_page")).toBe("25");
  });

  test("getPullRequestFiles returns diff summary file metadata", async () => {
    const fetcher = new MockGitHubFetch();
    fetcher.queueJson([{ filename: "src/index.ts", additions: 10, deletions: 2, changes: 12 }]);
    const connector = new GitHubConnector({ config: {}, env: { GITHUB_TOKEN: "ghp_files_secret" }, fetchAdapter: fetcher.createFetch() });

    const result = await connector.getPullRequestFiles("test-owner", "test-repo", 42, { perPage: 100 });

    expect(result.data[0].filename).toBe("src/index.ts");
    expect(new URL(fetcher.requests[0].url).pathname).toBe("/repos/test-owner/test-repo/pulls/42/files");
    expect(new URL(fetcher.requests[0].url).searchParams.get("per_page")).toBe("100");
  });

  test("lists and creates issue comments", async () => {
    const fetcher = new MockGitHubFetch();
    fetcher.queueJson([{ id: 100, body: "hello" }]);
    fetcher.queueJson({ id: 101, body: "created" }, { status: 201 });
    const connector = new GitHubConnector({ config: {}, env: { GITHUB_TOKEN: "ghp_comment_secret" }, fetchAdapter: fetcher.createFetch() });

    const comments = await connector.listIssueComments("test-owner", "test-repo", 42, { page: 3 });
    const created = await connector.createIssueComment("test-owner", "test-repo", 42, "created");

    expect(comments.data[0].id).toBe(100);
    expect(created.status).toBe(201);
    expect(created.data.id).toBe(101);
    expect(fetcher.requests[0].url).toContain("/repos/test-owner/test-repo/issues/42/comments?page=3");
    expect(fetcher.requests[1].method).toBe("POST");
    expect(JSON.parse(fetcher.requests[1].body ?? "{}")).toEqual({ body: "created" });
  });

  test("lists, gets, and reruns workflow runs through GitHub Actions endpoints", async () => {
    const fetcher = new MockGitHubFetch();
    fetcher.queueJson({ total_count: 1, workflow_runs: [{ id: 2001, status: "completed" }] });
    fetcher.queueJson({ id: 2001, status: "completed", conclusion: "success" });
    fetcher.queueText("", { status: 201 });
    const connector = new GitHubConnector({ config: {}, env: { GITHUB_TOKEN: "ghp_actions_secret" }, fetchAdapter: fetcher.createFetch() });

    const runs = await connector.listWorkflowRuns("test-owner", "test-repo", { branch: "main", status: "completed", headSha: "abc123" });
    const run = await connector.getWorkflowRun("test-owner", "test-repo", 2001);
    const rerun = await connector.rerunWorkflowRun("test-owner", "test-repo", 2001);

    expect(runs.data.workflow_runs[0].id).toBe(2001);
    expect(run.data.conclusion).toBe("success");
    expect(rerun.status).toBe(201);
    expect(new URL(fetcher.requests[0].url).pathname).toBe("/repos/test-owner/test-repo/actions/runs");
    expect(new URL(fetcher.requests[0].url).searchParams.get("head_sha")).toBe("abc123");
    expect(fetcher.requests[2]).toMatchObject({
      url: "https://api.github.com/repos/test-owner/test-repo/actions/runs/2001/rerun",
      method: "POST",
    });
  });

  test("lists check runs for a ref and gets combined status for a ref", async () => {
    const fetcher = new MockGitHubFetch();
    fetcher.queueJson({
      total_count: 1,
      check_runs: [
        {
          id: 501,
          name: "ci/build",
          head_sha: "abc123",
          status: "completed",
          conclusion: "failure",
          check_suite: { id: 99 },
        },
      ],
    });
    fetcher.queueJson({
      state: "failure",
      sha: "abc123",
      total_count: 1,
      statuses: [{ id: 701, state: "failure", context: "ci/build", description: "failed" }],
    });
    const connector = new GitHubConnector({ config: {}, env: { GITHUB_TOKEN: "ghp_ci_secret" }, fetchAdapter: fetcher.createFetch() });

    const checkRuns = await connector.listCheckRunsForRef("test-owner", "test-repo", "feature/ci", {
      checkName: "ci/build",
      status: "completed",
      filter: "latest",
      perPage: 50,
    });
    const combinedStatus = await connector.getCombinedStatusForRef("test-owner", "test-repo", "feature/ci");

    expect(checkRuns.data.check_runs[0].id).toBe(501);
    expect(combinedStatus.data.statuses[0].context).toBe("ci/build");
    const checksUrl = new URL(fetcher.requests[0].url);
    expect(checksUrl.pathname).toBe("/repos/test-owner/test-repo/commits/feature%2Fci/check-runs");
    expect(checksUrl.searchParams.get("check_name")).toBe("ci/build");
    expect(checksUrl.searchParams.get("status")).toBe("completed");
    expect(checksUrl.searchParams.get("filter")).toBe("latest");
    expect(checksUrl.searchParams.get("per_page")).toBe("50");
    expect(new URL(fetcher.requests[1].url).pathname).toBe("/repos/test-owner/test-repo/commits/feature%2Fci/status");
  });

  test("reads CI failures for a scoped ref without queuing on rate limits", async () => {
    const fetcher = new MockGitHubFetch();
    fetcher.queueJson(
      { message: "API rate limit exceeded for token ghp_rate_ci_secret" },
      {
        status: 403,
        headers: {
          "retry-after": "30",
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "1783296000",
        },
      },
    );
    fetcher.queueJson({ state: "success", sha: "abc123", total_count: 0, statuses: [] });
    const connector = new GitHubConnector({ config: {}, env: { GITHUB_TOKEN: "ghp_rate_ci_secret" }, fetchAdapter: fetcher.createFetch() });
    const enqueue = mock(() => undefined);

    const result = await connector.readCiFailuresForRef("test-owner", "test-repo", "abc123", {
      branch: "main",
      lastPollAt: 123_000,
      lastSuccessAt: 100_000,
    });
    if (result.shouldEnqueue) enqueue();

    expect(result.failures).toEqual([]);
    expect(result.shouldEnqueue).toBe(false);
    expect(result.health).toMatchObject({
      triggerKind: "on_ci_fail",
      status: "degraded",
      lastPollAt: 123_000,
      lastSuccessAt: 100_000,
      retryAfterMs: 30_000,
      rateLimitRemaining: 0,
    });
    expect(enqueue.mock.calls).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain("ghp_rate_ci_secret");
    expect(JSON.stringify(result)).not.toContain("Authorization");
  });
});

describe("GitHub CI failure normalization", () => {
  test("dedupes equivalent Checks and Combined Status failures for the same SHA and context", () => {
    const failures = normalizeGitHubCiFailures({
      owner: "test-owner",
      repo: "test-repo",
      branch: "feature/ci",
      checks: {
        total_count: 1,
        check_runs: [
          {
            id: 501,
            name: "CI/Build",
            head_sha: "abc123",
            status: "completed",
            conclusion: "failure",
            check_suite: { id: 99 },
            app: { id: 2, slug: "github-actions" },
            output: { title: "Build failed", summary: "token=ghp_normalize_secret" },
            pull_requests: [{ number: 7, head: { ref: "feature/ci", sha: "abc123" }, base: { ref: "main" } }],
            run_attempt: 2,
          },
          {
            id: 502,
            name: "lint",
            head_sha: "abc123",
            status: "completed",
            conclusion: "success",
          },
        ],
      },
      combinedStatus: {
        state: "failure",
        sha: "abc123",
        total_count: 2,
        statuses: [
          { id: 701, state: "failure", context: "ci/build", description: "Build failed", target_url: "https://ci.example/run/701" },
          { id: 702, state: "success", context: "lint" },
        ],
      },
    });

    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      owner: "test-owner",
      repo: "test-repo",
      repoId: "test-owner/test-repo",
      branch: "feature/ci",
      pullRequestNumber: 7,
      pullRequestHeadRef: "feature/ci",
      pullRequestBaseRef: "main",
      sha: "abc123",
      context: "ci/build",
      source: "checks+statuses",
      conclusion: "failure",
      state: "failure",
      dedupeInputs: {
        owner: "test-owner",
        repo: "test-repo",
        sha: "abc123",
        context: "ci/build",
      },
    });
    expect(failures[0].subjectKey).toBe("ci:test-owner/test-repo:ci/build:abc123");
    expect(failures[0].checkRunIds).toEqual([501]);
    expect(failures[0].statusIds).toEqual([701]);
    expect(failures[0].checkSuiteIds).toEqual([99]);
    expect(failures[0].runAttempts).toEqual([2]);
    expect(failures[0].sourceSummaries.map((summary) => summary.source)).toEqual(["checks", "statuses"]);
    expect(JSON.stringify(failures)).not.toContain("ghp_normalize_secret");
    expect(JSON.stringify(failures)).toContain(REDACTION_MARKER);
  });

  test("redacts all known GitHub token prefixes from CI audit summaries", () => {
    const failures = normalizeGitHubCiFailures({
      owner: "test-owner",
      repo: "test-repo",
      checks: {
        check_runs: [
          {
            id: 801,
            name: "ci/secrets",
            head_sha: "def456",
            status: "completed",
            conclusion: "failure",
            output: {
              title: "found gho_output_secret123",
              summary: "ghu_summary_secret123 ghs_status_secret123 github_pat_audit_secret123",
            },
          },
        ],
      },
      combinedStatus: {
        state: "failure",
        sha: "def456",
        statuses: [
          {
            id: 901,
            state: "failure",
            context: "ci/secrets",
            description: "failed with ghr_description_secret123",
            target_url: "https://ci.example/run?token=gho_query_secret123",
          },
        ],
      },
    });

    const serialized = JSON.stringify(failures);
    for (const leaked of [
      "gho_output_secret123",
      "ghu_summary_secret123",
      "ghs_status_secret123",
      "github_pat_audit_secret123",
      "ghr_description_secret123",
      "gho_query_secret123",
    ]) {
      expect(serialized).not.toContain(leaked);
    }
    expect(serialized).toContain(REDACTION_MARKER);
  });
});

describe("GitHubRestProvider typed errors and redaction", () => {
  test("maps 403 rate limit responses with retry and rate metadata", async () => {
    const fetcher = new MockGitHubFetch();
    fetcher.queueJson(
      { message: "API rate limit exceeded for token ghp_rate_secret" },
      {
        status: 403,
        headers: {
          "retry-after": "60",
          "x-ratelimit-limit": "5000",
          "x-ratelimit-remaining": "0",
          "x-ratelimit-used": "5000",
          "x-ratelimit-reset": "1783296000",
          "x-ratelimit-resource": "core",
        },
      },
    );
    const connector = new GitHubConnector({ config: {}, env: { GITHUB_TOKEN: "ghp_rate_secret" }, fetchAdapter: fetcher.createFetch() });

    const error = await captureIntegrationError(() => connector.getPullRequest("test-owner", "test-repo", 42));

    expect(error.code).toBe("integration_rate_limited");
    expect(error.status).toBe(403);
    expect(error.rateLimit).toMatchObject({
      limit: 5000,
      remaining: 0,
      used: 5000,
      resetEpochSeconds: 1783296000,
      resetAt: "2026-07-06T00:00:00.000Z",
      retryAfterMs: 60_000,
      resource: "core",
    });
    expect(error.message).not.toContain("ghp_rate_secret");
    expect(error.message).toContain(REDACTION_MARKER);
  });

  test("maps 429 responses to integration_rate_limited", async () => {
    const fetcher = new MockGitHubFetch();
    fetcher.queueJson({ message: "Too many requests" }, { status: 429, headers: { "retry-after": "1" } });
    const connector = new GitHubConnector({ config: {}, env: { GITHUB_TOKEN: "ghp_429_secret" }, fetchAdapter: fetcher.createFetch() });

    const error = await captureIntegrationError(() => connector.getPullRequest("test-owner", "test-repo", 42));

    expect(error.code).toBe("integration_rate_limited");
    expect(error.rateLimit?.retryAfterMs).toBe(1000);
  });

  test("maps 404 responses to integration_not_found", async () => {
    const fetcher = new MockGitHubFetch();
    fetcher.queueJson({ message: "Not Found" }, { status: 404 });
    const connector = new GitHubConnector({ config: {}, env: { GITHUB_TOKEN: "ghp_not_found_secret" }, fetchAdapter: fetcher.createFetch() });

    const error = await captureIntegrationError(() => connector.getPullRequest("test-owner", "test-repo", 404));

    expect(error.code).toBe("integration_not_found");
    expect(error.status).toBe(404);
  });

  test("maps non-rate-limit 403 responses to integration_forbidden", async () => {
    const fetcher = new MockGitHubFetch();
    fetcher.queueJson({ message: "Resource not accessible by integration" }, { status: 403 });
    const connector = new GitHubConnector({ config: {}, env: { GITHUB_TOKEN: "ghp_forbidden_secret" }, fetchAdapter: fetcher.createFetch() });

    const error = await captureIntegrationError(() => connector.createIssueComment("test-owner", "test-repo", 42, "body"));

    expect(error.code).toBe("integration_forbidden");
    expect(error.status).toBe(403);
  });

  test("maps invalid JSON and invalid shapes to integration_bad_response", async () => {
    const invalidJsonFetcher = new MockGitHubFetch();
    invalidJsonFetcher.queueText("not-json", { status: 200 });
    const invalidJsonConnector = new GitHubConnector({ config: {}, env: { GITHUB_TOKEN: "ghp_bad_json_secret" }, fetchAdapter: invalidJsonFetcher.createFetch() });

    const invalidJsonError = await captureIntegrationError(() => invalidJsonConnector.getPullRequest("test-owner", "test-repo", 42));

    expect(invalidJsonError.code).toBe("integration_bad_response");
    expect(invalidJsonError.message).toContain("invalid JSON");

    const invalidShapeFetcher = new MockGitHubFetch();
    invalidShapeFetcher.queueJson({ title: "missing number" });
    const invalidShapeConnector = new GitHubConnector({ config: {}, env: { GITHUB_TOKEN: "ghp_bad_shape_secret" }, fetchAdapter: invalidShapeFetcher.createFetch() });

    const invalidShapeError = await captureIntegrationError(() => invalidShapeConnector.getPullRequest("test-owner", "test-repo", 42));

    expect(invalidShapeError.code).toBe("integration_bad_response");
    expect(invalidShapeError.message).toContain("unexpected response shape");
  });

  test("redacts token from fetch errors and stored error cause", async () => {
    const fetcher = new MockGitHubFetch();
    fetcher.throwOnNext(new Error("network failed for ghp_fetch_secret"));
    const connector = new GitHubConnector({ config: {}, env: { GITHUB_TOKEN: "ghp_fetch_secret" }, fetchAdapter: fetcher.createFetch() });

    const error = await captureIntegrationError(() => connector.getPullRequest("test-owner", "test-repo", 42));

    expect(error.code).toBe("integration_bad_response");
    expect(error.message).not.toContain("ghp_fetch_secret");
    expect(JSON.stringify(error)).not.toContain("ghp_fetch_secret");
    expect(error.options.cause instanceof Error ? error.options.cause.message : String(error.options.cause)).not.toContain("ghp_fetch_secret");
  });

  test("redactGitHubTokenValue covers exact tokens and common GitHub prefixes", () => {
    expect(redactGitHubTokenValue("token=ghp_exact_secret", "ghp_exact_secret")).toBe(`token=${REDACTION_MARKER}`);
    expect(redactGitHubTokenValue("token=github_pat_abc123456789", "github_pat_abc123456789")).toBe(
      `token=${REDACTION_MARKER}`,
    );
  });
});
