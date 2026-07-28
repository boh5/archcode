import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AttachmentNotFoundError, ProjectRegistry, SessionCommandOutcomeError, SessionInputConflictError, SessionSteerUnavailableError, silentLogger } from "@archcode/agent-core";
import type { AgentRuntime } from "@archcode/agent-core";
import { createRuntimeApp } from "../app";

const tempRoot = resolve(import.meta.dir, "__test_tmp__", "messages-routes");
const requestedModelSelection = {
  mode: "profile_default" as const,
  selection: { model: "local:test", variant: "fast" },
};

function createTestRuntime(projectRegistry: ProjectRegistry): AgentRuntime {
  const pending = { id: "message-1", clientRequestId: "request-1", content: "Hello", attachments: [], state: "queued" as const, revision: 0, requestedModelSelection };
  return {
    projectRegistry,
    contextResolver: undefined,
    configService: { getSnapshot: mock(async () => ({
      config: { provider: {}, profiles: {} },
      revision: "test",
      modelRuntimeRevision: "test",
      configPath: "/test",
      restartRequiredSections: [],
    })) },
    listAgentDescriptors: mock(() => []),
    subscribeSessionEvents: mock(() => () => undefined),
    subscribeHitlEvents: mock(() => () => undefined),
    subscribeSessionRuntimeChanges: mock(() => () => undefined),
    subscribeMcpStatusChanges: mock(() => () => undefined),
    getMcpServerStatuses: mock(() => new Map()),
    acceptSessionMessage: mock(async () => ({ clientRequestId: pending.clientRequestId, messageId: pending.id, status: "pending" as const, message: pending })),
    editPendingSessionMessage: mock(async () => ({ ...pending, content: "Edited", revision: 1 })),
    deletePendingSessionMessage: mock(async () => ({ messageId: pending.id, clientRequestId: pending.clientRequestId, revision: 2 })),
    steerPendingSessionMessage: mock(async () => ({ ...pending, state: "steering" as const, revision: 2 })),
  } as unknown as AgentRuntime;
}

async function createTestApp(testName: string) {
  const workspaceRoot = join(tempRoot, "workspaces", testName);
  await mkdir(workspaceRoot, { recursive: true });
  const projectRegistry = new ProjectRegistry({ homeDir: join(tempRoot, "homes", testName), logger: silentLogger });
  const project = await projectRegistry.add({ workspaceRoot, name: testName });
  const runtime = createTestRuntime(projectRegistry);
  return { app: createRuntimeApp(runtime).app, project, runtime };
}

describe("messages routes", () => {
  beforeEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
    await mkdir(tempRoot, { recursive: true });
  });
  afterAll(async () => await rm(tempRoot, { recursive: true, force: true }));

  test("POST accepts a durable Session message", async () => {
    const { app, project, runtime } = await createTestApp("accept");
    const response = await app.request(`/api/projects/${project.slug}/sessions/session-1/messages`, {
      method: "POST",
      body: JSON.stringify({ text: "Hello", attachmentIds: [], clientRequestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", requestedModelSelection }),
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ status: "queued", messageId: "message-1" });
    expect(runtime.acceptSessionMessage).toHaveBeenCalledWith(expect.objectContaining({ source: "user", sessionId: "session-1", requestedModelSelection }));
  });

  test("POST requires the hard-cut attachmentIds field", async () => {
    const { app, project } = await createTestApp("validation");
    const response = await app.request(`/api/projects/${project.slug}/sessions/session-1/messages`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    expect(response.status).toBe(400);
  });

  test("POST accepts attachment-only input and preserves ordered ids", async () => {
    const { app, project, runtime } = await createTestApp("attachment-only");
    const attachmentIds = [
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    ];
    const response = await app.request(`/api/projects/${project.slug}/sessions/session-1/messages`, {
      method: "POST",
      body: JSON.stringify({
        text: "",
        attachmentIds,
        clientRequestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        requestedModelSelection,
      }),
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(202);
    expect(runtime.acceptSessionMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: "", attachmentIds }),
    );
  });

  test("POST rejects empty input, duplicate ids, and slash commands with attachments", async () => {
    const { app, project, runtime } = await createTestApp("attachment-validation");
    const url = `/api/projects/${project.slug}/sessions/session-1/messages`;
    const clientRequestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    for (const input of [
      { text: "", attachmentIds: [] },
      {
        text: "inspect",
        attachmentIds: [
          "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        ],
      },
      {
        text: "/compact",
        attachmentIds: ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
      },
    ]) {
      const response = await app.request(url, {
        method: "POST",
        body: JSON.stringify({ ...input, clientRequestId, requestedModelSelection }),
        headers: { "content-type": "application/json" },
      });
      expect(response.status).toBe(400);
    }
    expect(runtime.acceptSessionMessage).not.toHaveBeenCalled();
  });

  test("POST maps an unresolved attachment reference without creating input", async () => {
    const { app, project, runtime } = await createTestApp("attachment-not-found");
    const attachmentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    (runtime.acceptSessionMessage as unknown as ReturnType<typeof mock>)
      .mockImplementation(async () => {
        throw new AttachmentNotFoundError(attachmentId);
      });

    const response = await app.request(
      `/api/projects/${project.slug}/sessions/session-1/messages`,
      {
        method: "POST",
        body: JSON.stringify({
          text: "",
          attachmentIds: [attachmentId],
          clientRequestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          requestedModelSelection,
        }),
        headers: { "content-type": "application/json" },
      },
    );

    expect(response.status).toBe(404);
    expect((await response.json()).error).toMatchObject({
      code: "ATTACHMENT_NOT_FOUND",
      details: { attachmentId },
    });
    expect(runtime.acceptSessionMessage).toHaveBeenCalledTimes(1);
  });

  test("PATCH edits a pending message", async () => {
    const { app, project, runtime } = await createTestApp("edit");
    const response = await app.request(`/api/projects/${project.slug}/sessions/session-1/messages/message-1`, {
      method: "PATCH", body: JSON.stringify({ text: "Edited", expectedRevision: 0 }), headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ messageId: "message-1", content: "Edited", revision: 1 });
    expect(runtime.editPendingSessionMessage).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 0 }));
  });

  test("PATCH maps an empty text-only edit domain conflict to 409", async () => {
    const { app, project, runtime } = await createTestApp("empty-text-edit");
    (runtime.editPendingSessionMessage as unknown as ReturnType<typeof mock>)
      .mockImplementation(async () => {
        throw new SessionInputConflictError(
          "state",
          "Message message-1 requires text because it has no attachments",
          {
            messageId: "message-1",
            clientRequestId: "request-1",
            status: "queued",
            revision: 0,
            content: "Hello",
          },
        );
      });
    const response = await app.request(
      `/api/projects/${project.slug}/sessions/session-1/messages/message-1`,
      {
        method: "PATCH",
        body: JSON.stringify({ text: "", expectedRevision: 0 }),
        headers: { "content-type": "application/json" },
      },
    );

    expect(response.status).toBe(409);
    expect((await response.json()).error.details).toMatchObject({
      scopeCode: "SESSION_INPUT_CONFLICT",
      reason: "state",
      current: { messageId: "message-1", content: "Hello" },
    });
  });

  test("DELETE removes a pending message", async () => {
    const { app, project, runtime } = await createTestApp("delete");
    const response = await app.request(`/api/projects/${project.slug}/sessions/session-1/messages/message-1`, {
      method: "DELETE", body: JSON.stringify({ expectedRevision: 0 }), headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ messageId: "message-1", clientRequestId: "request-1", revision: 2, status: "deleted" });
    expect(runtime.deletePendingSessionMessage).toHaveBeenCalledTimes(1);
  });

  test("POST steer claims a pending message", async () => {
    const { app, project, runtime } = await createTestApp("steer");
    const response = await app.request(`/api/projects/${project.slug}/sessions/session-1/messages/message-1/steer`, {
      method: "POST", body: JSON.stringify({ expectedRevision: 0, expectedExecutionId: "execution-1" }), headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ messageId: "message-1", status: "steering" });
    expect(runtime.steerPendingSessionMessage).toHaveBeenCalledWith(expect.objectContaining({ expectedExecutionId: "execution-1" }));
  });

  test("maps mutation conflicts to 409", async () => {
    const { app, project, runtime } = await createTestApp("conflict");
    (runtime.editPendingSessionMessage as unknown as ReturnType<typeof mock>).mockImplementation(async () => {
      throw new SessionInputConflictError("state", "already canonical", {
        messageId: "message-1",
        clientRequestId: "request-1",
        status: "canonical",
        content: "Hello",
        executionId: "execution-1",
      });
    });
    const response = await app.request(`/api/projects/${project.slug}/sessions/session-1/messages/message-1`, {
      method: "PATCH", body: JSON.stringify({ text: "Edited", expectedRevision: 0 }), headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(409);
    expect((await response.json()).error.details).toEqual({
      scopeCode: "SESSION_INPUT_CONFLICT",
      reason: "state",
      current: {
        messageId: "message-1",
        clientRequestId: "request-1",
        status: "canonical",
        content: "Hello",
        executionId: "execution-1",
      },
    });
  });

  test("maps steer-unavailable conflicts to 409", async () => {
    const { app, project, runtime } = await createTestApp("steer-conflict");
    (runtime.steerPendingSessionMessage as unknown as ReturnType<typeof mock>).mockImplementation(async () => { throw new SessionSteerUnavailableError("session-1", "execution-1"); });
    const response = await app.request(`/api/projects/${project.slug}/sessions/session-1/messages/message-1/steer`, {
      method: "POST", body: JSON.stringify({ expectedRevision: 0, expectedExecutionId: "execution-1" }), headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(409);
  });

  test("returns a stable indeterminate command outcome without authorizing replay", async () => {
    const { app, project, runtime } = await createTestApp("command-indeterminate");
    (runtime.acceptSessionMessage as unknown as ReturnType<typeof mock>).mockImplementation(async () => {
      throw new SessionCommandOutcomeError(
        "session-1",
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "indeterminate",
        "Command outcome is unknown because execution was interrupted by restart",
      );
    });
    const response = await app.request(`/api/projects/${project.slug}/sessions/session-1/messages`, {
      method: "POST",
      body: JSON.stringify({ text: "/compact", attachmentIds: [], clientRequestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", requestedModelSelection }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(409);
    expect((await response.json()).error.details).toMatchObject({
      scopeCode: "SESSION_COMMAND_OUTCOME_INDETERMINATE",
      status: "indeterminate",
    });
    expect(runtime.acceptSessionMessage).toHaveBeenCalledTimes(1);
  });
});
