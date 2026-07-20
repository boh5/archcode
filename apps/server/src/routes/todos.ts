import { Hono } from "hono";
import type {
  ProjectTodo,
  ProjectTodoActivateInput,
  ProjectTodoCreateInput,
  ProjectTodoUpdateInput,
} from "@archcode/protocol";
import {
  PROJECT_TODO_BODY_MAX_LENGTH,
  PROJECT_TODO_REJECTION_REASON_MAX_LENGTH,
  PROJECT_TODO_TITLE_MAX_LENGTH,
} from "@archcode/protocol";
import type { AgentRuntime } from "@archcode/agent-core";
import { z } from "zod/v4";

import { BadRequestError, ServerError } from "../errors";
import { resolveProject } from "../resolve";
import { zValidator } from "../validation";

const ProjectTodoListParamsSchema = z.strictObject({ slug: z.string().min(1) });
const ProjectTodoParamsSchema = z.strictObject({
  slug: z.string().min(1),
  todoId: z.uuid(),
});
const ProjectTodoExpectedRevisionSchema = z.strictObject({
  expectedRevision: z.number().int().positive(),
});
const ProjectTodoCreateBodySchema = z.strictObject({
  title: z.string().trim().min(1).max(PROJECT_TODO_TITLE_MAX_LENGTH),
  body: z.string().max(PROJECT_TODO_BODY_MAX_LENGTH).optional(),
});
const ProjectTodoUpdateBodySchema = z.strictObject({
  expectedRevision: z.number().int().positive(),
  patch: z.strictObject({
    title: z.string().trim().min(1).max(PROJECT_TODO_TITLE_MAX_LENGTH).optional(),
    body: z.string().max(PROJECT_TODO_BODY_MAX_LENGTH).optional(),
    status: z.enum(["idea", "ready", "done", "rejected"]).optional(),
    rejectionReason: z.string().trim().min(1).max(PROJECT_TODO_REJECTION_REASON_MAX_LENGTH).optional(),
  }).refine((patch) => Object.keys(patch).length > 0, "At least one Todo field is required"),
});
const ProjectTodoActivateBodySchema = z.strictObject({
  expectedRevision: z.number().int().positive(),
  kind: z.enum(["session", "automation"]),
});

export interface ProjectTodoServiceLike {
  listTodos(): Promise<readonly ProjectTodo[]>;
  readTodo(todoId: string): Promise<ProjectTodo>;
  createTodo(input: ProjectTodoCreateInput): Promise<ProjectTodo>;
  updateTodo(todoId: string, input: ProjectTodoUpdateInput): Promise<ProjectTodo>;
  archiveTodo(todoId: string, expectedRevision: number): Promise<ProjectTodo>;
  restoreTodo(todoId: string, expectedRevision: number): Promise<ProjectTodo>;
  discussTodo(todoId: string, expectedRevision: number): Promise<ProjectTodo>;
  activateTodo(todoId: string, input: ProjectTodoActivateInput): Promise<ProjectTodo>;
  returnToReady(todoId: string, expectedRevision: number): Promise<ProjectTodo>;
}

export function createTodosRoutes(runtime: AgentRuntime): Hono {
  const app = new Hono();

  app.get("/:slug/todos", zValidator("param", ProjectTodoListParamsSchema), async (c) => {
    const project = await resolveProject(runtime, c.req.valid("param").slug);
    const service = await resolveTodos(runtime, project.workspaceRoot);
    try {
      return c.json({ todos: await service.listTodos() });
    } catch (error) {
      throw mapTodoError(error);
    }
  });

  app.post("/:slug/todos", zValidator("param", ProjectTodoListParamsSchema), zValidator("json", ProjectTodoCreateBodySchema), async (c) => {
    const project = await resolveProject(runtime, c.req.valid("param").slug);
    const service = await resolveTodos(runtime, project.workspaceRoot);
    try {
      return c.json({ todo: await service.createTodo(c.req.valid("json")) }, 201);
    } catch (error) {
      throw mapTodoError(error);
    }
  });

  app.get("/:slug/todos/:todoId", zValidator("param", ProjectTodoParamsSchema), async (c) => {
    const { slug, todoId } = c.req.valid("param");
    const project = await resolveProject(runtime, slug);
    const service = await resolveTodos(runtime, project.workspaceRoot);
    try {
      return c.json({ todo: await service.readTodo(todoId) });
    } catch (error) {
      throw mapTodoError(error);
    }
  });

  app.patch("/:slug/todos/:todoId", zValidator("param", ProjectTodoParamsSchema), zValidator("json", ProjectTodoUpdateBodySchema), async (c) => {
    const { slug, todoId } = c.req.valid("param");
    const project = await resolveProject(runtime, slug);
    const service = await resolveTodos(runtime, project.workspaceRoot);
    try {
      return c.json({ todo: await service.updateTodo(todoId, c.req.valid("json")) });
    } catch (error) {
      throw mapTodoError(error);
    }
  });

  app.post("/:slug/todos/:todoId/archive", zValidator("param", ProjectTodoParamsSchema), zValidator("json", ProjectTodoExpectedRevisionSchema), async (c) => {
    const { slug, todoId } = c.req.valid("param");
    const project = await resolveProject(runtime, slug);
    const service = await resolveTodos(runtime, project.workspaceRoot);
    try {
      const { expectedRevision } = c.req.valid("json");
      return c.json({ todo: await service.archiveTodo(todoId, expectedRevision) });
    } catch (error) {
      throw mapTodoError(error);
    }
  });

  app.post("/:slug/todos/:todoId/restore", zValidator("param", ProjectTodoParamsSchema), zValidator("json", ProjectTodoExpectedRevisionSchema), async (c) => {
    const { slug, todoId } = c.req.valid("param");
    const project = await resolveProject(runtime, slug);
    const service = await resolveTodos(runtime, project.workspaceRoot);
    try {
      const { expectedRevision } = c.req.valid("json");
      return c.json({ todo: await service.restoreTodo(todoId, expectedRevision) });
    } catch (error) {
      throw mapTodoError(error);
    }
  });

  app.post("/:slug/todos/:todoId/discuss", zValidator("param", ProjectTodoParamsSchema), zValidator("json", ProjectTodoExpectedRevisionSchema), async (c) => {
    const { slug, todoId } = c.req.valid("param");
    const project = await resolveProject(runtime, slug);
    const service = await resolveTodos(runtime, project.workspaceRoot);
    try {
      const { expectedRevision } = c.req.valid("json");
      const todo = await service.discussTodo(todoId, expectedRevision);
      if (todo.discussionSessionId === undefined) {
        throw new Error(`Project Todo discussion did not produce a Session: ${todoId}`);
      }
      return c.json({ todo, sessionId: todo.discussionSessionId });
    } catch (error) {
      throw mapTodoError(error);
    }
  });

  app.post("/:slug/todos/:todoId/activate", zValidator("param", ProjectTodoParamsSchema), zValidator("json", ProjectTodoActivateBodySchema), async (c) => {
    const { slug, todoId } = c.req.valid("param");
    const project = await resolveProject(runtime, slug);
    const service = await resolveTodos(runtime, project.workspaceRoot);
    try {
      const todo = await service.activateTodo(todoId, c.req.valid("json"));
      const sessionId = todo.activation?.sourceSessionId;
      if (sessionId === undefined) {
        throw new Error(`Project Todo activation did not produce a Session: ${todoId}`);
      }
      return c.json({ todo, sessionId });
    } catch (error) {
      throw mapTodoError(error);
    }
  });

  app.post("/:slug/todos/:todoId/return-to-ready", zValidator("param", ProjectTodoParamsSchema), zValidator("json", ProjectTodoExpectedRevisionSchema), async (c) => {
    const { slug, todoId } = c.req.valid("param");
    const project = await resolveProject(runtime, slug);
    const service = await resolveTodos(runtime, project.workspaceRoot);
    try {
      return c.json({ todo: await service.returnToReady(todoId, c.req.valid("json").expectedRevision) });
    } catch (error) {
      throw mapTodoError(error);
    }
  });

  return app;
}

async function resolveTodos(runtime: AgentRuntime, workspaceRoot: string): Promise<ProjectTodoServiceLike> {
  const context = await runtime.contextResolver.resolve(workspaceRoot);
  return context.todos;
}

function mapTodoError(error: unknown): Error {
  if (error instanceof z.ZodError) {
    return new BadRequestError("Request body is invalid", z.treeifyError(error));
  }

  if (hasCode(error, "PROJECT_TODO_NOT_FOUND")) {
    return new ServerError("PROJECT_TODO_NOT_FOUND", error.message, 404, { todoId: error.todoId });
  }

  if (isProjectTodoConflict(error)) {
    return new ServerError(error.code, error.message, 409, error);
  }

  return error instanceof Error ? error : new Error(String(error));
}

function hasCode(error: unknown, code: string): error is Error & { readonly code: string; readonly todoId?: string } {
  return error instanceof Error && "code" in error && error.code === code;
}

type ProjectTodoConflictCode =
  | "PROJECT_TODO_REVISION_CONFLICT"
  | "PROJECT_TODO_INVALID_TRANSITION"
  | "PROJECT_TODO_ARCHIVED"
  | "PROJECT_TODO_ACTIVATION_CONFLICT"
  | "PROJECT_TODO_RESOURCE_BINDING_CONFLICT"
  | "PROJECT_TODO_RETURN_TO_READY_CONFLICT"
  | "PROJECT_TODO_DISCUSSION_UNAUTHORIZED";

const PROJECT_TODO_CONFLICT_CODES: ReadonlySet<string> = new Set<ProjectTodoConflictCode>([
  "PROJECT_TODO_REVISION_CONFLICT",
  "PROJECT_TODO_INVALID_TRANSITION",
  "PROJECT_TODO_ARCHIVED",
  "PROJECT_TODO_ACTIVATION_CONFLICT",
  "PROJECT_TODO_RESOURCE_BINDING_CONFLICT",
  "PROJECT_TODO_RETURN_TO_READY_CONFLICT",
  "PROJECT_TODO_DISCUSSION_UNAUTHORIZED",
]);

function isProjectTodoConflict(error: unknown): error is Error & { readonly code: ProjectTodoConflictCode } {
  return error instanceof Error
    && "code" in error
    && typeof error.code === "string"
    && PROJECT_TODO_CONFLICT_CODES.has(error.code);
}
