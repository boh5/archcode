import { Hono } from "hono";
import type { AskUserResponse, AskUserService } from "../ask-user-service";
import { BadRequestError, QuestionNotFoundError } from "../errors";

export function createQuestionsRoutes(askUserService: AskUserService): Hono {
  const app = new Hono();

  app.post("/:id", async (c) => {
    const id = requiredParam(c.req.param("id"), "id");
    const body = await readQuestionBody(c.req.json());

    if (!askUserService.respond(id, body)) {
      throw new QuestionNotFoundError(id);
    }

    return c.json({ ok: true });
  });

  return app;
}

function requiredParam(value: string | undefined, name: string): string {
  if (!value) {
    throw new BadRequestError(`${name} is required`);
  }

  return value;
}

async function readQuestionBody(bodyPromise: Promise<unknown>): Promise<AskUserResponse> {
  try {
    const body = await bodyPromise;
    if (!body || typeof body !== "object") {
      throw new BadRequestError("body must contain answers or isError response");
    }

    return parseQuestionResponse(body);
  } catch (error) {
    if (error instanceof BadRequestError) {
      throw error;
    }

    throw new BadRequestError("Invalid JSON body");
  }
}

function parseQuestionResponse(body: object): AskUserResponse {
  if ("answers" in body && isAnswers(body.answers)) {
    return { answers: body.answers };
  }

  if (
    "isError" in body
    && body.isError === true
    && "reason" in body
    && typeof body.reason === "string"
  ) {
    return { isError: true, reason: body.reason };
  }

  throw new BadRequestError("body must contain answers or isError response");
}

function isAnswers(value: unknown): value is string[][] {
  return Array.isArray(value)
    && value.every((answer) => Array.isArray(answer) && answer.every((item) => typeof item === "string"));
}
