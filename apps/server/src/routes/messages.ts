import { Hono } from "hono";
import { AgentRunningError, ConcurrentSessionLimitError } from "@archcode/agent-core";
import type { AgentRuntime } from "@archcode/agent-core";
import {
  BadRequestError,
  ConcurrentSessionLimitHttpError,
  ServerError,
} from "../errors";
import { resolveProject } from "../resolve";

interface MessageBody {
  text?: unknown;
}

class AgentAlreadyRunningError extends ServerError {
  constructor() {
    super("BAD_REQUEST", new AgentRunningError().message, 409);
    this.name = "AgentAlreadyRunningError";
  }
}

export function createMessagesRoutes(runtime: AgentRuntime): Hono {
  const app = new Hono();

  app.post("/messages", async (c) => {
    const slug = requiredParam(c.req.param("slug"), "slug");
    const sessionId = requiredParam(c.req.param("sessionId"), "sessionId");
    const body = await readMessageBody(c.req.json());
    const text = readMessageText(body);
    const project = await resolveProject(runtime, slug);

    try {
      runtime.startSessionExecution({ slug, sessionId, workspaceRoot: project.workspaceRoot, userMessage: text });
      return c.json({ ok: true }, 202);
    } catch (error) {
      if (error instanceof AgentRunningError) {
        throw new AgentAlreadyRunningError();
      }
      if (error instanceof ConcurrentSessionLimitError) {
        throw new ConcurrentSessionLimitHttpError(error.current, error.max);
      }
      throw error;
    }
  });

  app.post("/abort", async (c) => {
    const slug = requiredParam(c.req.param("slug"), "slug");
    const sessionId = requiredParam(c.req.param("sessionId"), "sessionId");
    const project = await resolveProject(runtime, slug);
    const aborted = runtime.abortSessionExecution(project.workspaceRoot, sessionId);

    return c.json({ ok: true, aborted });
  });

  return app;
}

function requiredParam(value: string | undefined, name: string): string {
  if (!value) {
    throw new BadRequestError(`${name} is required`);
  }

  return value;
}

async function readMessageBody(bodyPromise: Promise<unknown>): Promise<MessageBody> {
  try {
    const body = await bodyPromise;
    if (!body || typeof body !== "object") {
      throw new BadRequestError("text is required");
    }

    return body;
  } catch (error) {
    if (error instanceof BadRequestError) {
      throw error;
    }

    throw new BadRequestError("Invalid JSON body");
  }
}

function readMessageText(body: MessageBody): string {
  if (typeof body.text !== "string" || body.text.trim() === "") {
    throw new BadRequestError("text is required");
  }

  return body.text;
}
