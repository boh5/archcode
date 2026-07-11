import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { queryKeys } from "./queries";
import {
  removeProjectControlPlane,
} from "../store/control-plane-readiness";
import type {
  CancelCurrentRunResponse,
  ApiCommandResult,
  CreateLoopPayload,
  GoalState,
  HitlIdentity,
  HitlResponse,
  LoopKillState,
  LoopRunReport,
  LoopState,
  Project,
  Session,
  UpdateLoopPayload,
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
        body: {},
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

// ─── Loop Mutations ───

/** Pure invalidation helper for createLoop onSuccess. */
export function invalidateLoopAfterCreate(
  qc: { invalidateQueries: (opts: { queryKey: readonly unknown[] }) => Promise<void> },
  slug: string,
): Promise<void[]> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: queryKeys.projectLoops(slug) }),
    qc.invalidateQueries({ queryKey: queryKeys.activeLoops }),
  ]);
}

/** Pure invalidation helper for updateLoop onSuccess. */
export function invalidateLoopAfterUpdate(
  qc: { invalidateQueries: (opts: { queryKey: readonly unknown[] }) => Promise<void> },
  slug: string,
  loopId: string,
): Promise<void[]> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: queryKeys.projectLoops(slug) }),
    qc.invalidateQueries({ queryKey: queryKeys.loop(slug, loopId) }),
    qc.invalidateQueries({ queryKey: queryKeys.loopState(slug, loopId) }),
    qc.invalidateQueries({ queryKey: queryKeys.activeLoops }),
  ]);
}

/** Pure invalidation helper for triggerLoop onSuccess. */
export function invalidateLoopAfterTrigger(
  qc: { invalidateQueries: (opts: { queryKey: readonly unknown[]; exact?: boolean }) => Promise<void> },
  slug: string,
  loopId: string,
): Promise<void[]> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: queryKeys.loop(slug, loopId) }),
    qc.invalidateQueries({ queryKey: queryKeys.loopRuns(slug, loopId) }),
    qc.invalidateQueries({ queryKey: queryKeys.loopState(slug, loopId) }),
    qc.invalidateQueries({ queryKey: queryKeys.loopBudget(slug, loopId) }),
    qc.invalidateQueries({ queryKey: queryKeys.loopCollisions(slug, loopId) }),
    qc.invalidateQueries({ queryKey: queryKeys.loopIntegrations(slug, loopId) }),
    qc.invalidateQueries({ queryKey: queryKeys.activeLoops }),
    qc.invalidateQueries({ queryKey: queryKeys.loopKillState(slug) }),
  ]);
}

/** Pure invalidation helper for pauseLoop / resumeLoop onSuccess. */
export function invalidateLoopAfterPauseResume(
  qc: { invalidateQueries: (opts: { queryKey: readonly unknown[]; exact?: boolean }) => Promise<void> },
  slug: string,
  loopId: string,
): Promise<void[]> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: queryKeys.projectLoops(slug) }),
    qc.invalidateQueries({ queryKey: queryKeys.loop(slug, loopId) }),
    qc.invalidateQueries({ queryKey: queryKeys.loopState(slug, loopId) }),
    qc.invalidateQueries({ queryKey: queryKeys.loopBudget(slug, loopId) }),
    qc.invalidateQueries({ queryKey: queryKeys.loopCollisions(slug, loopId) }),
    qc.invalidateQueries({ queryKey: queryKeys.loopIntegrations(slug, loopId) }),
    qc.invalidateQueries({ queryKey: queryKeys.activeLoops }),
    qc.invalidateQueries({ queryKey: queryKeys.loopKillState(slug) }),
  ]);
}

export function useCreateLoop() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (variables: { slug: string } & CreateLoopPayload) => {
      const { slug, ...payload } = variables;
      const body = buildCreateLoopRequestBody(payload);
      return apiFetch<{ loop: LoopState }>(`/api/projects/${encodeURIComponent(slug)}/loops`, {
        method: "POST",
        body,
      });
    },
    onSuccess: async (_data, variables) => {
      await invalidateLoopAfterCreate(queryClient, variables.slug);
    },
  });
}

export function buildCreateLoopRequestBody(payload: CreateLoopPayload): Record<string, unknown> {
  const body: Record<string, unknown> = {
    templateId: payload.templateId,
    schedule: payload.schedule,
    approvalPolicy: payload.approvalPolicy,
    limits: payload.limits,
    useWorktree: payload.useWorktree,
  };
  if (payload.taskPrompt) body.taskPrompt = payload.taskPrompt;
  if (payload.goalTemplate) body.goalTemplate = payload.goalTemplate;
  if (payload.triggers && payload.triggers.length > 0) body.triggers = payload.triggers;
  return body;
}

export function useUpdateLoop() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      slug,
      loopId,
      ...payload
    }: {
      slug: string;
      loopId: string;
    } & UpdateLoopPayload) => {
      const body = buildUpdateLoopRequestBody(payload);
      return apiFetch<{ loop: LoopState }>(
        `/api/projects/${encodeURIComponent(slug)}/loops/${encodeURIComponent(loopId)}`,
        { method: "PATCH", body },
      );
    },
    onSuccess: async (_data, variables) => {
      await invalidateLoopAfterUpdate(queryClient, variables.slug, variables.loopId);
    },
  });
}

export function buildUpdateLoopRequestBody(payload: UpdateLoopPayload): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (payload.status !== undefined) body.status = payload.status;
  if (payload.templateId !== undefined) body.templateId = payload.templateId;
  if (payload.schedule !== undefined) body.schedule = payload.schedule;
  if (payload.approvalPolicy !== undefined) body.approvalPolicy = payload.approvalPolicy;
  if (payload.limits !== undefined) body.limits = payload.limits;
  if (payload.taskPrompt !== undefined) body.taskPrompt = payload.taskPrompt;
  if (payload.goalTemplate !== undefined) body.goalTemplate = payload.goalTemplate;
  if (payload.triggers !== undefined) body.triggers = payload.triggers;
  if (payload.useWorktree !== undefined) body.useWorktree = payload.useWorktree;
  return body;
}

export function useTriggerLoop() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ slug, loopId }: { slug: string; loopId: string }) =>
      apiFetch<{ report: LoopRunReport | null }>(
        `/api/projects/${encodeURIComponent(slug)}/loops/${encodeURIComponent(loopId)}/trigger`,
        { method: "POST" },
      ),
    onSuccess: async (_data, variables) => {
      await invalidateLoopAfterTrigger(queryClient, variables.slug, variables.loopId);
    },
  });
}

export function usePauseLoop() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ slug, loopId }: { slug: string; loopId: string }) =>
      apiFetch<{ loop: LoopState }>(
        `/api/projects/${encodeURIComponent(slug)}/loops/${encodeURIComponent(loopId)}/pause`,
        { method: "POST" },
      ),
    onSuccess: async (_data, variables) => {
      await invalidateLoopAfterPauseResume(queryClient, variables.slug, variables.loopId);
    },
  });
}

export function useResumeLoop() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ slug, loopId }: { slug: string; loopId: string }) =>
      apiFetch<{ loop: LoopState }>(
        `/api/projects/${encodeURIComponent(slug)}/loops/${encodeURIComponent(loopId)}/resume`,
        { method: "POST" },
      ),
    onSuccess: async (_data, variables) => {
      await invalidateLoopAfterPauseResume(queryClient, variables.slug, variables.loopId);
    },
  });
}

// ─── Loop guardrail mutations ───

/** Pure invalidation helper for cancelCurrentRun onSuccess. */
export function invalidateLoopAfterCancelCurrentRun(
  qc: { invalidateQueries: (opts: { queryKey: readonly unknown[]; exact?: boolean }) => Promise<void> },
  slug: string,
  loopId: string,
): Promise<void[]> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: queryKeys.loop(slug, loopId) }),
    qc.invalidateQueries({ queryKey: queryKeys.loopRuns(slug, loopId) }),
    qc.invalidateQueries({ queryKey: queryKeys.loopState(slug, loopId) }),
    qc.invalidateQueries({ queryKey: queryKeys.loopBudget(slug, loopId) }),
    qc.invalidateQueries({ queryKey: queryKeys.loopCollisions(slug, loopId) }),
    qc.invalidateQueries({ queryKey: queryKeys.loopIntegrations(slug, loopId) }),
    qc.invalidateQueries({ queryKey: queryKeys.projectLoops(slug) }),
    qc.invalidateQueries({ queryKey: queryKeys.activeLoops }),
    qc.invalidateQueries({ queryKey: queryKeys.loopKillState(slug) }),
  ]);
}

/** Pure invalidation helper for global kill activate/clear onSuccess. */
export function invalidateLoopAfterGlobalKill(
  qc: { invalidateQueries: (opts: { queryKey: readonly unknown[]; exact?: boolean }) => Promise<void> },
  slug: string,
): Promise<void[]> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: queryKeys.loopKillState(slug) }),
    qc.invalidateQueries({ queryKey: queryKeys.projectLoops(slug) }),
    qc.invalidateQueries({ queryKey: queryKeys.activeLoops }),
    // Invalidate all per-loop guardrail caches (budget, collisions, integrations)
    // across every loop in the project via prefix match.
    qc.invalidateQueries({ queryKey: ["projects", slug, "loops"], exact: false }),
  ]);
}

export function useCancelLoopCurrentRun() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ slug, loopId }: { slug: string; loopId: string }) =>
      apiFetch<CancelCurrentRunResponse>(
        `/api/projects/${encodeURIComponent(slug)}/loops/${encodeURIComponent(loopId)}/runs/current/cancel`,
        { method: "POST" },
      ),
    onSuccess: async (_data, variables) => {
      await invalidateLoopAfterCancelCurrentRun(queryClient, variables.slug, variables.loopId);
    },
  });
}

export function useActivateLoopGlobalKill() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      slug,
      activatedBy,
      reason,
    }: {
      slug: string;
      activatedBy?: string;
      reason?: string;
    }) => {
      const body: Record<string, unknown> = {};
      if (activatedBy !== undefined) body.activatedBy = activatedBy;
      if (reason !== undefined) body.reason = reason;
      return apiFetch<{ killState: LoopKillState }>(
        `/api/projects/${encodeURIComponent(slug)}/loops/kill-all`,
        { method: "POST", body },
      );
    },
    onSuccess: async (_data, variables) => {
      await invalidateLoopAfterGlobalKill(queryClient, variables.slug);
    },
  });
}

export function useClearLoopGlobalKill() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ slug }: { slug: string }) =>
      apiFetch<{ killState: LoopKillState }>(
        `/api/projects/${encodeURIComponent(slug)}/loops/kill-all`,
        { method: "DELETE" },
      ),
    onSuccess: async (_data, variables) => {
      await invalidateLoopAfterGlobalKill(queryClient, variables.slug);
    },
  });
}
