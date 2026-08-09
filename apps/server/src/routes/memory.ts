import { Hono } from "hono";
import {
  MemoryCapacityError,
  MemoryRevisionConflictError,
  MemorySecretError,
  MemoryValidationError,
  type AgentRuntime,
} from "@archcode/agent-core";
import { z } from "zod/v4";
import { readBoundedJsonBody } from "../request-body";
import { resolveProject } from "../resolve";
import { ServerError } from "../errors";
import { zValidator } from "../validation";

const MemoryParamsSchema = z.strictObject({ slug: z.string().min(1) });
const MemoryTopicParamsSchema = z.strictObject({
  slug: z.string().min(1),
  name: z.string().min(1),
});
const ExpectedRevisionSchema = z.string().min(1).nullable();
const PutPreferencesSchema = z.strictObject({
  content: z.string(),
  expectedRevision: ExpectedRevisionSchema,
});
const PutTopicSchema = z.strictObject({
  title: z.string().trim().optional(),
  description: z.string().trim(),
  type: z.enum(["user", "feedback", "project", "reference"]),
  content: z.string(),
  expectedRevision: ExpectedRevisionSchema,
});
const DeleteMemorySchema = z.strictObject({
  expectedRevision: ExpectedRevisionSchema,
});
const MAX_MEMORY_HTTP_BODY_BYTES = 64 * 1024;

export function createMemoryRoutes(runtime: AgentRuntime): Hono {
  const app = new Hono();

  app.get("/:slug/memory", zValidator("param", MemoryParamsSchema), async (c) => {
    const project = await resolveProject(runtime, c.req.valid("param").slug);
    return c.json(await runMemoryOperation(() => runtime.getMemorySnapshot(project.workspaceRoot)));
  });

  app.get("/:slug/memory/preferences", zValidator("param", MemoryParamsSchema), async (c) => {
    const service = await resolveMemoryService(runtime, c.req.valid("param").slug);
    return c.json(await runMemoryOperation(() => service.readPreferences()));
  });

  app.put("/:slug/memory/preferences", zValidator("param", MemoryParamsSchema), async (c) => {
    const service = await resolveMemoryService(runtime, c.req.valid("param").slug);
    const input = await parseBody(c.req.raw, PutPreferencesSchema);
    return c.json(await runMemoryOperation(() => service.putPreferences(input)));
  });

  app.delete("/:slug/memory/preferences", zValidator("param", MemoryParamsSchema), async (c) => {
    const service = await resolveMemoryService(runtime, c.req.valid("param").slug);
    const input = await parseBody(c.req.raw, DeleteMemorySchema);
    await runMemoryOperation(() => service.deletePreferences(input));
    return c.body(null, 204);
  });

  app.get("/:slug/memory/topics/:name", zValidator("param", MemoryTopicParamsSchema), async (c) => {
    const { slug, name } = c.req.valid("param");
    const service = await resolveMemoryService(runtime, slug);
    const item = await runMemoryOperation(() => service.readTopic(name));
    if (item === null) throw memoryNotFound("topic");
    return c.json(item);
  });

  app.put("/:slug/memory/topics/:name", zValidator("param", MemoryTopicParamsSchema), async (c) => {
    const { slug, name } = c.req.valid("param");
    const service = await resolveMemoryService(runtime, slug);
    const input = await parseBody(c.req.raw, PutTopicSchema);
    return c.json(await runMemoryOperation(() => service.putTopic({
      name,
      ...input,
      title: input.title || name,
    })));
  });

  app.delete("/:slug/memory/topics/:name", zValidator("param", MemoryTopicParamsSchema), async (c) => {
    const { slug, name } = c.req.valid("param");
    const service = await resolveMemoryService(runtime, slug);
    const input = await parseBody(c.req.raw, DeleteMemorySchema);
    await runMemoryOperation(() => service.deleteTopic({ name, ...input }));
    return c.body(null, 204);
  });

  return app;
}

async function resolveMemoryService(runtime: AgentRuntime, slug: string) {
  const project = await resolveProject(runtime, slug);
  return (await runMemoryOperation(
    () => runtime.contextResolver.resolve(project.workspaceRoot),
  )).memory;
}

async function parseBody<Schema extends z.ZodType>(
  request: Request,
  schema: Schema,
): Promise<z.output<Schema>> {
  const value = await readBoundedJsonBody(request, {
    maxBytes: MAX_MEMORY_HTTP_BODY_BYTES,
    label: "Memory request body",
  });
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ServerError("BAD_REQUEST", "Invalid Memory request body", 400, {
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
  return result.data;
}

async function runMemoryOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof MemoryRevisionConflictError) {
      throw new ServerError(
        "MEMORY_REVISION_CONFLICT",
        "Memory changed. Reload it before saving.",
        409,
        {
          expectedRevision: error.expectedRevision,
          actualRevision: error.actualRevision,
        },
      );
    }
    if (error instanceof MemoryCapacityError) {
      throw new ServerError(
        "MEMORY_CAPACITY_EXCEEDED",
        "Memory capacity would be exceeded.",
        422,
        { bytes: error.bytes, maxBytes: error.maxBytes },
      );
    }
    if (error instanceof MemoryValidationError) {
      throw new ServerError("MEMORY_INVALID_INPUT", error.message, 422);
    }
    if (error instanceof MemorySecretError) {
      throw new ServerError(
        "MEMORY_SECRET_DETECTED",
        "Memory content contains a potential secret.",
        422,
      );
    }
    throw new ServerError(
      "MEMORY_OPERATION_FAILED",
      "Memory operation failed.",
      500,
    );
  }
}

function memoryNotFound(target: "topic"): ServerError {
  return new ServerError("MEMORY_NOT_FOUND", `Memory ${target} was not found.`, 404);
}
