import { useMemo } from "react";
import { useParams } from "react-router-dom";
import {
  useAutomationInventory,
  useProjectTodos,
  useSessionInventory,
} from "../api/queries";
import {
  hitlAttentionCountsByRootSession,
  hitlAttentionLabelsByRootSession,
  useAttentionVisibleScopedHitl,
  useHitlProjectInitialized,
} from "../store/hitl-store";
import {
  runtimeFamilyKey,
  useSessionRuntimeFamilies,
  useSessionRuntimeInitialized,
} from "../store/session-runtime-store";
import {
  deriveProjectTodoNavigationProjection,
  type ProjectNavigationDependencyState,
  type ProjectTodoNavigationProjection,
} from "./project-todo-navigation";

export interface ProjectTodoNavigationResult {
  readonly projection: ProjectTodoNavigationProjection;
  readonly retry: () => void;
  readonly retrying: boolean;
}

export function useProjectTodoNavigation(
  slug: string,
  pathname: string,
): ProjectTodoNavigationResult {
  const params = useParams<{ todoId?: string; sessionId?: string }>();
  const todos = useProjectTodos(slug);
  const sessions = useSessionInventory(slug);
  const automations = useAutomationInventory(slug);
  const scopedHitl = useAttentionVisibleScopedHitl([slug]);
  const hitlInitialized = useHitlProjectInitialized(slug);
  const runtimeFamilies = useSessionRuntimeFamilies();
  const runtimeInitialized = useSessionRuntimeInitialized(slug);

  const attentionBySessionId = useMemo(() => hitlAttentionLabelsByRootSession(scopedHitl), [scopedHitl]);
  const attentionCountBySessionId = useMemo(() => hitlAttentionCountsByRootSession(scopedHitl), [scopedHitl]);
  const activityBySessionId = useMemo(() => new Map((sessions.data ?? []).map(({ session }) => [
    session.sessionId,
    runtimeFamilies[runtimeFamilyKey(slug, session.sessionId)]?.activity ?? "idle",
  ])), [runtimeFamilies, sessions.data, slug]);

  const projection = useMemo(() => deriveProjectTodoNavigationProjection({
    slug,
    pathname,
    selectedTodoId: params.todoId,
    selectedSessionId: params.sessionId,
    todos: todos.data ?? [],
    sessions: sessions.data ?? [],
    automations: automations.data ?? [],
    activityBySessionId,
    attentionBySessionId,
    attentionCountBySessionId,
    todosState: queryState(todos),
    sessionsState: queryState(sessions),
    automationsState: queryState(automations),
    hitlState: hitlInitialized ? "ready" : "loading",
    runtimeState: runtimeInitialized ? "ready" : "loading",
  }), [
    activityBySessionId,
    attentionBySessionId,
    attentionCountBySessionId,
    automations,
    hitlInitialized,
    params.sessionId,
    params.todoId,
    pathname,
    runtimeInitialized,
    sessions,
    slug,
    todos,
  ]);

  return {
    projection,
    retry: () => {
      void todos.refetch();
      void sessions.refetch();
      void automations.refetch();
    },
    retrying: todos.isFetching || sessions.isFetching || automations.isFetching,
  };
}

function queryState(query: {
  readonly isSuccess: boolean;
  readonly error: unknown;
}): ProjectNavigationDependencyState {
  if (query.error !== null) return "error";
  return query.isSuccess ? "ready" : "loading";
}
