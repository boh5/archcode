import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  NotRootSessionError,
  ProjectAttachmentStorage,
  ProjectRegistry,
  SessionAttachmentService,
  silentLogger,
  type AgentRuntime,
} from "@archcode/agent-core";
import { MAX_ATTACHMENT_SIZE_BYTES } from "@archcode/protocol";
import { createRuntimeApp } from "../app";
import { attachmentDisposition } from "./attachments";

const TEST_ROOT = resolve(
  import.meta.dir,
  "__test_tmp__",
  "attachments-routes",
  crypto.randomUUID(),
);

beforeEach(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
  await mkdir(TEST_ROOT, { recursive: true });
});

afterAll(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
});

describe("attachment routes", () => {
  test("PUT streams a descriptor and GET forces a safe download", async () => {
    const fixture = await createFixture("upload-download");
    const attachmentId = crypto.randomUUID();
    const bytes = new TextEncoder().encode("hello attachment");
    const put = await fixture.app.request(
      uploadUrl(fixture.projectSlug, fixture.rootSessionId, attachmentId, "报告 \"final\".txt", bytes.byteLength),
      {
        method: "PUT",
        headers: { "content-type": "text/plain; charset=UTF-8" },
        body: bytes,
      },
    );

    expect(put.status).toBe(201);
    expect(await put.json()).toEqual({
      id: attachmentId,
      name: "报告 \"final\".txt",
      mediaType: "text/plain",
      sizeBytes: bytes.byteLength,
      kind: "file",
    });

    const get = await fixture.app.request(
      `/api/projects/${fixture.projectSlug}/sessions/${fixture.rootSessionId}/attachments/${attachmentId}`,
    );
    expect(get.status).toBe(200);
    expect(get.headers.get("content-type")).toBe("text/plain");
    expect(get.headers.get("content-length")).toBe(String(bytes.byteLength));
    expect(get.headers.get("x-content-type-options")).toBe("nosniff");
    expect(get.headers.get("content-disposition")).toBe(
      attachmentDisposition("报告 \"final\".txt"),
    );
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(bytes);
  });

  test("returns 200 for an identical retry and 409 for changed content", async () => {
    const fixture = await createFixture("retry");
    const attachmentId = crypto.randomUUID();
    const first = Uint8Array.of(1, 2, 3);
    const url = uploadUrl(
      fixture.projectSlug,
      fixture.rootSessionId,
      attachmentId,
      "retry.bin",
      first.byteLength,
    );

    expect((await fixture.app.request(url, { method: "PUT", body: first })).status).toBe(201);
    expect((await fixture.app.request(url, { method: "PUT", body: first })).status).toBe(200);
    const conflict = await fixture.app.request(url, {
      method: "PUT",
      body: Uint8Array.of(3, 2, 1),
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      error: { code: "ATTACHMENT_CONFLICT" },
    });
  });

  test("maps invalid size, fixed limit, and invalid names without creating objects", async () => {
    const fixture = await createFixture("validation");
    const base = `/api/projects/${fixture.projectSlug}/sessions/${fixture.rootSessionId}/attachments/${crypto.randomUUID()}`;
    const invalidSize = await fixture.app.request(
      `${base}?name=file&sizeBytes=01`,
      { method: "PUT" },
    );
    expect(invalidSize.status).toBe(400);
    expect(await invalidSize.json()).toMatchObject({
      error: { code: "ATTACHMENT_INVALID" },
    });

    const tooLarge = await fixture.app.request(
      `${base}?name=file&sizeBytes=${MAX_ATTACHMENT_SIZE_BYTES + 1}`,
      { method: "PUT" },
    );
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.json()).toMatchObject({
      error: {
        code: "ATTACHMENT_TOO_LARGE",
        details: { limitBytes: MAX_ATTACHMENT_SIZE_BYTES },
      },
    });

    const invalidName = await fixture.app.request(
      `${base}?name=${encodeURIComponent("../escape")}&sizeBytes=0`,
      { method: "PUT" },
    );
    expect(invalidName.status).toBe(400);
  });

  test("rejects child Session uploads and cross-root downloads", async () => {
    const fixture = await createFixture("ownership");
    const attachmentId = crypto.randomUUID();
    const child = await fixture.app.request(
      uploadUrl(fixture.projectSlug, crypto.randomUUID(), attachmentId, "child", 0),
      { method: "PUT" },
    );
    expect(child.status).toBe(400);
    expect(await child.json()).toMatchObject({
      error: { code: "ATTACHMENT_INVALID" },
    });

    await fixture.app.request(
      uploadUrl(fixture.projectSlug, fixture.rootSessionId, attachmentId, "owned", 0),
      { method: "PUT" },
    );
    const otherRoot = crypto.randomUUID();
    fixture.validRoots.add(otherRoot);
    const crossRoot = await fixture.app.request(
      `/api/projects/${fixture.projectSlug}/sessions/${otherRoot}/attachments/${attachmentId}`,
    );
    expect(crossRoot.status).toBe(404);
    expect(await crossRoot.json()).toMatchObject({
      error: { code: "ATTACHMENT_NOT_FOUND" },
    });
  });

  test("formats RFC 5987 filename* without header injection", () => {
    const disposition = attachmentDisposition("a \"quote\" (最终).txt");
    expect(disposition).toBe(
      "attachment; filename=\"a _quote_ ____.txt\"; filename*=UTF-8''a%20%22quote%22%20%28%E6%9C%80%E7%BB%88%29.txt",
    );
    expect(disposition).not.toContain("\n");
    expect(disposition).not.toContain("\r");
  });
});

async function createFixture(name: string) {
  const homeDir = join(TEST_ROOT, "home", name);
  const workspaceRoot = join(TEST_ROOT, "workspace", name);
  await mkdir(homeDir, { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });
  const projectRegistry = new ProjectRegistry({ homeDir, logger: silentLogger });
  const project = await projectRegistry.add({ workspaceRoot, name });
  const rootSessionId = crypto.randomUUID();
  const validRoots = new Set<string>([rootSessionId]);
  const attachments = new SessionAttachmentService({
    storage: new ProjectAttachmentStorage(),
    validateRootSession: async (_root, sessionId) => {
      if (validRoots.has(sessionId)) return;
      throw new NotRootSessionError(sessionId, rootSessionId);
    },
  });
  const runtime = {
    projectRegistry,
    uploadSessionAttachment: (
      input: Parameters<AgentRuntime["uploadSessionAttachment"]>[0],
    ) => attachments.upload(input),
    openSessionAttachment: (
      input: Parameters<AgentRuntime["openSessionAttachment"]>[0],
    ) => attachments.openDownload(input),
    subscribeSessionRuntimeChanges: () => () => undefined,
    subscribeSessionEvents: () => () => undefined,
    subscribeModelRuntimeChanges: () => () => undefined,
    subscribeResourceChanges: () => () => undefined,
    subscribeMcpStatusChanges: () => () => undefined,
    listSessionRuntimeEvents: async () => [],
    listHitlSnapshotEvents: async () => [],
    getMcpServerStatus: () => ({ servers: {} }),
    getMcpServerInventory: () => ({ servers: {} }),
  } as unknown as AgentRuntime;
  return {
    app: createRuntimeApp(runtime).app,
    projectSlug: project.slug,
    rootSessionId,
    validRoots,
  };
}

function uploadUrl(
  projectSlug: string,
  rootSessionId: string,
  attachmentId: string,
  name: string,
  sizeBytes: number,
): string {
  return `/api/projects/${projectSlug}/sessions/${rootSessionId}/attachments/${attachmentId}`
    + `?name=${encodeURIComponent(name)}&sizeBytes=${sizeBytes}`;
}
