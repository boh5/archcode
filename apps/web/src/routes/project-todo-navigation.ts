import { rootSessionSourceTodoId } from "@archcode/protocol";
import type {
  ProjectAutomationInventoryItem,
  ProjectSessionInventoryItem,
  ProjectTodo,
  SessionFamilyActivity,
} from "@archcode/protocol";
import type { ProjectTodoOperationalState } from "./project-todo-presentation";
import { sessionInventoryIsActive } from "../lib/session-family-presentation";
import {
  deriveProjectTodoNeedsUser,
  deriveProjectTodoOperationalState,
  projectTodoDisplayLead,
} from "./project-todo-presentation";

export type ProjectNavigationDependencyState = "loading" | "ready" | "error";

export interface ProjectTodoNavigationRow {
  readonly todo: ProjectTodo;
  readonly label: string;
  readonly current: boolean;
  /** Exact request + Goal-gate count. Present only in the Needs-you group. */
  readonly attentionCount?: number;
  readonly operationalState?: ProjectTodoOperationalState;
}

export interface ProjectTodoNavigationGroup {
  readonly count?: number;
  readonly rows: readonly ProjectTodoNavigationRow[];
  readonly state: ProjectNavigationDependencyState;
}

export interface ProjectTodoNavigationProjection {
  readonly allTodos: {
    readonly count?: number;
    readonly current: boolean;
    readonly state: ProjectNavigationDependencyState;
  };
  readonly needsYou: ProjectTodoNavigationGroup;
  readonly inProgress: ProjectTodoNavigationGroup;
  readonly ready: ProjectTodoNavigationGroup;
  readonly runs: {
    readonly count?: number;
    readonly current: boolean;
    readonly state: ProjectNavigationDependencyState;
  };
  readonly schedules: {
    readonly count?: number;
    readonly current: boolean;
    readonly state: ProjectNavigationDependencyState;
  };
}

export interface ProjectTodoNavigationFacts {
  readonly slug: string;
  readonly pathname: string;
  readonly selectedTodoId?: string;
  readonly selectedSessionId?: string;
  readonly todos: readonly ProjectTodo[];
  readonly sessions: readonly ProjectSessionInventoryItem[];
  readonly automations: readonly ProjectAutomationInventoryItem[];
  readonly activityBySessionId: ReadonlyMap<string, SessionFamilyActivity>;
  readonly attentionBySessionId: ReadonlyMap<string, "Inspection" | "Permission" | "Question">;
  readonly attentionCountBySessionId: ReadonlyMap<string, number>;
  readonly todosState: ProjectNavigationDependencyState;
  readonly sessionsState: ProjectNavigationDependencyState;
  readonly automationsState: ProjectNavigationDependencyState;
  readonly hitlState: ProjectNavigationDependencyState;
  readonly runtimeState: ProjectNavigationDependencyState;
}

export function deriveProjectTodoNavigationProjection(
  facts: ProjectTodoNavigationFacts,
): ProjectTodoNavigationProjection {
  const needsYouDependencies = combineDependencyStates([
    facts.todosState,
    facts.sessionsState,
    facts.hitlState,
  ]);
  const operationalDependencies = combineDependencyStates([
    needsYouDependencies,
    facts.automationsState,
    facts.runtimeState,
  ]);
  const runsDependencies = combineDependencyStates([
    facts.sessionsState,
    facts.hitlState,
    facts.runtimeState,
  ]);
  const selectedSession = facts.selectedSessionId === undefined
    ? undefined
    : facts.sessions.find(({ session }) => session.sessionId === facts.selectedSessionId)?.session;
  const sourceTodoId = selectedSession === undefined
    ? undefined
    : rootSessionSourceTodoId(selectedSession.source);
  const activeTodoId = facts.selectedTodoId ?? sourceTodoId;
  const activeSessionSource = selectedSession?.source;
  const isTodoInventory = facts.pathname === `/projects/${encodeURIComponent(facts.slug)}/todos`;
  const sessionInventory = facts.pathname === `/projects/${encodeURIComponent(facts.slug)}/sessions`;
  const automationInventory = facts.pathname.startsWith(`/projects/${encodeURIComponent(facts.slug)}/automations`);
  const runsCurrent = sessionInventory || (activeSessionSource?.kind === "direct");
  const schedulesCurrent = automationInventory
    || (activeSessionSource?.kind === "automation" && sourceTodoId === undefined);

  const operationalStateByTodoId = new Map<string, ProjectTodoOperationalState>();
  if (operationalDependencies === "ready") {
    for (const todo of facts.todos) {
      const state = deriveProjectTodoOperationalState({
        todo,
        sessions: facts.sessions,
        automations: facts.automations,
        activityBySessionId: facts.activityBySessionId,
        attentionBySessionId: facts.attentionBySessionId,
        authoritative: true,
      });
      if (state !== undefined) operationalStateByTodoId.set(todo.id, state);
    }
  }

  const needsYouTodos = needsYouDependencies === "ready"
    ? facts.todos.filter((todo) => deriveProjectTodoNeedsUser(todo, facts.sessions, facts.attentionBySessionId))
    : [];
  const needsYouIds = new Set(needsYouTodos.map((todo) => todo.id));
  const activeSessionCount = runsDependencies === "ready"
    ? facts.sessions.filter((item) => sessionInventoryIsActive(
      item,
      facts.activityBySessionId.get(item.session.sessionId),
      facts.attentionBySessionId.has(item.session.sessionId),
    )).length
    : undefined;
  const selectedTodoUsesWorkSurface = facts.selectedTodoId !== undefined
    && facts.pathname === `/projects/${encodeURIComponent(facts.slug)}/todos/${encodeURIComponent(facts.selectedTodoId)}/work`;
  const row = (todo: ProjectTodo, group: "needs" | "lifecycle"): ProjectTodoNavigationRow => ({
    todo,
    label: projectTodoDisplayLead(todo.content) || "Untitled Todo",
    current: activeTodoId === todo.id && (facts.selectedTodoId !== undefined
      ? group === (selectedTodoUsesWorkSurface && needsYouIds.has(todo.id) ? "needs" : "lifecycle")
      : group === (needsYouIds.has(todo.id) ? "needs" : "lifecycle")),
    ...(group === "needs" ? { attentionCount: todoAttentionCount(todo, facts) } : {}),
    ...(operationalStateByTodoId.has(todo.id)
      ? { operationalState: operationalStateByTodoId.get(todo.id)! }
      : {}),
  });

  return {
    allTodos: {
      state: facts.todosState,
      current: isTodoInventory,
      ...(facts.todosState === "ready" ? {
        count: facts.todos.filter((todo) => todo.archivedAt === undefined && todo.status !== "rejected").length,
      } : {}),
    },
    needsYou: {
      state: needsYouDependencies,
      rows: needsYouTodos.map((todo) => row(todo, "needs")),
      ...(needsYouDependencies === "ready" ? { count: needsYouTodos.length } : {}),
    },
    inProgress: lifecycleGroup(
      facts.todosState,
      facts.todos.filter((todo) => todo.archivedAt === undefined && todo.status === "in_progress"),
      row,
    ),
    ready: lifecycleGroup(
      facts.todosState,
      facts.todos.filter((todo) => todo.archivedAt === undefined && todo.status === "ready"),
      row,
    ),
    runs: {
      state: runsDependencies,
      current: runsCurrent,
      ...(activeSessionCount === undefined ? {} : { count: activeSessionCount }),
    },
    schedules: {
      state: facts.automationsState,
      current: schedulesCurrent,
      ...(facts.automationsState === "ready" ? { count: facts.automations.length } : {}),
    },
  };
}

function todoAttentionCount(todo: ProjectTodo, facts: ProjectTodoNavigationFacts): number {
  return facts.sessions
    .filter(({ session }) => rootSessionSourceTodoId(session.source) === todo.id)
    .reduce((count, { session }) => {
      const hitlCount = facts.attentionCountBySessionId.get(session.sessionId) ?? 0;
      const workOrAutomation = session.source.kind === "automation"
        || (session.source.kind === "todo" && (session.source.entry === "work" || session.source.entry === "automation"));
      const goalCount = workOrAutomation
        && (session.goal?.status === "blocked" || session.goal?.status === "budget_limited") ? 1 : 0;
      return count + hitlCount + goalCount;
    }, 0);
}

function lifecycleGroup(
  state: ProjectNavigationDependencyState,
  todos: readonly ProjectTodo[],
  row: (todo: ProjectTodo, group: "needs" | "lifecycle") => ProjectTodoNavigationRow,
): ProjectTodoNavigationGroup {
  return {
    state,
    rows: state === "ready" ? todos.map((todo) => row(todo, "lifecycle")) : [],
    ...(state === "ready" ? { count: todos.length } : {}),
  };
}

function combineDependencyStates(
  states: readonly ProjectNavigationDependencyState[],
): ProjectNavigationDependencyState {
  if (states.includes("error")) return "error";
  if (states.includes("loading")) return "loading";
  return "ready";
}
