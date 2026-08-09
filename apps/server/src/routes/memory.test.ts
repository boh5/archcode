import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import {
  MemoryCapacityError,
  MemoryRevisionConflictError,
  MemorySecretError,
  ProjectRegistry,
  createInMemoryLogger,
  silentLogger,
  type AgentRuntime,
} from "@archcode/agent-core";
import type {
  MemoryPreferencesItem,
  MemorySnapshot,
  MemoryTopicItem,
} from "@archcode/protocol";
import { errorHandler } from "../error-handler";
import { createMemoryRoutes } from "./memory";

const tempRoot = resolve(tmpdir(), "archcode-memory-routes-test");
const capacity = {
  bytes: 12,
  maxBytes: 8192,
  state: "within-limit" as const,
  mutationPolicy: "normal" as const,
};
const preferences: MemoryPreferencesItem = {
  content: "Concise answers",
  revision: "preferences-rev",
  capacity,
  availableForPrompt: true,
};
const topic: MemoryTopicItem = {
  name: "build_tools",
  title: "Build tools",
  description: "Project build commands",
  type: "project",
  content: "Use Bun",
  revision: "topic-rev",
  capacity: { ...capacity, maxBytes: 16384 },
};
const topicSummary = {
  name: topic.name,
  title: topic.title,
  description: topic.description,
  type: topic.type,
  revision: topic.revision,
  capacity: topic.capacity,
};
const snapshot: MemorySnapshot = {
  preferences,
  topics: [topicSummary],
  index: {
    revision: "index-rev",
    bytes: 40,
    topicCount: {
      count: 1,
      max: 200,
      state: "within-limit",
      canCreate: true,
    },
    availableForPrompt: true,
  },
  warnings: [],
};

function createService() {
  return {
    snapshot: mock(async () => snapshot),
    readPreferences: mock(async () => preferences as MemoryPreferencesItem | null),
    putPreferences: mock(async () => preferences),
    deletePreferences: mock(async () => undefined),
    readTopic: mock(async () => topic as MemoryTopicItem | null),
    putTopic: mock(async () => topic),
    deleteTopic: mock(async () => undefined),
  };
}

async function createFixture(name: string, options: { captureLogs?: boolean } = {}) {
  const homeDir = resolve(tempRoot, "homes", name);
  const workspaceRoot = resolve(tempRoot, "workspaces", name);
  await mkdir(homeDir, { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });
  const projectRegistry = new ProjectRegistry({ homeDir, logger: silentLogger });
  const project = await projectRegistry.add({ workspaceRoot, name });
  const service = createService();
  const resolveContext = mock(async () => ({ memory: service }));
  const runtime = {
    projectRegistry,
    contextResolver: { resolve: resolveContext },
    getMemorySnapshot: mock(async () => service.snapshot()),
  } as unknown as AgentRuntime;
  const app = new Hono();
  const memoryLogs = options.captureLogs ? createInMemoryLogger() : undefined;
  app.onError((error, context) => errorHandler(error, context, memoryLogs?.logger ?? silentLogger));
  app.route("/api/projects", createMemoryRoutes(runtime));
  return { app, project, service, resolveContext, logEntries: memoryLogs?.entries ?? [] };
}

describe("Memory routes", () => {
  beforeEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
    await mkdir(tempRoot, { recursive: true });
  });

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("returns the project-scoped Memory snapshot", async () => {
    const { app, project, service } = await createFixture("snapshot");

    const response = await app.request(`/api/projects/${project.slug}/memory`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(snapshot);
    expect(service.snapshot).toHaveBeenCalledTimes(1);
  });

  test("passes preferences and topic edits through strict CAS inputs", async () => {
    const { app, project, service } = await createFixture("put");

    const preferencesResponse = await app.request(
      `/api/projects/${project.slug}/memory/preferences`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Concise answers", expectedRevision: "old-pref" }),
      },
    );
    const topicResponse = await app.request(
      `/api/projects/${project.slug}/memory/topics/build_tools`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Build tools",
          description: "Project build commands",
          type: "project",
          content: "Use Bun",
          expectedRevision: null,
        }),
      },
    );

    expect(preferencesResponse.status).toBe(200);
    expect(topicResponse.status).toBe(200);
    expect(service.putPreferences).toHaveBeenCalledWith({
      content: "Concise answers",
      expectedRevision: "old-pref",
    });
    expect(service.putTopic).toHaveBeenCalledWith({
      name: "build_tools",
      title: "Build tools",
      description: "Project build commands",
      type: "project",
      content: "Use Bun",
      expectedRevision: null,
    });
  });

  test("rejects unknown edit fields before calling the service", async () => {
    const { app, project, service } = await createFixture("strict-body");

    const response = await app.request(
      `/api/projects/${project.slug}/memory/preferences`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "text", expectedRevision: null, overwrite: true }),
      },
    );

    expect(response.status).toBe(400);
    expect(service.putPreferences).not.toHaveBeenCalled();
  });

  test("returns 409 without exposing Memory content or local paths", async () => {
    const { app, project, service } = await createFixture("conflict");
    service.putPreferences.mockImplementationOnce(async () => {
      throw new MemoryRevisionConflictError(
        "/Users/private/preferences.md",
        "stale-revision",
        "current-revision",
      );
    });

    const response = await app.request(
      `/api/projects/${project.slug}/memory/preferences`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "private body", expectedRevision: "stale-revision" }),
      },
    );
    const text = await response.text();

    expect(response.status).toBe(409);
    expect(JSON.parse(text)).toEqual({
      error: {
        code: "MEMORY_REVISION_CONFLICT",
        message: "Memory changed. Reload it before saving.",
        details: {
          expectedRevision: "stale-revision",
          actualRevision: "current-revision",
        },
      },
    });
    expect(text).not.toContain("/Users/private");
    expect(text).not.toContain("private body");
  });

  test("deletes with CAS and returns no body", async () => {
    const { app, project, service } = await createFixture("delete");

    const response = await app.request(
      `/api/projects/${project.slug}/memory/topics/build_tools`,
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision: "topic-rev" }),
      },
    );

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(service.deleteTopic).toHaveBeenCalledWith({
      name: "build_tools",
      expectedRevision: "topic-rev",
    });
  });

  test("maps capacity and secret failures without echoing submitted content", async () => {
    const { app, project, service } = await createFixture("safe-domain-errors");
    service.putPreferences
      .mockImplementationOnce(async () => {
        throw new MemoryCapacityError("/private/preferences.md", 8193, 8192);
      })
      .mockImplementationOnce(async () => {
        throw new MemorySecretError();
      });
    const request = (content: string) => app.request(
      `/api/projects/${project.slug}/memory/preferences`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content, expectedRevision: "preferences-rev" }),
      },
    );

    const capacityResponse = await request("capacity-private-body");
    const capacityText = await capacityResponse.text();
    expect(capacityResponse.status).toBe(422);
    expect(JSON.parse(capacityText).error).toEqual({
      code: "MEMORY_CAPACITY_EXCEEDED",
      message: "Memory capacity would be exceeded.",
      details: { bytes: 8193, maxBytes: 8192 },
    });
    expect(capacityText).not.toContain("/private");
    expect(capacityText).not.toContain("capacity-private-body");

    const secretResponse = await request("secret-private-body");
    const secretText = await secretResponse.text();
    expect(secretResponse.status).toBe(422);
    expect(JSON.parse(secretText).error).toEqual({
      code: "MEMORY_SECRET_DETECTED",
      message: "Memory content contains a potential secret.",
    });
    expect(secretText).not.toContain("secret-private-body");
  });

  test("maps unknown Memory failures to a safe response and safe structured log", async () => {
    const { app, project, service, logEntries } = await createFixture(
      "safe-unknown-error",
      { captureLogs: true },
    );
    const sensitive = "secret-memory-body";
    service.readTopic.mockImplementationOnce(async () => {
      throw new Error(`/Users/private/.archcode/runtime/memory/topic.md: ${sensitive}`);
    });

    const response = await app.request(
      `/api/projects/${project.slug}/memory/topics/build_tools`,
    );
    const responseText = await response.text();
    const serializedLogs = JSON.stringify(logEntries);

    expect(response.status).toBe(500);
    expect(JSON.parse(responseText)).toEqual({
      error: {
        code: "MEMORY_OPERATION_FAILED",
        message: "Memory operation failed.",
      },
    });
    expect(responseText).not.toContain("/Users/private");
    expect(responseText).not.toContain(sensitive);
    expect(serializedLogs).not.toContain("/Users/private");
    expect(serializedLogs).not.toContain(sensitive);
    expect(logEntries).toEqual([expect.objectContaining({
      event: "http.request.failed",
      context: {
        method: "GET",
        path: `/api/projects/${project.slug}/memory/topics/build_tools`,
        status: 500,
      },
      meta: {
        errorName: "ServerError",
        errorCode: "MEMORY_OPERATION_FAILED",
      },
    })]);
  });

  test("maps Memory context resolution failures before they reach the general error logger", async () => {
    const { app, project, resolveContext, logEntries } = await createFixture(
      "safe-context-error",
      { captureLogs: true },
    );
    const sensitive = "resolver-secret-body";
    resolveContext.mockImplementationOnce(async () => {
      throw new Error(`/Users/private/.archcode/runtime/memory: ${sensitive}`);
    });

    const response = await app.request(
      `/api/projects/${project.slug}/memory/preferences`,
    );
    const responseText = await response.text();
    const serializedLogs = JSON.stringify(logEntries);

    expect(response.status).toBe(500);
    expect(JSON.parse(responseText)).toEqual({
      error: {
        code: "MEMORY_OPERATION_FAILED",
        message: "Memory operation failed.",
      },
    });
    expect(responseText).not.toContain("/Users/private");
    expect(responseText).not.toContain(sensitive);
    expect(serializedLogs).not.toContain("/Users/private");
    expect(serializedLogs).not.toContain(sensitive);
    expect(logEntries).toEqual([expect.objectContaining({
      event: "http.request.failed",
      context: {
        method: "GET",
        path: `/api/projects/${project.slug}/memory/preferences`,
        status: 500,
      },
      meta: {
        errorName: "ServerError",
        errorCode: "MEMORY_OPERATION_FAILED",
      },
    })]);
  });
});
