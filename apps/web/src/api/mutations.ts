import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { queryKeys } from "./queries";
import {
  removeProjectControlPlane,
} from "../store/control-plane-readiness";
import { hitlStore } from "../store/hitl-store";
import type {
  GoalState,
  HitlResponse,
  HitlStatus,
  HitlView,
  Project,
  Session,
  UpdateAutomationPayload,
  ProjectTodo,
  ProjectTodoActivationKind,
  ProjectTodoCreateInput,
  ProjectTodoUpdateInput,
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

export interface PostMessageInput {
  slug: string;
  sessionId: string;
  content: string;
  clientRequestId?: string;
}

export interface MessageAcceptance {
  clientRequestId: string;
  messageId: string;
  status?: "queued" | "canonical" | "command";
}

export function postMessage({ slug, sessionId, content, clientRequestId }: PostMessageInput): Promise<MessageAcceptance> {
  const requestId = clientRequestId ?? crypto.randomUUID();
  return apiFetch<MessageAcceptance>(
    `/api/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sessionId)}/messages`,
    {
      method: "POST",
      body: { text: content, clientRequestId: requestId },
    },
  );
}

export function usePostMessage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: postMessage,
    onSuccess: async (_acceptance, variables) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.session(variables.slug, variables.sessionId) });
    },
  });
}

export interface PendingMessageMutationInput {
  slug: string;
  sessionId: string;
  messageId: string;
  expectedRevision: number;
}

export interface PendingMessageMutationResult {
  messageId: string;
  status: "queued" | "steering" | "canonical" | "deleted";
  revision?: number;
  content?: string;
  clientRequestId?: string;
}

export function useEditPendingMessage() {
  return useMutation({
    mutationFn: async ({ slug, sessionId, messageId, expectedRevision, content }: PendingMessageMutationInput & { content: string }) =>
      apiFetch<PendingMessageMutationResult>(
        `/api/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}`,
        { method: "PATCH", body: { text: content, expectedRevision } },
      ),
  });
}

export function useDeletePendingMessage() {
  return useMutation({
    mutationFn: async ({ slug, sessionId, messageId, expectedRevision }: PendingMessageMutationInput) =>
      apiFetch<PendingMessageMutationResult>(
        `/api/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}`,
        { method: "DELETE", body: { expectedRevision } },
      ),
  });
}

export function useSteerPendingMessage() {
  return useMutation({
    mutationFn: async ({ slug, sessionId, messageId, expectedRevision, expectedExecutionId }: PendingMessageMutationInput & { expectedExecutionId: string }) =>
      apiFetch<PendingMessageMutationResult>(
        `/api/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/steer`,
        { method: "POST", body: { expectedRevision, expectedExecutionId } },
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

// ─── Project Todo mutations ───

type TodoMutationVariables = { slug: string; todoId: string };

function todoUrl(slug: string, todoId?: string, action?: string): string {
  const base = `/api/projects/${encodeURIComponent(slug)}/todos`;
  return todoId === undefined
    ? base
    : `${base}/${encodeURIComponent(todoId)}${action ? `/${action}` : ""}`;
}

async function invalidateProjectTodo(
  queryClient: ReturnType<typeof useQueryClient>,
  slug: string,
  todoId?: string,
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.projectTodos(slug), exact: true, refetchType: "all" }),
    ...(todoId === undefined
      ? []
      : [queryClient.invalidateQueries({ queryKey: queryKeys.projectTodo(slug, todoId), exact: true, refetchType: "all" })]),
  ]);
}

async function invalidateProjectTodoExecution(
  queryClient: ReturnType<typeof useQueryClient>,
  slug: string,
  todoId: string,
): Promise<void> {
  await Promise.all([
    invalidateProjectTodo(queryClient, slug, todoId),
    queryClient.invalidateQueries({ queryKey: queryKeys.sessions(slug) }),
    queryClient.invalidateQueries({ queryKey: queryKeys.projectGoals(slug) }),
    queryClient.invalidateQueries({ queryKey: queryKeys.projectAutomations(slug) }),
  ]);
}

export function useCreateProjectTodo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ slug, input }: { slug: string; input: ProjectTodoCreateInput }) =>
      apiFetch<{ todo: ProjectTodo }>(todoUrl(slug), { method: "POST", body: input as unknown as Record<string, unknown> }),
    onSuccess: async (_data, variables) => {
      await invalidateProjectTodo(queryClient, variables.slug);
    },
    onError: async (_error, variables) => {
      await invalidateProjectTodo(queryClient, variables.slug);
    },
  });
}

export function useUpdateProjectTodo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ slug, todoId, input }: TodoMutationVariables & { input: ProjectTodoUpdateInput }) =>
      apiFetch<{ todo: ProjectTodo }>(todoUrl(slug, todoId), {
        method: "PATCH",
        body: input as unknown as Record<string, unknown>,
      }),
    onSuccess: async (_data, variables) => {
      await invalidateProjectTodo(queryClient, variables.slug, variables.todoId);
    },
    onError: async (_error, variables) => {
      await invalidateProjectTodo(queryClient, variables.slug, variables.todoId);
    },
  });
}

function useTodoAction(action: "archive" | "restore" | "return-to-ready") {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ slug, todoId, expectedRevision }: TodoMutationVariables & { expectedRevision: number }) =>
      apiFetch<{ todo: ProjectTodo }>(todoUrl(slug, todoId, action), {
        method: "POST",
        body: { expectedRevision },
      }),
    onSuccess: async (_data, variables) => {
      await invalidateProjectTodo(queryClient, variables.slug, variables.todoId);
    },
    onError: async (_error, variables) => {
      await invalidateProjectTodo(queryClient, variables.slug, variables.todoId);
    },
  });
}

export function useArchiveProjectTodo() { return useTodoAction("archive"); }
export function useRestoreProjectTodo() { return useTodoAction("restore"); }
export function useReturnProjectTodoToReady() { return useTodoAction("return-to-ready"); }

export function useDiscussProjectTodo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ slug, todoId, expectedRevision }: TodoMutationVariables & { expectedRevision: number }) =>
      apiFetch<{ todo: ProjectTodo; sessionId: string }>(todoUrl(slug, todoId, "discuss"), { method: "POST", body: { expectedRevision } }),
    onSuccess: async (_data, variables) => {
      await Promise.all([
        invalidateProjectTodo(queryClient, variables.slug, variables.todoId),
        queryClient.invalidateQueries({ queryKey: queryKeys.sessions(variables.slug) }),
      ]);
    },
    onError: async (_error, variables) => {
      await Promise.all([
        invalidateProjectTodo(queryClient, variables.slug, variables.todoId),
        queryClient.invalidateQueries({ queryKey: queryKeys.sessions(variables.slug) }),
      ]);
    },
  });
}

export function useActivateProjectTodo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ slug, todoId, kind, expectedRevision }: TodoMutationVariables & { kind: ProjectTodoActivationKind; expectedRevision: number }) =>
      apiFetch<{ todo: ProjectTodo; sessionId: string }>(todoUrl(slug, todoId, "activate"), {
        method: "POST",
        body: { kind, expectedRevision },
      }),
    onSuccess: async (_data, variables) => {
      await invalidateProjectTodoExecution(queryClient, variables.slug, variables.todoId);
    },
    onError: async (_error, variables) => {
      await invalidateProjectTodoExecution(queryClient, variables.slug, variables.todoId);
    },
  });
}
