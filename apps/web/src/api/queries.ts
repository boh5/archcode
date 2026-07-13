import { queryOptions, useQuery, useQueries } from "@tanstack/react-query";
import { apiFetch } from "./client";
import type { AgentDescriptor } from "@archcode/protocol";
import type {
  DashboardGoal,
  DashboardAutomation,
  DiffFile,
  DirectoryListResponse,
  DirectorySearchResponse,
  GoalState,
  HitlListResponse,
  HitlProjection,
  HitlScope,
  HitlStatusFilter,
  Automation,
  AutomationInvocation,
  Project,
  Session,
  SessionSummary,
  SessionTreeResponse,
} from "./types";

export const queryKeys = {
  agents: ["agents"] as const,
  projects: ["projects"] as const,
  goals: ["goals"] as const,
  activeGoals: ["goals", "active"] as const,
  projectGoals: (slug: string) => ["projects", slug, "goals"] as const,
  goal: (slug: string, goalId: string) => ["projects", slug, "goals", goalId] as const,
  hitl: ["hitl", "pending"] as const,
  projectHitl: (slug: string) => ["projects", slug, "hitl"] as const,
  scopedHitl: (
    slug: string,
    scope: HitlScope,
    ownerId: string | undefined,
    includeChildren: boolean,
    status: HitlStatusFilter,
  ) => ["projects", slug, "hitl", scope, ownerId ?? "", includeChildren, status] as const,
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
  activeAutomations: ["automations", "active"] as const,
};

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

export function sessionsQueryOptions(slug: string) {
  return queryOptions({
    queryKey: queryKeys.sessions(slug),
    queryFn: async () => {
      const response = await apiFetch<{ sessions: SessionSummary[] }>(
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
      return await apiFetch<Session>(
        `/api/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sessionId)}`,
      );
    },
    enabled: slug.length > 0 && sessionId.length > 0,
  });
}

export function focusedSessionQueryOptions(slug: string, focusSessionId: string | null) {
  return queryOptions({
    queryKey: queryKeys.session(slug, focusSessionId ?? ""),
    queryFn: async () => {
      return await apiFetch<Session>(
        `/api/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(focusSessionId!)}`,
      );
    },
    enabled: slug.length > 0 && focusSessionId !== null && focusSessionId.length > 0,
  });
}

export function goalsQueryOptions(slug: string) {
  return queryOptions({
    queryKey: queryKeys.projectGoals(slug),
    queryFn: async () => {
      const response = await apiFetch<{ goals: GoalState[] }>(
        `/api/projects/${encodeURIComponent(slug)}/goals`,
      );
      return response.goals;
    },
    enabled: slug.length > 0,
  });
}

export function goalQueryOptions(slug: string, goalId: string) {
  return queryOptions({
    queryKey: queryKeys.goal(slug, goalId),
    queryFn: async () => {
      const response = await apiFetch<GoalState>(
        `/api/projects/${encodeURIComponent(slug)}/goals/${encodeURIComponent(goalId)}`,
      );
      return response;
    },
    enabled: slug.length > 0 && goalId.length > 0,
  });
}

export function projectHitlQueryOptions(slug: string) {
  return queryOptions({
    queryKey: queryKeys.projectHitl(slug),
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("scope", "project");
      params.set("status", "pending");
      const response = await apiFetch<HitlListResponse>(
        `/api/projects/${encodeURIComponent(slug)}/hitl?${params.toString()}`,
      );
      return response.hitl;
    },
    enabled: slug.length > 0,
  });
}

export interface UseHitlOptions {
  slug: string;
  scope: HitlScope;
  ownerId?: string;
  includeChildren?: boolean;
  status?: HitlStatusFilter;
}

export function scopedHitlQueryOptions({
  slug,
  scope,
  ownerId,
  includeChildren = false,
  status = "pending",
}: UseHitlOptions) {
  return queryOptions({
    queryKey: queryKeys.scopedHitl(slug, scope, ownerId, includeChildren, status),
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("scope", scope);
      if (ownerId) params.set("ownerId", ownerId);
      if (includeChildren) params.set("includeChildren", "true");
      params.set("status", status);
      const response = await apiFetch<HitlListResponse>(
        `/api/projects/${encodeURIComponent(slug)}/hitl?${params.toString()}`,
      );
      return response.hitl;
    },
    enabled: slug.length > 0 && (scope === "project" || (ownerId?.length ?? 0) > 0),
  });
}

export function activeGoalsQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.activeGoals,
    queryFn: async () => {
      const response = await apiFetch<{ goals: DashboardGoal[] }>("/api/goals?status=active");
      return response.goals;
    },
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

export function useAgents() {
  return useQuery(agentsQueryOptions());
}

export function useSessions(slug: string) {
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

export function useGoals(slug: string) {
  return useQuery(goalsQueryOptions(slug));
}

export function useGoal(slug: string, goalId: string) {
  return useQuery(goalQueryOptions(slug, goalId));
}

export function useScopedHitl(options: UseHitlOptions) {
  return useQuery(scopedHitlQueryOptions(options));
}

export function useActiveGoals() {
  return useQuery(activeGoalsQueryOptions());
}

export function useProjectHitl(slug: string) {
  return useQuery(projectHitlQueryOptions(slug));
}

export function useDashboardHitl() {
  const projectsQuery = useProjects();
  const slugs = (projectsQuery.data ?? []).map((p) => p.slug);
  const results = useQueries({
    queries: slugs.map((slug) => scopedHitlQueryOptions({ slug, scope: "project", status: "pending" })),
    combine: (queryResults) => {
      const all: HitlProjection[] = [];
      let loading = false;
      for (const r of queryResults) {
        if (r.isLoading) loading = true;
        if (r.data) all.push(...r.data);
      }
      return { data: all, isLoading: loading };
    },
  });
  return {
    data: results.data,
    isLoading: projectsQuery.isLoading || results.isLoading,
  };
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
      const response = await apiFetch<{ automations: Automation[] }>(
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

export function activeAutomationsQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.activeAutomations,
    queryFn: async () => {
      const response = await apiFetch<{ automations: DashboardAutomation[] }>("/api/automations?status=active");
      return response.automations;
    },
  });
}

// ─── Automation hooks ───

export function useAutomations(slug: string) {
  return useQuery(automationsQueryOptions(slug));
}

export function useAutomation(slug: string, automationId: string) {
  return useQuery(automationQueryOptions(slug, automationId));
}

export function useAutomationInvocations(slug: string, automationId: string) {
  return useQuery(automationInvocationsQueryOptions(slug, automationId));
}

export function useActiveAutomations() {
  return useQuery(activeAutomationsQueryOptions());
}
