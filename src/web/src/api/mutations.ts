import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { queryKeys } from "./queries";
import type {
  CommandResult,
  PermissionDecision,
  Project,
  QuestionAnswerBody,
  Session,
} from "./types";

export function useAddProject() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ path, name }: { path: string; name?: string }) => apiFetch<Project>("/api/projects", {
      method: "POST",
      body: { workspaceRoot: path, ...(name ? { name } : {}) },
    }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.projects });
    },
  });
}

export function useDeleteProject() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (slug: string) => apiFetch<void>(`/api/projects/${encodeURIComponent(slug)}`, {
      method: "DELETE",
    }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.projects });
    },
  });
}

export function useCreateSession() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ slug }: { slug: string }) => apiFetch<Session>(
      `/api/projects/${encodeURIComponent(slug)}/sessions`,
      {
        method: "POST",
        body: {},
      },
    ),
    onSuccess: async (_session, variables) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.sessions(variables.slug) });
    },
  });
}

export function usePostMessage() {
  return useMutation({
    mutationFn: async ({
      slug,
      sessionId,
      content,
    }: {
      slug: string;
      sessionId: string;
      content: string;
    }) => apiFetch<void>(
      `/api/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sessionId)}/messages`,
      {
        method: "POST",
        body: { content },
      },
    ),
  });
}

export function usePostPermissionResponse() {
  return useMutation({
    mutationFn: async ({ id, decision }: { id: string; decision: PermissionDecision }) => apiFetch<void>(
      `/api/permissions/${encodeURIComponent(id)}`,
      {
        method: "POST",
        body: { response: decision },
      },
    ),
  });
}

export function usePostQuestionAnswer() {
  return useMutation({
    mutationFn: async ({ id, body }: { id: string; body: QuestionAnswerBody }) => apiFetch<void>(
      `/api/questions/${encodeURIComponent(id)}`,
      {
        method: "POST",
        body,
      },
    ),
  });
}

export function usePostCommand() {
  return useMutation({
    mutationFn: async ({
      slug,
      sessionId,
      name,
      args,
    }: {
      slug: string;
      sessionId: string;
      name: string;
      args?: string;
    }) => apiFetch<CommandResult>(
      `/api/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sessionId)}/commands`,
      {
        method: "POST",
        body: args === undefined ? { name } : { name, args },
      },
    ),
  });
}
