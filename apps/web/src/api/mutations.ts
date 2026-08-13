import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { queryKeys } from "./queries";
import type {
  AttachmentDescriptor,
  ProjectTodoAttachmentMutationResponse,
  ProjectTodoResponse,
  RequestedModelSelection,
  SessionModelState,
} from "@archcode/protocol";
import {
  removeProjectControlPlane,
  removeSessionControlPlane,
} from "../store/control-plane-readiness";
import { hitlStore } from "../store/hitl-store";
import { removeWebSessionStores } from "../store/session-store";
import type {
  HitlResponse,
  HitlStatus,
  HitlView,
  Project,
  Session,
  SessionSummary,
  ProjectSessionInventoryItem,
  ProjectTodoRunNowResponse,
  ProjectTodoStartDiscussionResponse,
  Automation,
  AutomationAction,
  AutomationTrigger,
  UpdateAutomationPayload,
  ProjectTodo,
  ProjectTodoCreateInput,
  CreateProjectTodoSessionInput,
  ProjectTodoUpdateInput,
} from "./types";
import { createClientUuid } from "../lib/client-uuid";

export async function invalidateProjectCatalog(
  queryClient: Pick<QueryClient, "invalidateQueries">,
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.projects }),
    queryClient.invalidateQueries({ queryKey: queryKeys.home }),
  ]);
}

export function useUpdateProjectName() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ slug, name }: { slug: string; name: string }) =>
      apiFetch<Project>(`/api/projects/${encodeURIComponent(slug)}`, {
        method: "PATCH",
        body: { name },
      }),
    onSuccess: async () => {
      await invalidateProjectCatalog(queryClient);
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
      await invalidateProjectCatalog(queryClient);
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
      queryClient.removeQueries({ queryKey: ["projects", slug] });
      await invalidateProjectCatalog(queryClient);
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

export interface DeleteSessionInput {
  slug: string;
  sessionId: string;
  rootSessionId: string;
  sessionIds: readonly string[];
}

export function deleteSession({
  slug,
  sessionId,
}: Pick<DeleteSessionInput, "slug" | "sessionId">): Promise<{ ok: true }> {
  return apiFetch<{ ok: true }>(
    `/api/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sessionId)}`,
    { method: "DELETE" },
  );
}

export function useDeleteSession() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: DeleteSessionInput) => deleteSession(input),
    onSuccess: (_data, variables) => {
      queryClient.setQueryData<ProjectSessionInventoryItem[]>(
        queryKeys.sessions(variables.slug),
        (items) => items?.filter((item) => item.session.sessionId !== variables.rootSessionId),
      );
      for (const deletedSessionId of new Set(variables.sessionIds)) {
        queryClient.removeQueries({
          queryKey: queryKeys.session(variables.slug, deletedSessionId),
          exact: true,
        });
      }
      queryClient.removeQueries({
        queryKey: queryKeys.tree(variables.slug, variables.rootSessionId),
        exact: true,
      });
      removeSessionControlPlane(variables.slug, variables.rootSessionId);
      removeWebSessionStores(variables.slug, variables.sessionIds);

      void Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.sessions(variables.slug) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.projectTodos(variables.slug) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.home }),
      ]);
    },
  });
}

export interface PostMessageInput {
  slug: string;
  sessionId: string;
  content: string;
  attachmentIds: readonly string[];
  clientRequestId?: string;
  requestedModelSelection: RequestedModelSelection;
}

export type MessageAcceptance =
  | { clientRequestId: string; status: "command" }
  | { clientRequestId: string; messageId: string; status: "queued" | "canonical" };

export function postMessage({ slug, sessionId, content, attachmentIds, clientRequestId, requestedModelSelection }: PostMessageInput): Promise<MessageAcceptance> {
  const requestId = clientRequestId ?? createClientUuid();
  return apiFetch<MessageAcceptance>(
    `/api/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sessionId)}/messages`,
    {
      method: "POST",
      body: { text: content, attachmentIds, clientRequestId: requestId, requestedModelSelection },
    },
  );
}

export interface UploadSessionAttachmentInput {
  slug: string;
  sessionId: string;
  attachmentId: string;
  file: File;
}

/**
 * Sends exactly one raw file stream. The generated attachment id is deliberately
 * stable across retries so the server can make an uncertain upload idempotent.
 */
export function uploadSessionAttachment({
  slug,
  sessionId,
  attachmentId,
  file,
}: UploadSessionAttachmentInput): Promise<AttachmentDescriptor> {
  const query = new URLSearchParams({ name: file.name, sizeBytes: String(file.size) });
  return apiFetch<AttachmentDescriptor>(
    `/api/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachmentId)}?${query}`,
    {
      method: "PUT",
      headers: file.type ? { "Content-Type": file.type } : undefined,
      body: file,
    },
  );
}

export interface PatchSessionModelSelectionInput {
  slug: string;
  sessionId: string;
  expectedRevision: number;
  requestedModelSelection: RequestedModelSelection;
}

export function patchSessionModelSelection({ slug, sessionId, expectedRevision, requestedModelSelection }: PatchSessionModelSelectionInput): Promise<SessionModelState> {
  return apiFetch<SessionModelState>(
    `/api/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sessionId)}/model-selection`,
    { method: "PATCH", body: { expectedRevision, requestedModelSelection } },
  );
}

export function usePatchSessionModelSelection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: patchSessionModelSelection,
    onSettled: async (_state, _error, variables) => {
      await invalidateSessionModelSelectionQuery(queryClient, variables);
    },
  });
}

export async function invalidateSessionModelSelectionQuery(
  queryClient: Pick<QueryClient, "invalidateQueries">,
  variables: Pick<PatchSessionModelSelectionInput, "slug" | "sessionId">,
): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: queryKeys.session(variables.slug, variables.sessionId) });
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

// ─── Session Goal Controls ───

export type SessionGoalControlAction = "pause" | "resume" | "clear";

export interface EditSessionGoalInput {
  slug: string;
  sessionId: string;
  objective: string;
  expectedGeneration: number;
}

export function useEditSessionGoal() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ slug, sessionId, objective, expectedGeneration }: EditSessionGoalInput) =>
      apiFetch<Session>(`/api/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sessionId)}/goal`, {
        method: "PATCH",
        body: { objective, expectedGeneration },
      }),
    onSuccess: async (_session, variables) => invalidateSessionGoalQueries(queryClient, variables.slug, variables.sessionId),
  });
}

export function useSessionGoalControl() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ slug, sessionId, action }: { slug: string; sessionId: string; action: SessionGoalControlAction }): Promise<Session | { ok: true }> =>
      action === "clear"
        ? apiFetch<{ ok: true }>(`/api/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sessionId)}/goal`, { method: "DELETE" })
        : apiFetch<Session>(`/api/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sessionId)}/goal/${action}`, { method: "POST" }),
    onSuccess: async (_result, variables) => invalidateSessionGoalQueries(queryClient, variables.slug, variables.sessionId),
  });
}

export function useSetSessionGoalBudget() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: setSessionGoalBudget,
    onSuccess: async (_session, variables) => invalidateSessionGoalQueries(queryClient, variables.slug, variables.sessionId),
  });
}

export function setSessionGoalBudget({ slug, sessionId, tokenBudget }: { slug: string; sessionId: string; tokenBudget: number | null }): Promise<Session> {
  return apiFetch<Session>(`/api/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sessionId)}/goal/budget`, {
    method: "POST",
    body: { tokenBudget },
  });
}

async function invalidateSessionGoalQueries(queryClient: QueryClient, slug: string, sessionId: string): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.session(slug, sessionId) }),
    queryClient.invalidateQueries({ queryKey: queryKeys.sessions(slug) }),
    queryClient.invalidateQueries({ queryKey: queryKeys.home }),
  ]);
}

// ─── HITL Mutations ───

export interface HitlMutationResponse {
  hitlId: string;
  status: HitlStatus;
  view: HitlView;
}

export function applyHitlMutationResult(projectSlug: string, result: HitlMutationResponse): void {
  hitlStore.getState().reconcileView(projectSlug, result.view);
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
    qc.invalidateQueries({ queryKey: queryKeys.home }),
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

export interface CreateAutomationInput {
  slug: string;
  name: string;
  trigger: AutomationTrigger;
  action: AutomationAction;
}

export function useCreateAutomation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ slug, ...input }: CreateAutomationInput) => apiFetch<{ automation: Automation }>(
      `/api/projects/${encodeURIComponent(slug)}/automations`,
      { method: "POST", body: input },
    ),
    onSuccess: async (_data, variables) => {
      await invalidateAutomation(queryClient, variables.slug);
    },
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
): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: queryKeys.projectTodos(slug), exact: true, refetchType: "all" });
}

export interface UploadProjectTodoAttachmentInput {
  slug: string;
  todoId: string;
  attachmentId: string;
  expectedRevision: number;
  file: File;
}

/** Upload one raw file and activate its Todo reference atomically on the server. */
export function uploadProjectTodoAttachment({
  slug,
  todoId,
  attachmentId,
  expectedRevision,
  file,
}: UploadProjectTodoAttachmentInput): Promise<ProjectTodoAttachmentMutationResponse> {
  const query = new URLSearchParams({
    name: file.name,
    sizeBytes: String(file.size),
    expectedRevision: String(expectedRevision),
  });
  return apiFetch<ProjectTodoAttachmentMutationResponse>(
    `${todoUrl(slug, todoId, "attachments")}/${encodeURIComponent(attachmentId)}?${query.toString()}`,
    {
      method: "PUT",
      headers: file.type ? { "Content-Type": file.type } : undefined,
      body: file,
    },
  );
}

export interface RemoveProjectTodoAttachmentInput {
  slug: string;
  todoId: string;
  attachmentId: string;
  expectedRevision: number;
}

/** Remove the Todo reference; physical cleanup remains a server concern. */
export function removeProjectTodoAttachment({
  slug,
  todoId,
  attachmentId,
  expectedRevision,
}: RemoveProjectTodoAttachmentInput): Promise<ProjectTodoResponse> {
  return apiFetch<ProjectTodoResponse>(
    `${todoUrl(slug, todoId, "attachments")}/${encodeURIComponent(attachmentId)}`,
    { method: "DELETE", body: { expectedRevision } },
  );
}

async function invalidateProjectTodoSession(
  queryClient: ReturnType<typeof useQueryClient>,
  slug: string,
): Promise<void> {
  await Promise.all([
    invalidateProjectTodo(queryClient, slug),
    queryClient.invalidateQueries({ queryKey: queryKeys.sessions(slug) }),
    queryClient.invalidateQueries({ queryKey: queryKeys.home }),
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

export function useRunProjectTodoNow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ slug, clientRequestId, content }: { slug: string; clientRequestId: string; content: string }) =>
      apiFetch<ProjectTodoRunNowResponse>(`${todoUrl(slug)}/run-now`, {
        method: "POST",
        body: { clientRequestId, content },
      }),
    onSettled: async (_data, _error, variables) => {
      await invalidateProjectTodoSession(queryClient, variables.slug);
    },
  });
}

export function useStartProjectTodoDiscussion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      slug,
      clientRequestId,
      content,
    }: {
      slug: string;
      clientRequestId: string;
      content: string;
    }) => apiFetch<ProjectTodoStartDiscussionResponse>(`${todoUrl(slug)}/start-discussion`, {
      method: "POST",
      body: { clientRequestId, content },
    }),
    onSettled: async (_data, _error, variables) => {
      await invalidateProjectTodoSession(queryClient, variables.slug);
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
      await invalidateProjectTodo(queryClient, variables.slug);
    },
    onError: async (_error, variables) => {
      await invalidateProjectTodo(queryClient, variables.slug);
    },
  });
}

export function useCreateProjectTodoSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ slug, todoId, input }: TodoMutationVariables & { input: CreateProjectTodoSessionInput }) =>
      apiFetch<{ todo: ProjectTodo; sessionId: string }>(todoUrl(slug, todoId, "sessions"), { method: "POST", body: input as unknown as Record<string, unknown> }),
    onSuccess: async (_data, variables) => {
      await invalidateProjectTodoSession(queryClient, variables.slug);
    },
    onError: async (_error, variables) => {
      await invalidateProjectTodoSession(queryClient, variables.slug);
    },
  });
}
