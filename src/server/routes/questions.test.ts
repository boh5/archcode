import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AskUserRequest } from "../../tools/types";
import { AskUserService } from "../ask-user-service";
import { errorHandler } from "../error-handler";
import { EventRing } from "../event-ring";
import { createQuestionsRoutes } from "./questions";

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
  const ring = new EventRing();
  void askUserService.request("session-1", askRequest, ring);

  return (JSON.parse(ring.since(0)[0].data) as { id: string }).id;
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
