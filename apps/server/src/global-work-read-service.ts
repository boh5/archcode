import type { AgentRuntime, ProjectInfo } from "@archcode/agent-core";
import {
  projectTodoContentExcerpt,
  type Automation,
  type GlobalSSEHitlEntry,
  type HomeResponse,
  type HomeSummaryItem,
  type ProjectAutomationInventoryItem,
  type ProjectSessionInventoryItem,
  type ProjectTodo,
  type RootSessionSummary,
  type SessionFamilyActivity,
  type SessionSummary,
  type WorkbenchProjectReadError,
  type WorkSearchResponse,
  type WorkSearchResult,
} from "@archcode/protocol";

import {
  readProjectAutomationInventory,
  readProjectSessionInventory,
} from "./project-inventory-read";

interface ProjectHomeFacts {
  readonly project: ProjectInfo;
  readonly sessions: ProjectSessionInventoryItem[];
  readonly automations: ProjectAutomationInventoryItem[];
  readonly todos: readonly ProjectTodo[];
  readonly hitl: readonly GlobalSSEHitlEntry[];
  readonly activities: ReadonlyMap<string, Exclude<SessionFamilyActivity, "idle">>;
}

const SEARCH_LIMIT = 100;

/** Stateless, cross-project Home and global-search composition boundary. */
export class GlobalWorkReadService {
  readonly #runtime: AgentRuntime;

  constructor(runtime: AgentRuntime) {
    this.#runtime = runtime;
  }

  async readHome(): Promise<HomeResponse> {
    const projects = await this.#runtime.projectRegistry.list();
    const settled = await Promise.allSettled(projects.map(async (project) => await this.#readProjectHome(project)));
    const needsYou: HomeSummaryItem[] = [];
    const running: HomeSummaryItem[] = [];
    const readyToReview: HomeSummaryItem[] = [];
    const upcoming: HomeSummaryItem[] = [];
    const projectErrors: WorkbenchProjectReadError[] = [];

    settled.forEach((result, index) => {
      const project = projects[index]!;
      if (result.status === "rejected") {
        projectErrors.push(toProjectError(project, result.reason));
        return;
      }
      const projection = projectHomeProjection(result.value);
      needsYou.push(...projection.needsYou);
      running.push(...projection.running);
      readyToReview.push(...projection.readyToReview);
      upcoming.push(...projection.upcoming);
    });

    needsYou.sort(compareNeedsYou);
    running.sort(compareNewestFirst);
    readyToReview.sort(compareNewestFirst);
    upcoming.sort((left, right) => left.sortAt - right.sortAt || left.href.localeCompare(right.href));
    return { needsYou, running, readyToReview, upcoming, projectErrors };
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
    const matches: WorkSearchResult[] = [];
    const projectErrors: WorkbenchProjectReadError[] = [];

    settled.forEach((result, index) => {
      const project = projects[index]!;
      if (result.status === "rejected") {
        projectErrors.push(toProjectError(project, result.reason));
      } else {
        matches.push(...searchProject(normalized, result.value));
      }
    });

    return {
      results: matches.slice(0, SEARCH_LIMIT),
      truncated: matches.length > SEARCH_LIMIT,
      projectErrors,
    };
  }

  async #readProjectHome(project: ProjectInfo): Promise<ProjectHomeFacts> {
    const [sessions, automations, context, controlPlane] = await Promise.all([
      readProjectSessionInventory(this.#runtime, project.workspaceRoot),
      readProjectAutomationInventory(this.#runtime, project.workspaceRoot),
      this.#runtime.contextResolver.resolve(project.workspaceRoot),
      this.#runtime.getProjectControlPlaneSnapshot(project.workspaceRoot, project.slug),
    ]);
    return {
      project,
      sessions,
      automations,
      todos: await context.todos.listTodos(),
      hitl: controlPlane.hitl.entries,
      activities: new Map(controlPlane.sessionRuntime.families.map((family) => [
        family.rootSessionId,
        family.activity as Exclude<SessionFamilyActivity, "idle">,
      ])),
    };
  }
}

function projectHomeProjection(facts: ProjectHomeFacts): Omit<HomeResponse, "projectErrors"> {
  const project = { slug: facts.project.slug, name: facts.project.name };
  const sessionsById = new Map(facts.sessions.map((item) => [item.session.sessionId, item]));
  const attentionRootIds = new Set<string>();
  const attentionAutomationIds = new Set<string>();
  const hitlRootIds = new Set(facts.hitl.map((entry) => entry.rootSessionId));
  const needsYou: HomeSummaryItem[] = [];

  for (const entry of [...facts.hitl].sort((left, right) => hitlPriority(left) - hitlPriority(right) || Date.parse(left.view.createdAt) - Date.parse(right.view.createdAt))) {
    if (attentionRootIds.has(entry.rootSessionId)) continue;
    attentionRootIds.add(entry.rootSessionId);
    const inspection = entry.view.requiresInspection === true;
    needsYou.push({
      kind: "hitl",
      project,
      entityId: entry.hitlId,
      title: inspection ? "Needs manual inspection" : entry.view.displayPayload.title,
      status: inspection ? "inspection" : entry.view.source.type === "tool_permission" ? "permission" : "question",
      href: sessionHref(facts.project.slug, entry.rootSessionId, hitlSearch(entry)),
      sortAt: Date.parse(entry.view.createdAt),
      ...(entry.view.displayPayload.summary === undefined ? {} : { context: entry.view.displayPayload.summary }),
    });
  }

  for (const item of facts.sessions) {
    const goal = item.session.goal;
    if (attentionRootIds.has(item.session.sessionId) || (goal?.status !== "blocked" && goal?.status !== "budget_limited")) continue;
    attentionRootIds.add(item.session.sessionId);
    needsYou.push({
      kind: "session",
      project,
      entityId: item.session.sessionId,
      title: item.session.title ?? "Untitled session",
      status: goal.status,
      href: sessionHref(facts.project.slug, item.session.sessionId),
      sortAt: goal.updatedAt,
      context: goal.blockedReason ?? goal.objective,
    });
  }

  for (const item of facts.sessions) {
    const execution = item.latestExecution;
    if (attentionRootIds.has(item.session.sessionId) || execution === null || (execution.status !== "failed" && execution.status !== "timed_out")) continue;
    attentionRootIds.add(item.session.sessionId);
    needsYou.push({
      kind: "session",
      project,
      entityId: item.session.sessionId,
      title: item.session.title ?? "Untitled session",
      status: execution.status,
      href: sessionHref(facts.project.slug, item.session.sessionId),
      sortAt: execution.endedAt ?? execution.startedAt,
    });
  }

  for (const item of facts.automations) {
    const invocation = item.latestInvocation;
    if (invocation === null || (invocation.status !== "failed" && invocation.status !== "missed")) continue;
    attentionAutomationIds.add(item.automation.id);
    needsYou.push({
      kind: "automation",
      project,
      entityId: item.automation.id,
      title: item.automation.name,
      status: invocation.status,
      href: automationHref(facts.project.slug, item.automation.id, invocation.id),
      sortAt: Date.parse(invocation.completedAt ?? invocation.createdAt),
    });
  }

  const running = [...facts.activities].flatMap(([rootSessionId, activity]): HomeSummaryItem[] => {
    if (attentionRootIds.has(rootSessionId)) return [];
    const item = sessionsById.get(rootSessionId);
    if (item === undefined) return [];
    return [{
      kind: "session",
      project,
      entityId: rootSessionId,
      title: item.session.title ?? "Untitled session",
      status: activity,
      href: sessionHref(facts.project.slug, rootSessionId),
      sortAt: item.session.updatedAt,
      context: sourceContext(item.session),
    }];
  });

  const readyToReview = facts.todos.flatMap((todo): HomeSummaryItem[] => {
    if (todo.archivedAt !== undefined || todo.status !== "in_progress") return [];
    const workSessions = facts.sessions
      .filter((item) => (
        item.session.source.kind === "todo"
          ? item.session.source.todoId === todo.id && item.session.source.entry === "work"
          : item.session.source.kind === "automation" && item.session.source.todoId === todo.id
      ))
      .sort((left, right) => right.session.updatedAt - left.session.updatedAt || right.session.sessionId.localeCompare(left.session.sessionId));
    if (workSessions.length === 0) return [];
    if (workSessions.some((item) => facts.activities.has(item.session.sessionId)
      || hitlRootIds.has(item.session.sessionId)
      || attentionRootIds.has(item.session.sessionId))) return [];
    const latest = workSessions[0]!;
    if (latest.latestExecution?.status !== "completed") return [];
    return [{
      kind: "todo",
      project,
      entityId: todo.id,
      title: projectTodoContentExcerpt(todo.content),
      status: "ready_to_review",
      href: todoHref(facts.project.slug, todo.id),
      sortAt: Math.max(todo.updatedAt, latest.session.updatedAt),
      context: latest.session.title ?? "Completed work Session",
    }];
  });

  const upcoming = facts.automations.flatMap((item): HomeSummaryItem[] => {
    if (attentionAutomationIds.has(item.automation.id) || item.automation.status !== "active" || item.automation.nextFireAt === undefined) return [];
    return [{
      kind: "automation",
      project,
      entityId: item.automation.id,
      title: item.automation.name,
      status: "scheduled",
      href: automationHref(facts.project.slug, item.automation.id),
      sortAt: Date.parse(item.automation.nextFireAt),
      context: item.automation.nextFireAt,
    }];
  });

  return { needsYou, running, readyToReview, upcoming };
}

function searchProject(
  query: string,
  facts: { project: ProjectInfo; sessions: readonly RootSessionSummary[]; automations: readonly Automation[]; todos: readonly ProjectTodo[] },
): WorkSearchResult[] {
  const needle = query.toLocaleLowerCase();
  const project = { slug: facts.project.slug, name: facts.project.name };
  const results: WorkSearchResult[] = [];
  if (matches(needle, facts.project.name, facts.project.slug)) {
    results.push({ kind: "project", project, entityId: facts.project.slug, title: facts.project.name, href: projectHref(facts.project.slug) });
  }
  for (const todo of facts.todos) {
    if (!matches(needle, todo.id, todo.content)) continue;
    results.push({ kind: "todo", project, entityId: todo.id, title: projectTodoContentExcerpt(todo.content), href: todoHref(facts.project.slug, todo.id), context: todo.status });
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

function compareNeedsYou(left: HomeSummaryItem, right: HomeSummaryItem): number {
  const priority = needsYouPriority(left) - needsYouPriority(right);
  return priority || compareNewestFirst(left, right);
}

function needsYouPriority(item: HomeSummaryItem): number {
  if (item.kind === "hitl") return item.status === "inspection" ? 0 : 1;
  if (item.kind === "session" && (item.status === "blocked" || item.status === "budget_limited")) return 2;
  if (item.kind === "session") return 3;
  return 4;
}

function compareNewestFirst(left: HomeSummaryItem, right: HomeSummaryItem): number {
  return right.sortAt - left.sortAt || left.href.localeCompare(right.href);
}

function hitlPriority(entry: GlobalSSEHitlEntry): number {
  return entry.view.requiresInspection === true ? 0 : 1;
}

function hitlSearch(entry: GlobalSSEHitlEntry): URLSearchParams {
  const search = new URLSearchParams({ hitl: entry.hitlId });
  if (entry.ownerSessionId !== entry.rootSessionId) search.set("focus", entry.ownerSessionId);
  return search;
}

function projectHref(projectSlug: string): string {
  return `/projects/${encodeURIComponent(projectSlug)}/todos`;
}

function todoHref(projectSlug: string, todoId: string): string {
  return `${projectHref(projectSlug)}/${encodeURIComponent(todoId)}`;
}

function sessionHref(projectSlug: string, sessionId: string, search?: URLSearchParams): string {
  const href = `/projects/${encodeURIComponent(projectSlug)}/sessions/${encodeURIComponent(sessionId)}`;
  return search === undefined ? href : `${href}?${search.toString()}`;
}

function automationHref(projectSlug: string, automationId: string, invocationId?: string): string {
  const href = `/projects/${encodeURIComponent(projectSlug)}/automations/${encodeURIComponent(automationId)}`;
  return invocationId === undefined ? href : `${href}?invocation=${encodeURIComponent(invocationId)}`;
}

function toProjectError(project: ProjectInfo, error: unknown): WorkbenchProjectReadError {
  void error;
  return {
    project: { slug: project.slug, name: project.name },
    message: "Project work is temporarily unavailable",
  };
}
