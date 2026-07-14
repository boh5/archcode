import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { queryKeys } from "./queries";
import {
  removeProjectControlPlane,
} from "../store/control-plane-readiness";
import { hitlStore } from "../store/hitl-store";
import type {
  ApiCommandResult,
  GoalState,
  HitlResponse,
  HitlStatus,
  HitlView,
  Project,
  Session,
  UpdateAutomationPayload,
} from "./types";

export function useUpdateProjectName() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ slug, name }: { slug: string; name: string }) =>
      apiFetch<Project>(`/api/projects/${encodeURIComponent(slug)}`, {
        method: "PATCH",
        body: { name },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.projects });
    },
  });
}

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
    onSuccess: async (_data, slug) => {
      removeProjectControlPlane(slug);
      await queryClient.invalidateQueries({ queryKey: queryKeys.projects });
    },
  });
}

export function createSession({ slug }: { slug: string }): Promise<Session> {
  return apiFetch<Session>(`/api/projects/${encodeURIComponent(slug)}/sessions`, {
    method: "POST",
  });
}

export function useCreateSession() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: createSession,
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
        body: { text: content },
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
    }) => apiFetch<ApiCommandResult>(
      `/api/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sessionId)}/commands`,
      {
        method: "POST",
        body: args === undefined ? { name } : { name, args },
      },
    ),
  });
}

export interface StopSessionFamilyInput {
  slug: string;
  rootSessionId: string;
}

export function stopSessionFamily({ slug, rootSessionId }: StopSessionFamilyInput): Promise<{ ok: true }> {
  return apiFetch<{ ok: true }>(
    `/api/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(rootSessionId)}/stop`,
    { method: "POST" },
  );
}

export function useStopSessionFamily() {
  return useMutation({ mutationFn: stopSessionFamily });
}

// ─── Goal Mutations ───

export function useRetryGoal() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ slug, goalId }: { slug: string; goalId: string }) =>
      apiFetch<GoalState>(`/api/projects/${encodeURIComponent(slug)}/goals/${encodeURIComponent(goalId)}/retry`, {
        method: "POST",
      }),
    onSuccess: async (_data, variables) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.goal(variables.slug, variables.goalId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.projectGoals(variables.slug) });
    },
  });
}

export function useCancelGoal() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ slug, goalId }: { slug: string; goalId: string }) =>
      apiFetch<GoalState>(`/api/projects/${encodeURIComponent(slug)}/goals/${encodeURIComponent(goalId)}/cancel`, {
        method: "POST",
      }),
    onSuccess: async (_data, variables) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.goal(variables.slug, variables.goalId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.projectGoals(variables.slug) });
    },
  });
}

// ─── HITL Mutations ───

export interface HitlMutationResponse {
  hitlId: string;
  status: HitlStatus;
  view: HitlView;
}

export function applyHitlMutationResult(projectSlug: string, result: HitlMutationResponse): void {
  hitlStore.getState().applyScopedView(projectSlug, result.view);
}

export function useRespondHitl() {
  return useMutation({
    mutationFn: async ({
      projectSlug,
      hitlId,
      body,
    }: {
      projectSlug: string;
      hitlId: string;
      body: Exclude<HitlResponse, { type: "cancel" }>;
    }) => apiFetch<HitlMutationResponse>(hitlMutationUrl(projectSlug, hitlId, "respond"), {
      method: "POST",
      body,
    }),
    onSuccess: (result, variables) => applyHitlMutationResult(variables.projectSlug, result),
  });
}

export function useCancelHitl() {
  return useMutation({
    mutationFn: async ({ projectSlug, hitlId, reason }: { projectSlug: string; hitlId: string; reason?: string }) =>
      apiFetch<HitlMutationResponse>(hitlMutationUrl(projectSlug, hitlId, "cancel"), {
        method: "POST",
        body: reason ? { reason } : {},
      }),
    onSuccess: (result, variables) => applyHitlMutationResult(variables.projectSlug, result),
  });
}

function hitlMutationUrl(projectSlug: string, hitlId: string, action: "respond" | "cancel"): string {
  return `/api/projects/${encodeURIComponent(projectSlug)}/hitl/${encodeURIComponent(hitlId)}/${action}`;
}


// ─── Automation mutations ───

export function invalidateAutomation(
  qc: { invalidateQueries: (opts: { queryKey: readonly unknown[] }) => Promise<void> },
  slug: string,
  automationId?: string,
): Promise<void[]> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: queryKeys.projectAutomations(slug) }),
    qc.invalidateQueries({ queryKey: queryKeys.activeAutomations }),
    ...(automationId === undefined ? [] : [
      qc.invalidateQueries({ queryKey: queryKeys.automation(slug, automationId) }),
      qc.invalidateQueries({ queryKey: queryKeys.automationInvocations(slug, automationId) }),
    ]),
  ]);
}

export function useUpdateAutomation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      slug,
      automationId,
      ...payload
    }: {
      slug: string;
      automationId: string;
    } & UpdateAutomationPayload) => {
      return apiFetch<{ automation: unknown }>(
        `/api/projects/${encodeURIComponent(slug)}/automations/${encodeURIComponent(automationId)}`,
        { method: "PATCH", body: payload },
      );
    },
    onSuccess: async (_data, variables) => {
      await invalidateAutomation(queryClient, variables.slug, variables.automationId);
    },
  });
}

export function useRunAutomationNow() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ slug, automationId }: { slug: string; automationId: string }) =>
      apiFetch<{ invocation: unknown }>(
        `/api/projects/${encodeURIComponent(slug)}/automations/${encodeURIComponent(automationId)}/run-now`,
        { method: "POST" },
      ),
    onSuccess: async (_data, variables) => {
      await invalidateAutomation(queryClient, variables.slug, variables.automationId);
    },
  });
}

function useAutomationControl(action: "pause" | "resume") {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ slug, automationId }: { slug: string; automationId: string }) =>
      apiFetch<{ automation: unknown }>(
        `/api/projects/${encodeURIComponent(slug)}/automations/${encodeURIComponent(automationId)}/${action}`,
        { method: "POST" },
      ),
    onSuccess: async (_data, variables) => {
      await invalidateAutomation(queryClient, variables.slug, variables.automationId);
    },
  });
}

export function usePauseAutomation() { return useAutomationControl("pause"); }
export function useResumeAutomation() { return useAutomationControl("resume"); }

export function useDeleteAutomation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ slug, automationId }: { slug: string; automationId: string }) =>
      apiFetch<void>(`/api/projects/${encodeURIComponent(slug)}/automations/${encodeURIComponent(automationId)}`, { method: "DELETE" }),
    onSuccess: async (_data, variables) => { await invalidateAutomation(queryClient, variables.slug); },
  });
}
