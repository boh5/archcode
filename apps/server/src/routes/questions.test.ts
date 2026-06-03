import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { SpecraRuntime } from "@specra/agent-core";
import { AskUserService } from "../ask-user-service";
import { errorHandler } from "../error-handler";
import { createQuestionsRoutes } from "./questions";

const QUESTION_ID = "question-1";

function createRuntime() {
  return {
    respondQuestion: mock((id: string) => id === QUESTION_ID),
  } as unknown as SpecraRuntime;
}

function createTestApp(askUserService: AskUserService): Hono {
  const app = new Hono();
  app.onError(errorHandler);
  app.route("/api/questions", createQuestionsRoutes(askUserService));
  return app;
}

describe("question routes", () => {
  test("POST valid answers returns ok", async () => {
    const askUserService = new AskUserService(createRuntime());
    const app = createTestApp(askUserService);

    const res = await app.request(`/api/questions/${QUESTION_ID}`, {
      method: "POST",
      body: JSON.stringify({ answers: [["Yes"]] }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, questionId: QUESTION_ID, status: "answered" });
  });

  test("POST error response returns ok", async () => {
    const askUserService = new AskUserService(createRuntime());
    const app = createTestApp(askUserService);

    const res = await app.request(`/api/questions/${QUESTION_ID}`, {
      method: "POST",
      body: JSON.stringify({ isError: true, reason: "Cancelled" }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, questionId: QUESTION_ID, status: "answered" });
  });

  test("POST invalid body returns 400", async () => {
    const askUserService = new AskUserService(createRuntime());
    const app = createTestApp(askUserService);

    const res = await app.request(`/api/questions/${QUESTION_ID}`, {
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
    const app = createTestApp(new AskUserService(createRuntime()));

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
