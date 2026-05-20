import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import type { AskUserRequest } from "@specra/agent-core";
import { createSessionStore } from "@specra/agent-core";
import { AskUserService } from "../ask-user-service";
import { errorHandler } from "../error-handler";
import { createQuestionsRoutes } from "./questions";

const tmpRoots: string[] = [];

const askRequest: AskUserRequest = {
  toolName: "ask_user",
  toolCallId: "call-1",
  questions: [
    {
      question: "Pick one",
      header: "Choice",
      options: [{ label: "Yes", description: "Approve" }],
      custom: true,
    },
  ],
};

function createTestApp(askUserService: AskUserService): Hono {
  const app = new Hono();
  app.onError(errorHandler);
  app.route("/api/questions", createQuestionsRoutes(askUserService));
  return app;
}

async function createQuestion(askUserService: AskUserService): Promise<string> {
  const sessionId = `session-${crypto.randomUUID()}`;
  const workspaceRoot = await createWorkspaceRoot();
  const store = createSessionStore(sessionId, workspaceRoot);
  void askUserService.request(sessionId, workspaceRoot, askRequest, store);

  const event = store.getState().events.find((entry) => entry.kind === "question.request");
  if (!event) {
    throw new Error("question request event missing");
  }

  return (event.payload as { questionId: string }).questionId;
}

async function createWorkspaceRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "specra-questions-routes-"));
  tmpRoots.push(root);
  return root;
}

describe("question routes", () => {
  test("POST valid answers returns ok", async () => {
    const askUserService = new AskUserService();
    const app = createTestApp(askUserService);
    const id = await createQuestion(askUserService);

    const res = await app.request(`/api/questions/${id}`, {
      method: "POST",
      body: JSON.stringify({ answers: [["Yes"]] }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("POST error response returns ok", async () => {
    const askUserService = new AskUserService();
    const app = createTestApp(askUserService);
    const id = await createQuestion(askUserService);

    const res = await app.request(`/api/questions/${id}`, {
      method: "POST",
      body: JSON.stringify({ isError: true, reason: "Cancelled" }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("POST invalid body returns 400", async () => {
    const askUserService = new AskUserService();
    const app = createTestApp(askUserService);
    const id = await createQuestion(askUserService);

    const res = await app.request(`/api/questions/${id}`, {
      method: "POST",
      body: JSON.stringify({ answers: ["Yes"] }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: "BAD_REQUEST", message: "body must contain answers or isError response" },
    });
  });

  test("POST missing id returns 404", async () => {
    const app = createTestApp(new AskUserService());

    const res = await app.request("/api/questions/missing", {
      method: "POST",
      body: JSON.stringify({ answers: [["Yes"]] }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: "QUESTION_NOT_FOUND", message: "Question not found: missing" },
    });
  });
});

afterAll(async () => {
  await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
});
