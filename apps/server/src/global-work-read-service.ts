import type { AgentRuntime, ProjectInfo } from "@archcode/agent-core";
import {
  projectTodoContentExcerpt,
  type Automation,
  type ProjectTodo,
  type RootSessionSummary,
  type SessionSummary,
  type WorkbenchProjectReadError,
  type WorkSearchResponse,
  type WorkSearchResult,
} from "@archcode/protocol";

const SEARCH_LIMIT = 100;

/** Stateless cross-project search composition boundary. */
export class GlobalWorkReadService {
  readonly #runtime: AgentRuntime;

  constructor(runtime: AgentRuntime) {
    this.#runtime = runtime;
  }

  async search(query: string): Promise<WorkSearchResponse> {
    const normalized = query.trim();
    const projects = await this.#runtime.projectRegistry.list();
    const settled = await Promise.allSettled(projects.map(async (project) => {
      const [summaries, automations, context] = await Promise.all([
        this.#runtime.listSessions(project.workspaceRoot),
        this.#runtime.listAutomations(project.workspaceRoot),
        this.#runtime.contextResolver.resolve(project.workspaceRoot),
      ]);
      const sessions = summaries
        .filter((session) => session.parentSessionId === undefined)
        .map(requireRootSummary);
      return { project, sessions, automations, todos: await context.todos.listTodos() };
    }));
    const results: WorkSearchResult[] = [];
    const projectErrors: WorkbenchProjectReadError[] = [];

    settled.forEach((result, index) => {
      const project = projects[index]!;
      if (result.status === "rejected") {
        projectErrors.push(toProjectError(project));
      } else {
        results.push(...searchProject(normalized, result.value));
      }
    });

    return {
      results: results.slice(0, SEARCH_LIMIT),
      truncated: results.length > SEARCH_LIMIT,
      projectErrors,
    };
  }
}

function searchProject(
  query: string,
  facts: {
    project: ProjectInfo;
    sessions: readonly RootSessionSummary[];
    automations: readonly Automation[];
    todos: readonly ProjectTodo[];
  },
): WorkSearchResult[] {
  const needle = query.toLocaleLowerCase();
  const project = { slug: facts.project.slug, name: facts.project.name };
  const results: WorkSearchResult[] = [];
  if (matches(needle, facts.project.name, facts.project.slug)) {
    results.push({ kind: "project", project, entityId: facts.project.slug, title: facts.project.name, href: projectHref(facts.project.slug) });
  }
  for (const todo of facts.todos) {
    if (!matches(needle, todo.id, todo.content)) continue;
    results.push({
      kind: "todo",
      project,
      entityId: todo.id,
      title: projectTodoContentExcerpt(todo.content),
      href: todoHref(facts.project.slug, todo.id),
      context: todo.archivedAt === undefined ? todo.status : "archived",
    });
  }
  for (const session of facts.sessions) {
    if (!matches(needle, session.sessionId, session.title, session.source.kind, JSON.stringify(session.source))) continue;
    results.push({ kind: "session", project, entityId: session.sessionId, title: session.title ?? "Untitled session", href: sessionHref(facts.project.slug, session.sessionId), context: sourceContext(session) });
  }
  for (const automation of facts.automations) {
    if (!matches(needle, automation.id, automation.name, automation.action.message, JSON.stringify(automation.trigger), JSON.stringify(automation.origin))) continue;
    results.push({ kind: "automation", project, entityId: automation.id, title: automation.name, href: automationHref(facts.project.slug, automation.id), context: automation.status });
  }
  return results;
}

function requireRootSummary(summary: SessionSummary): RootSessionSummary {
  if (summary.parentSessionId !== undefined || summary.rootSessionId !== summary.sessionId || summary.source === undefined) {
    throw new Error(`Invalid root Session summary: ${summary.sessionId}`);
  }
  return summary as RootSessionSummary;
}

function sourceContext(session: RootSessionSummary): string {
  switch (session.source.kind) {
    case "direct": return session.agentName;
    case "todo": return `Todo ${session.source.todoId}`;
    case "automation": return `Automation ${session.source.automationId}`;
  }
}

function matches(needle: string, ...values: Array<string | null | undefined>): boolean {
  return values.some((value) => value?.toLocaleLowerCase().includes(needle) === true);
}

function projectHref(projectSlug: string): string {
  return `/projects/${encodeURIComponent(projectSlug)}/todos`;
}

function todoHref(projectSlug: string, todoId: string): string {
  return `${projectHref(projectSlug)}/${encodeURIComponent(todoId)}`;
}

function sessionHref(projectSlug: string, sessionId: string): string {
  return `/projects/${encodeURIComponent(projectSlug)}/sessions/${encodeURIComponent(sessionId)}`;
}

function automationHref(projectSlug: string, automationId: string): string {
  return `/projects/${encodeURIComponent(projectSlug)}/automations/${encodeURIComponent(automationId)}`;
}

function toProjectError(project: ProjectInfo): WorkbenchProjectReadError {
  return {
    project: { slug: project.slug, name: project.name },
    message: "Project work is temporarily unavailable",
  };
}
