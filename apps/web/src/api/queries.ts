import { queryOptions, useQuery } from "@tanstack/react-query";
import { apiFetch } from "./client";
import type {
  DiffFile,
  DirectoryListResponse,
  DirectorySearchResponse,
  Project,
  Session,
  SessionSummary,
  SessionTreeResponse,
  WorkflowState,
} from "./types";

export const queryKeys = {
  projects: ["projects"] as const,
  sessions: (slug: string) => ["projects", slug, "sessions"] as const,
  session: (slug: string, sessionId: string) => ["projects", slug, "sessions", sessionId] as const,
  workflow: (slug: string, sessionId: string) => ["projects", slug, "sessions", sessionId, "workflow"] as const,
  tree: (slug: string, rootSessionId: string) => ["projects", slug, "sessions", rootSessionId, "tree"] as const,
  diff: (slug: string) => ["projects", slug, "diff"] as const,
  directories: {
    list: (path: string, limit?: number) => ["directories", "list", path, limit] as const,
    search: (query: string, limit?: number) => ["directories", "search", query, limit] as const,
  },
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

export function workflowQueryOptions(slug: string, sessionId: string) {
  return queryOptions({
    queryKey: queryKeys.workflow(slug, sessionId),
    queryFn: async () => {
      const response = await apiFetch<{ workflow?: WorkflowState | null } | WorkflowState | null>(
        `/api/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sessionId)}/workflow`,
      );

      if (!response) return null;
      return "workflow" in response ? response.workflow ?? null : response;
    },
    enabled: slug.length > 0 && sessionId.length > 0,
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

export function useSessionTree(slug: string, rootSessionId: string) {
  return useQuery(sessionTreeQueryOptions(slug, rootSessionId));
}

export function useWorkflow(slug: string, sessionId: string) {
  return useQuery(workflowQueryOptions(slug, sessionId));
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
    createdAt: session.createdAt,
    updatedAt: session.lastUpdatedAt,
    lastUpdatedAt: session.lastUpdatedAt,
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
