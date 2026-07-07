import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { queryKeys } from "./queries";
import type {
  ApprovalPoint,
  CancelCurrentRunResponse,
  CommandResult,
  DoneCondition,
  GoalState,
  LoopConfig,
  LoopKillState,
  LoopRunReport,
  LoopState,
  Project,
  RetryPolicy,
  Session,
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
    }) => apiFetch<CommandResult>(
      `/api/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sessionId)}/commands`,
      {
        method: "POST",
        body: args === undefined ? { name } : { name, args },
      },
    ),
  });
}

export function useAbortSession() {
  return useMutation({
    mutationFn: async ({
      slug,
      sessionId,
    }: {
      slug: string;
      sessionId: string;
    }) => apiFetch<{ ok: boolean; aborted: boolean }>(
      `/api/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sessionId)}/abort`,
      {
        method: "POST",
      },
    ),
  });
}

// ─── Goal Mutations ───

export function useCreateGoal() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      slug,
      title,
      doneConditions,
      retryPolicy,
      approvalPoints,
      reviewerAgent,
      author,
    }: {
      slug: string;
      title: string;
      doneConditions: DoneCondition[];
      retryPolicy: RetryPolicy;
      approvalPoints: ApprovalPoint[];
      reviewerAgent: string;
      author: string;
    }) => apiFetch<GoalState>(`/api/projects/${encodeURIComponent(slug)}/goals`, {
      method: "POST",
      body: { title, doneConditions, retryPolicy, approvalPoints, reviewerAgent, author },
    }),
    onSuccess: async (_data, variables) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.projectGoals(variables.slug) });
    },
  });
}

export function useLockGoal() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ slug, goalId, lockedBy }: { slug: string; goalId: string; lockedBy: string }) =>
      apiFetch<GoalState>(`/api/projects/${encodeURIComponent(slug)}/goals/${encodeURIComponent(goalId)}/lock`, {
        method: "POST",
        body: { lockedBy },
      }),
    onSuccess: async (_data, variables) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.goal(variables.slug, variables.goalId) });
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

export function useEscalateGoal() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ slug, goalId }: { slug: string; goalId: string }) =>
      apiFetch<GoalState>(`/api/projects/${encodeURIComponent(slug)}/goals/${encodeURIComponent(goalId)}/escalate`, {
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
      projectSlug,
      hitlId,
      body,
    }: {
      projectSlug: string;
      hitlId: string;
      body: {
        decision?: string;
        answers?: unknown;
        outcome?: "DONE" | "NOT_DONE";
        comment?: string;
        data?: Record<string, unknown>;
      };
    }) => apiFetch<{ ok: boolean; hitlId: string }>(`/api/projects/${encodeURIComponent(projectSlug)}/hitl/${encodeURIComponent(hitlId)}/respond`, {
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
    mutationFn: async ({ projectSlug, hitlId, reason }: { projectSlug: string; hitlId: string; reason?: string }) =>
      apiFetch<{ ok: boolean; hitlId: string }>(`/api/projects/${encodeURIComponent(projectSlug)}/hitl/${encodeURIComponent(hitlId)}/cancel`, {
        method: "POST",
        body: reason ? { reason } : {},
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.hitl });
      await queryClient.invalidateQueries({ queryKey: ["projects"], exact: false });
    },
  });
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

  type CreateLoopVariables = { slug: string; author?: string } & (
    | { config: LoopConfig; presetId?: never }
    | { presetId: string; config?: never }
  );

  return useMutation({
    mutationFn: async ({
      slug,
      config,
      presetId,
      author,
    }: CreateLoopVariables) => {
      const body = config
        ? { config, ...(author ? { author } : {}) }
        : { presetId, ...(author ? { author } : {}) };
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

export function useUpdateLoop() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      slug,
      loopId,
      config,
      status,
    }: {
      slug: string;
      loopId: string;
      config?: LoopConfig;
      status?: "active" | "paused" | "disabled" | "error";
    }) => {
      const body: Record<string, unknown> = {};
      if (config !== undefined) body.config = config;
      if (status !== undefined) body.status = status;
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
