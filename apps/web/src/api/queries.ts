import { queryOptions, useQuery } from "@tanstack/react-query";
import { apiFetch } from "./client";
import type { AgentDescriptor, HomeResponse, ModelRuntimeCatalog, WorkSearchResponse } from "@archcode/protocol";
import type {
  DiffFile,
  DirectoryListResponse,
  DirectorySearchResponse,
  Automation,
  AutomationInvocation,
  Project,
  Session,
  SessionSummary,
  ProjectSessionInventoryItem,
  ProjectAutomationInventoryItem,
  ProjectTodoPlan,
  ProjectTodoAttachmentListResponse,
  SessionTreeResponse,
  ProjectTodo,
} from "./types";
import {
  currentSessionSnapshotGeneration,
} from "../store/session-store";

export const queryKeys = {
  agents: ["agents"] as const,
  modelRuntime: ["config", "model-runtime"] as const,
  update: ["update"] as const,
  projects: ["projects"] as const,
  home: ["home"] as const,
  workSearch: (query: string) => ["search", query] as const,
  sessions: (slug: string) => ["projects", slug, "sessions"] as const,
  session: (slug: string, sessionId: string) => ["projects", slug, "sessions", sessionId] as const,
  tree: (slug: string, rootSessionId: string) => ["projects", slug, "sessions", rootSessionId, "tree"] as const,
  diff: (slug: string, sessionId?: string) => ["projects", slug, "diff", sessionId ?? "project"] as const,
  directories: {
    list: (path: string, limit?: number) => ["directories", "list", path, limit] as const,
    search: (query: string, limit?: number) => ["directories", "search", query, limit] as const,
  },
  projectAutomations: (slug: string) => ["projects", slug, "automations"] as const,
  automation: (slug: string, automationId: string) => ["projects", slug, "automations", automationId] as const,
  automationInvocations: (slug: string, automationId: string) => ["projects", slug, "automations", automationId, "invocations"] as const,
  projectTodos: (slug: string) => ["projects", slug, "todos"] as const,
  projectTodoAttachments: (slug: string, todoId: string) => ["projects", slug, "todos", todoId, "attachments"] as const,
};

export function modelRuntimeQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.modelRuntime,
    queryFn: () => apiFetch<ModelRuntimeCatalog>("/api/config/model-runtime"),
  });
}

export function agentsQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.agents,
    queryFn: async () => {
      const response = await apiFetch<{ agents: AgentDescriptor[] }>("/api/agents");
      return response.agents;
    },
  });
}

export function projectsQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.projects,
    queryFn: async () => {
      const response = await apiFetch<{ projects: Project[] }>("/api/projects");
      return response.projects;
    },
  });
}

export function homeQueryOptions() {
  return queryOptions({ queryKey: queryKeys.home, queryFn: () => apiFetch<HomeResponse>("/api/home") });
}

export function workSearchQueryOptions(query: string) {
  const normalized = query.trim();
  return queryOptions({
    queryKey: queryKeys.workSearch(normalized),
    queryFn: () => apiFetch<WorkSearchResponse>(`/api/search?q=${encodeURIComponent(normalized)}`),
    enabled: normalized.length > 0 && normalized.length <= 200,
  });
}

export function sessionsQueryOptions(slug: string) {
  return queryOptions({
    queryKey: queryKeys.sessions(slug),
    queryFn: async () => {
      const response = await apiFetch<{ sessions: ProjectSessionInventoryItem[] }>(
        `/api/projects/${encodeURIComponent(slug)}/sessions`,
      );
      return response.sessions;
    },
    enabled: slug.length > 0,
  });
}

export function sessionQueryOptions(slug: string, sessionId: string) {
  return queryOptions({
    queryKey: queryKeys.session(slug, sessionId),
    queryFn: async () => {
      const generation = currentSessionSnapshotGeneration();
      const snapshot = await apiFetch<Session>(
        `/api/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sessionId)}`,
      );
      return { ...snapshot, snapshotGeneration: generation };
    },
    enabled: slug.length > 0 && sessionId.length > 0,
  });
}

export function focusedSessionQueryOptions(slug: string, focusSessionId: string | null) {
  return queryOptions({
    queryKey: queryKeys.session(slug, focusSessionId ?? ""),
    queryFn: async () => {
      const generation = currentSessionSnapshotGeneration();
      const snapshot = await apiFetch<Session>(
        `/api/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(focusSessionId!)}`,
      );
      return { ...snapshot, snapshotGeneration: generation };
    },
    enabled: slug.length > 0 && focusSessionId !== null && focusSessionId.length > 0,
  });
}

export function diffQueryOptions(slug: string, sessionId?: string) {
  const scopedSessionId = sessionId?.trim() || undefined;
  return queryOptions({
    queryKey: queryKeys.diff(slug, scopedSessionId),
    queryFn: async () => {
      const query = scopedSessionId === undefined ? "" : `?sessionId=${encodeURIComponent(scopedSessionId)}`;
      const response = await apiFetch<{ files: DiffFile[] }>(
        `/api/projects/${encodeURIComponent(slug)}/diff${query}`,
      );
      if (response === null || typeof response !== "object" || !Array.isArray(response.files)) {
        throw new Error("Diff response must use canonical { files } shape");
      }
      return response.files;
    },
    enabled: slug.length > 0,
  });
}

export function useProjects() {
  return useQuery(projectsQueryOptions());
}

export function useHome() {
  return useQuery(homeQueryOptions());
}

export function useWorkSearch(query: string) {
  return useQuery(workSearchQueryOptions(query));
}

export function useAgents() {
  return useQuery(agentsQueryOptions());
}

export function useModelRuntime() {
  return useQuery(modelRuntimeQueryOptions());
}

export function useSessions(slug: string) {
  return useQuery({ ...sessionsQueryOptions(slug), select: (items) => items.map((item) => item.session) });
}

export function useSessionInventory(slug: string) {
  return useQuery(sessionsQueryOptions(slug));
}

export function useSession(slug: string, sessionId: string) {
  return useQuery(sessionQueryOptions(slug, sessionId));
}

export function sessionTreeQueryOptions(slug: string, rootSessionId: string) {
  return queryOptions({
    queryKey: queryKeys.tree(slug, rootSessionId),
    queryFn: async () => {
      const response = await apiFetch<SessionTreeResponse>(
        `/api/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(rootSessionId)}/tree`,
      );
      return response;
    },
    enabled: slug.length > 0 && rootSessionId.length > 0,
  });
}

export function useFocusedSession(slug: string, focusSessionId: string | null) {
  return useQuery(focusedSessionQueryOptions(slug, focusSessionId));
}

export function useSessionTree(slug: string, rootSessionId: string) {
  return useQuery(sessionTreeQueryOptions(slug, rootSessionId));
}

export function useDiff(
  slug: string,
  sessionId?: string,
  options?: { enabled?: boolean; refetchInterval?: number | false; refetchOnMount?: boolean | "always" },
) {
  return useQuery({
    ...diffQueryOptions(slug, sessionId),
    ...options,
  });
}

export function useDirectoryList(path: string, limit?: number) {
  return useQuery({
    queryKey: queryKeys.directories.list(path, limit),
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("path", path);
      if (limit !== undefined) params.set("limit", String(limit));
      return apiFetch<DirectoryListResponse>(`/api/directories/list?${params.toString()}`);
    },
    enabled: path.trim().length > 0,
  });
}

export function useDirectorySearch(query: string, limit?: number) {
  return useQuery({
    queryKey: queryKeys.directories.search(query, limit),
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("query", query);
      if (limit !== undefined) params.set("limit", String(limit));
      return apiFetch<DirectorySearchResponse>(`/api/directories/search?${params.toString()}`);
    },
    enabled: query.trim().length > 0,
  });
}

// ─── Automation query options ───

export function automationsQueryOptions(slug: string) {
  return queryOptions({
    queryKey: queryKeys.projectAutomations(slug),
    queryFn: async () => {
      const response = await apiFetch<{ automations: ProjectAutomationInventoryItem[] }>(
        `/api/projects/${encodeURIComponent(slug)}/automations`,
      );
      return response.automations;
    },
    enabled: slug.length > 0,
  });
}

export function automationQueryOptions(slug: string, automationId: string) {
  return queryOptions({
    queryKey: queryKeys.automation(slug, automationId),
    queryFn: async () => {
      const response = await apiFetch<{ automation: Automation }>(
        `/api/projects/${encodeURIComponent(slug)}/automations/${encodeURIComponent(automationId)}`,
      );
      return response.automation;
    },
    enabled: slug.length > 0 && automationId.length > 0,
  });
}

export function automationInvocationsQueryOptions(slug: string, automationId: string) {
  return queryOptions({
    queryKey: queryKeys.automationInvocations(slug, automationId),
    queryFn: async () => {
      const response = await apiFetch<{ invocations: AutomationInvocation[] }>(
        `/api/projects/${encodeURIComponent(slug)}/automations/${encodeURIComponent(automationId)}/invocations`,
      );
      return response.invocations;
    },
    enabled: slug.length > 0 && automationId.length > 0,
  });
}

// ─── Automation hooks ───

export function useAutomations(slug: string) {
  return useQuery({ ...automationsQueryOptions(slug), select: (items) => items.map((item) => item.automation) });
}

export function useAutomationInventory(slug: string) {
  return useQuery(automationsQueryOptions(slug));
}

export function useAutomation(slug: string, automationId: string) {
  return useQuery(automationQueryOptions(slug, automationId));
}

export function useAutomationInvocations(slug: string, automationId: string) {
  return useQuery(automationInvocationsQueryOptions(slug, automationId));
}

export function projectTodosQueryOptions(slug: string) {
  return queryOptions({
    queryKey: queryKeys.projectTodos(slug),
    queryFn: async () => {
      const response = await apiFetch<{ todos: ProjectTodo[] }>(
        `/api/projects/${encodeURIComponent(slug)}/todos`,
      );
      return response.todos;
    },
    enabled: slug.length > 0,
  });
}

export function useProjectTodos(slug: string) {
  return useQuery(projectTodosQueryOptions(slug));
}

export function projectTodoPlanQueryOptions(slug: string, todoId: string) {
  return queryOptions({
    queryKey: ["projects", slug, "todos", todoId, "plan"] as const,
    queryFn: () => apiFetch<{ plan: ProjectTodoPlan | null }>(
      `/api/projects/${encodeURIComponent(slug)}/todos/${encodeURIComponent(todoId)}/plan`,
    ).then((response) => response.plan),
    enabled: slug.length > 0 && todoId.length > 0,
  });
}

export function useProjectTodoPlan(slug: string, todoId: string) {
  return useQuery(projectTodoPlanQueryOptions(slug, todoId));
}

export function projectTodoAttachmentsQueryOptions(slug: string, todoId: string) {
  return queryOptions({
    queryKey: queryKeys.projectTodoAttachments(slug, todoId),
    queryFn: () => apiFetch<ProjectTodoAttachmentListResponse>(
      `/api/projects/${encodeURIComponent(slug)}/todos/${encodeURIComponent(todoId)}/attachments`,
    ),
    enabled: slug.length > 0 && todoId.length > 0,
  });
}

export function useProjectTodoAttachments(slug: string, todoId: string) {
  return useQuery(projectTodoAttachmentsQueryOptions(slug, todoId));
}
