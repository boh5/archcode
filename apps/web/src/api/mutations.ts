import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { queryKeys } from "./queries";
import {
  removeProjectControlPlane,
} from "../store/control-plane-readiness";
import type {
  ApiCommandResult,
  CreateAutomationPayload,
  GoalState,
  HitlIdentity,
  HitlResponse,
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

export function useCreateGoal() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      slug,
      objective,
      acceptanceCriteria,
      useWorktree,
    }: {
      slug: string;
      objective: string;
      acceptanceCriteria: string;
      useWorktree: boolean;
    }) => apiFetch<GoalState>(`/api/projects/${encodeURIComponent(slug)}/goals`, {
      method: "POST",
      body: { objective, acceptanceCriteria, useWorktree },
    }),
    onSuccess: async (_data, variables) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.projectGoals(variables.slug) });
    },
  });
}

export function useRunGoal() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ slug, goalId }: { slug: string; goalId: string }) =>
      apiFetch<GoalState>(`/api/projects/${encodeURIComponent(slug)}/goals/${encodeURIComponent(goalId)}/run`, {
        method: "POST",
        body: {},
      }),
    onSuccess: async (_data, variables) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.goal(variables.slug, variables.goalId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.projectGoals(variables.slug) });
    },
  });
}

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

export function useRespondHitl() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      identity,
      body,
    }: {
      identity: HitlIdentity;
      body: Exclude<HitlResponse, { type: "cancel" }>;
    }) => apiFetch<{ ok: boolean; hitlId: string }>(hitlMutationUrl(identity, "respond"), {
      method: "POST",
      body,
    }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.hitl });
      await queryClient.invalidateQueries({ queryKey: ["projects"], exact: false });
    },
  });
}

export function useCancelHitl() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ identity, reason }: { identity: HitlIdentity; reason?: string }) =>
      apiFetch<{ ok: boolean; hitlId: string }>(hitlMutationUrl(identity, "cancel"), {
        method: "POST",
        body: reason ? { reason } : {},
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.hitl });
      await queryClient.invalidateQueries({ queryKey: ["projects"], exact: false });
    },
  });
}

function hitlMutationUrl(identity: HitlIdentity, action: "respond" | "cancel"): string {
  const { owner, hitlId } = identity;
  return `/api/projects/${encodeURIComponent(owner.projectSlug)}/hitl/${owner.ownerType}/${encodeURIComponent(owner.ownerId)}/${encodeURIComponent(hitlId)}/${action}`;
}

/** Invalidate all HITL query keys for a project slug (project + all owner scopes). */
export function invalidateHitlForProject(
  qc: { invalidateQueries: (opts: { queryKey: readonly unknown[]; exact?: boolean }) => Promise<void> },
  slug: string,
): Promise<void[]> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: queryKeys.hitl }),
    qc.invalidateQueries({ queryKey: queryKeys.projectHitl(slug) }),
    qc.invalidateQueries({ queryKey: ["projects", slug, "hitl"], exact: false }),
  ]);
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

export function useCreateAutomation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (variables: { slug: string } & CreateAutomationPayload) => {
      const { slug, ...payload } = variables;
      return apiFetch<{ automation: { id: string } }>(`/api/projects/${encodeURIComponent(slug)}/automations`, {
        method: "POST",
        body: payload,
      });
    },
    onSuccess: async (_data, variables) => {
      await invalidateAutomation(queryClient, variables.slug);
    },
  });
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
