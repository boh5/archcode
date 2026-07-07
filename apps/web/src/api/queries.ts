import { queryOptions, useQuery, useQueries } from "@tanstack/react-query";
import { apiFetch } from "./client";
import type {
  LoopBudgetSnapshot,
  LoopCollisionSnapshot,
} from "@archcode/protocol";
import type {
  DashboardGoal,
  DashboardLoop,
  DiffFile,
  DirectoryListResponse,
  DirectorySearchResponse,
  GoalArtifactReadResponse,
  GoalArtifactsListResponse,
  GoalState,
  HitlListResponse,
  HitlProjection,
  HitlScope,
  HitlStatusFilter,
  LoopIntegrationStatusSnapshot,
  LoopKillState,
  LoopRunReport,
  LoopState,
  LoopStateResponse,
  Project,
  Session,
  SessionSummary,
  SessionTreeResponse,
} from "./types";

export const queryKeys = {
  projects: ["projects"] as const,
  goals: ["goals"] as const,
  activeGoals: ["goals", "active"] as const,
  projectGoals: (slug: string) => ["projects", slug, "goals"] as const,
  goal: (slug: string, goalId: string) => ["projects", slug, "goals", goalId] as const,
  goalArtifacts: (slug: string, goalId: string) => ["projects", slug, "goals", goalId, "artifacts"] as const,
  goalArtifact: (slug: string, goalId: string, artifactName: string) =>
    ["projects", slug, "goals", goalId, "artifacts", artifactName] as const,
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
  focusedSession: (slug: string, sessionId: string) => ["projects", slug, "sessions", sessionId, "focused"] as const,
  tree: (slug: string, rootSessionId: string) => ["projects", slug, "sessions", rootSessionId, "tree"] as const,
  diff: (slug: string) => ["projects", slug, "diff"] as const,
  directories: {
    list: (path: string, limit?: number) => ["directories", "list", path, limit] as const,
    search: (query: string, limit?: number) => ["directories", "search", query, limit] as const,
  },
  // ─── Loop query keys ───
  projectLoops: (slug: string) => ["projects", slug, "loops"] as const,
  loop: (slug: string, loopId: string) => ["projects", slug, "loops", loopId] as const,
  loopRuns: (slug: string, loopId: string) => ["projects", slug, "loops", loopId, "runs"] as const,
  loopState: (slug: string, loopId: string) => ["projects", slug, "loops", loopId, "state"] as const,
  loopBudget: (slug: string, loopId: string) => ["projects", slug, "loops", loopId, "budget"] as const,
  loopCollisions: (slug: string, loopId: string) => ["projects", slug, "loops", loopId, "collisions"] as const,
  loopIntegrations: (slug: string, loopId: string) => ["projects", slug, "loops", loopId, "integrations"] as const,
  loopKillState: (slug: string) => ["projects", slug, "loops", "kill-state"] as const,
  activeLoops: ["loops", "active"] as const,
};

export function projectsQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.projects,
    queryFn: async () => {
      const response = await apiFetch<{ projects: Project[] }>("/api/projects");
      return response.projects.map(normalizeProject);
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
      return response.sessions.map(normalizeSessionSummary);
    },
    enabled: slug.length > 0,
  });
}

export function sessionQueryOptions(slug: string, sessionId: string) {
  return queryOptions({
    queryKey: queryKeys.session(slug, sessionId),
    queryFn: async () => {
      const response = await apiFetch<SessionResponse>(
        `/api/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sessionId)}`,
      );
      return normalizeSession(response);
    },
    enabled: slug.length > 0 && sessionId.length > 0,
  });
}

export function focusedSessionQueryOptions(slug: string, focusSessionId: string | null) {
  return queryOptions({
    queryKey: queryKeys.focusedSession(slug, focusSessionId ?? ""),
    queryFn: async () => {
      const response = await apiFetch<SessionResponse>(
        `/api/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(focusSessionId!)}`,
      );
      return normalizeSession(response);
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

export function goalArtifactsQueryOptions(slug: string, goalId: string) {
  return queryOptions({
    queryKey: queryKeys.goalArtifacts(slug, goalId),
    queryFn: async () => {
      const response = await apiFetch<GoalArtifactsListResponse>(
        `/api/projects/${encodeURIComponent(slug)}/goals/${encodeURIComponent(goalId)}/artifacts`,
      );
      return response.artifacts;
    },
    enabled: slug.length > 0 && goalId.length > 0,
  });
}

export function goalArtifactQueryOptions(slug: string, goalId: string, artifactName: string) {
  return queryOptions({
    queryKey: queryKeys.goalArtifact(slug, goalId, artifactName),
    queryFn: async () => {
      const response = await apiFetch<GoalArtifactReadResponse>(
        `/api/projects/${encodeURIComponent(slug)}/goals/${encodeURIComponent(goalId)}/artifacts/${encodeURIComponent(artifactName)}`,
      );
      return response;
    },
    enabled: slug.length > 0 && goalId.length > 0 && artifactName.length > 0,
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

export function diffQueryOptions(slug: string) {
  return queryOptions({
    queryKey: queryKeys.diff(slug),
    queryFn: async () => {
      const response = await apiFetch<{ files: DiffFile[] } | DiffFile[]>(
        `/api/projects/${encodeURIComponent(slug)}/diff`,
      );
      return Array.isArray(response) ? response : response.files;
    },
    enabled: slug.length > 0,
  });
}

export function useProjects() {
  return useQuery(projectsQueryOptions());
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

export function useGoalArtifacts(slug: string, goalId: string) {
  return useQuery(goalArtifactsQueryOptions(slug, goalId));
}

export function useGoalArtifact(slug: string, goalId: string, artifactName: string) {
  return useQuery(goalArtifactQueryOptions(slug, goalId, artifactName));
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

export function useDiff(slug: string) {
  return useQuery(diffQueryOptions(slug));
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

// ─── Loop query options ───

export function loopsQueryOptions(slug: string) {
  return queryOptions({
    queryKey: queryKeys.projectLoops(slug),
    queryFn: async () => {
      const response = await apiFetch<{ loops: LoopState[] }>(
        `/api/projects/${encodeURIComponent(slug)}/loops`,
      );
      return response.loops;
    },
    enabled: slug.length > 0,
  });
}

export function loopQueryOptions(slug: string, loopId: string) {
  return queryOptions({
    queryKey: queryKeys.loop(slug, loopId),
    queryFn: async () => {
      const response = await apiFetch<{ loop: LoopState }>(
        `/api/projects/${encodeURIComponent(slug)}/loops/${encodeURIComponent(loopId)}`,
      );
      return response.loop;
    },
    enabled: slug.length > 0 && loopId.length > 0,
  });
}

export function loopRunsQueryOptions(slug: string, loopId: string) {
  return queryOptions({
    queryKey: queryKeys.loopRuns(slug, loopId),
    queryFn: async () => {
      const response = await apiFetch<{ runs: LoopRunReport[] }>(
        `/api/projects/${encodeURIComponent(slug)}/loops/${encodeURIComponent(loopId)}/runs`,
      );
      return response.runs;
    },
    enabled: slug.length > 0 && loopId.length > 0,
  });
}

export function loopStateQueryOptions(slug: string, loopId: string) {
  return queryOptions({
    queryKey: queryKeys.loopState(slug, loopId),
    queryFn: async () => {
      const response = await apiFetch<LoopStateResponse>(
        `/api/projects/${encodeURIComponent(slug)}/loops/${encodeURIComponent(loopId)}/state`,
      );
      return response;
    },
    enabled: slug.length > 0 && loopId.length > 0,
  });
}

export function activeLoopsQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.activeLoops,
    queryFn: async () => {
      const response = await apiFetch<{ loops: DashboardLoop[] }>("/api/loops?status=active");
      return response.loops;
    },
  });
}

export function loopBudgetQueryOptions(slug: string, loopId: string) {
  return queryOptions({
    queryKey: queryKeys.loopBudget(slug, loopId),
    queryFn: async () => {
      const response = await apiFetch<{ loopId: string; budget: LoopBudgetSnapshot | null }>(
        `/api/projects/${encodeURIComponent(slug)}/loops/${encodeURIComponent(loopId)}/budget`,
      );
      return response.budget;
    },
    enabled: slug.length > 0 && loopId.length > 0,
  });
}

export function loopCollisionsQueryOptions(slug: string, loopId: string) {
  return queryOptions({
    queryKey: queryKeys.loopCollisions(slug, loopId),
    queryFn: async () => {
      const response = await apiFetch<{ loopId: string; collisions: LoopCollisionSnapshot }>(
        `/api/projects/${encodeURIComponent(slug)}/loops/${encodeURIComponent(loopId)}/collisions`,
      );
      return response.collisions;
    },
    enabled: slug.length > 0 && loopId.length > 0,
  });
}

export function loopIntegrationsQueryOptions(slug: string, loopId: string) {
  return queryOptions({
    queryKey: queryKeys.loopIntegrations(slug, loopId),
    queryFn: async () => {
      const response = await apiFetch<{ loopId: string; integrations: LoopIntegrationStatusSnapshot }>(
        `/api/projects/${encodeURIComponent(slug)}/loops/${encodeURIComponent(loopId)}/integrations`,
      );
      return response.integrations;
    },
    enabled: slug.length > 0 && loopId.length > 0,
  });
}

export function loopKillStateQueryOptions(slug: string) {
  return queryOptions({
    queryKey: queryKeys.loopKillState(slug),
    queryFn: async () => {
      const response = await apiFetch<{ killState: LoopKillState }>(
        `/api/projects/${encodeURIComponent(slug)}/loops/kill-state`,
      );
      return response.killState;
    },
    enabled: slug.length > 0,
  });
}

// ─── Loop hooks ───

export function useLoops(slug: string) {
  return useQuery(loopsQueryOptions(slug));
}

export function useLoop(slug: string, loopId: string) {
  return useQuery(loopQueryOptions(slug, loopId));
}

export function useLoopRuns(slug: string, loopId: string) {
  return useQuery(loopRunsQueryOptions(slug, loopId));
}

export function useLoopState(slug: string, loopId: string) {
  return useQuery(loopStateQueryOptions(slug, loopId));
}

export function useActiveLoops() {
  return useQuery(activeLoopsQueryOptions());
}

export function useLoopBudget(slug: string, loopId: string) {
  return useQuery(loopBudgetQueryOptions(slug, loopId));
}

export function useLoopCollisions(slug: string, loopId: string) {
  return useQuery(loopCollisionsQueryOptions(slug, loopId));
}

export function useLoopIntegrations(slug: string, loopId: string) {
  return useQuery(loopIntegrationsQueryOptions(slug, loopId));
}

export function useLoopKillState(slug: string) {
  return useQuery(loopKillStateQueryOptions(slug));
}

interface SessionResponse extends Omit<Session, "id"> {
  id?: string;
  sessionId?: string;
}

function normalizeProject(project: Project & { lastOpenedAt?: string }): Project {
  return {
    slug: project.slug,
    name: project.name,
    workspaceRoot: project.workspaceRoot,
    lastOpened: project.lastOpened ?? project.lastOpenedAt,
  };
}

function normalizeSessionSummary(session: SessionSummary): Session {
  return {
    id: session.sessionId,
    sessionId: session.sessionId,
    rootSessionId: session.rootSessionId,
    parentSessionId: session.parentSessionId,
    title: session.title,
    ...(session.goalId === undefined ? {} : { goalId: session.goalId }),
    ...(session.loopId === undefined ? {} : { loopId: session.loopId }),
    createdAt: session.createdAt,
    updatedAt: session.lastUpdatedAt,
    lastUpdatedAt: session.lastUpdatedAt,
    ...(session.modelInfo === undefined ? {} : { modelInfo: session.modelInfo }),
  };
}

function normalizeSession(session: SessionResponse): Session {
  const id = session.id ?? session.sessionId ?? "";

  return {
    ...session,
    id,
    sessionId: session.sessionId ?? id,
    updatedAt: session.updatedAt ?? session.lastUpdatedAt,
  };
}
