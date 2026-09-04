import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  rootSessionSourceTodoId,
  isSessionMessageUnavailableCode,
  type RequestedModelSelection,
} from "@archcode/protocol";
import { Archive, ChevronDown, ChevronRight, LoaderCircle, MessageSquare, Repeat2, Save, Search, XCircle } from "lucide-react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { ApiError } from "../api/client";
import { useCreateProjectTodoSession, usePostMessage, useUpdateProjectTodo } from "../api/mutations";
import { sessionQueryOptions, useProjectTodoPlan, useProjectTodos, useSession, useSessionInventory } from "../api/queries";
import type { ProjectSessionInventoryItem, ProjectTodo, ProjectTodoUpdateInput } from "../api/types";
import { MarkdownContent } from "../components/primitives/MarkdownContent";
import { RelativeTimeValue, useRelativeTime } from "../components/primitives/TemporalText";
import { TodoReferences } from "../components/features/TodoReferences";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRoot,
  DropdownMenuTrigger,
} from "../components/ui/DropdownMenu";
import { createClientUuid } from "../lib/client-uuid";
import {
  hitlAttentionPath,
  scopedHitlIdentity,
  useAttentionVisibleScopedHitl,
  useHitlProjectInitialized,
  type ScopedHitlView,
} from "../store/hitl-store";
import { demoteEmbeddedMarkdownHeadings, presentProjectTodoLinkedSession, projectTodoDisplayLead, PROJECT_TODO_LANE_PRESENTATIONS, type ProjectTodoLane } from "./project-todo-presentation";
import { extractProjectTodoResultParts, selectProjectTodoResultSession } from "./project-todo-result";
import { SelectedTodoShell } from "./selected-todo-shell";

const LANES: readonly ProjectTodoLane[] = ["idea", "ready", "in_progress", "done"];
export const TODO_PLAN_ACTION_LABEL = "Generate / Improve Plan";

export type TodoWorkKind = "all" | "discussion" | "session" | "automation";

export interface TodoWorkReturnState {
  readonly todoId: string;
  readonly filter: string;
  readonly kind: TodoWorkKind;
  readonly scrollTop: number;
}

export interface TodoWorkNavigationState {
  readonly fromTodoWork: true;
  readonly todoWork: TodoWorkReturnState;
}

export function createTodoWorkNavigationState(todoWork: TodoWorkReturnState): TodoWorkNavigationState {
  return { fromTodoWork: true, todoWork };
}

export function readTodoWorkReturnState(state: unknown, todoId: string): TodoWorkReturnState | undefined {
  if (typeof state !== "object" || state === null) return undefined;
  if (Reflect.get(state, "fromTodoWork") !== true) return undefined;
  const value = Reflect.get(state, "todoWork");
  if (typeof value !== "object" || value === null || Reflect.get(value, "todoId") !== todoId) return undefined;
  const kind = Reflect.get(value, "kind");
  const filter = Reflect.get(value, "filter");
  const scrollTop = Reflect.get(value, "scrollTop");
  if (!isTodoWorkKind(kind) || typeof filter !== "string" || typeof scrollTop !== "number" || !Number.isFinite(scrollTop)) return undefined;
  return { todoId, kind, filter, scrollTop: Math.max(0, scrollTop) };
}

const WORK_KIND_OPTIONS: readonly { value: TodoWorkKind; label: string }[] = [
  { value: "all", label: "All" },
  { value: "discussion", label: "Discussions" },
  { value: "session", label: "Work sessions" },
  { value: "automation", label: "Automations" },
];

export function continueWorkUpdateInput(todo: ProjectTodo): ProjectTodoUpdateInput | undefined {
  return todo.status === "ready"
    ? { expectedRevision: todo.revision, status: "in_progress" }
    : undefined;
}

export function planWorkCommand(todoId: string): string {
  return `/skill use plan-work Create or improve the implementation Plan for this bound Todo at .archcode/plans/${todoId}.md. Preserve one Plan file, read it before editing when it exists, and do not start implementation.`;
}

export async function coordinateTodoPlanWork(input: {
  todoId: string;
  existingDiscussionSessionId?: string;
  createPlanDiscussion: () => Promise<string>;
  loadExistingDiscussion: (sessionId: string) => Promise<{
    isBusy: boolean;
    requestedModelSelection: RequestedModelSelection;
  } | undefined>;
  sendCommand: (
    sessionId: string,
    command: string,
    selection: RequestedModelSelection,
  ) => Promise<"sent" | "unavailable">;
  openSession: (sessionId: string) => void;
}): Promise<string> {
  const createAndOpen = async (): Promise<string> => {
    const sessionId = await input.createPlanDiscussion();
    input.openSession(sessionId);
    return sessionId;
  };

  if (input.existingDiscussionSessionId === undefined) return createAndOpen();
  const sessionId = input.existingDiscussionSessionId;
  const existing = await input.loadExistingDiscussion(sessionId);
  if (existing === undefined || existing.isBusy) return createAndOpen();
  const disposition = await input.sendCommand(
    sessionId,
    planWorkCommand(input.todoId),
    existing.requestedModelSelection,
  );
  if (disposition === "unavailable") return createAndOpen();
  input.openSession(sessionId);
  return sessionId;
}

function isUnavailablePlanDiscussion(cause: unknown): boolean {
  if (!(cause instanceof ApiError)) return false;
  if (cause.status === 404) return cause.code === "SESSION_NOT_FOUND";
  if (cause.status !== 409 || typeof cause.details !== "object" || cause.details === null) return false;
  return isSessionMessageUnavailableCode(Reflect.get(cause.details, "scopeCode"));
}

export function ProjectTodoDetailRoute() {
  const { slug = "", todoId = "" } = useParams<{ slug: string; todoId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const todos = useProjectTodos(slug);
  const sessionInventory = useSessionInventory(slug);
  const todo = todos.data?.find((item) => item.id === todoId);
  const backToTodos = () => {
    const state = location.state as { fromTodos?: boolean } | null;
    if (state?.fromTodos) navigate(-1);
    else navigate(`/projects/${encodeURIComponent(slug)}/todos`);
  };

  if (todos.isLoading) return <RouteMessage>Loading Todo…</RouteMessage>;
  if (todos.error && todos.data === undefined) return <RouteMessage tone="error">Failed to load Todo</RouteMessage>;
  if (todo === undefined) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 bg-bg-base px-6 text-center">
        <div>
          <h1 className="text-[18px] font-semibold text-text-primary">Todo not found</h1>
          <p className="mt-2 text-[13px] text-text-tertiary">Todo {todoId} is unavailable. It may have been removed.</p>
        </div>
        <button type="button" onClick={backToTodos} className="h-9 rounded-sm border border-border-default bg-bg-active px-3 text-[12px] font-semibold text-text-secondary hover:bg-bg-hover">Back to Todos</button>
      </div>
    );
  }

  return (
    <TodoDetailView
      key={todo.id}
      todo={todo}
      slug={slug}
      sessionInventory={sessionInventory.data ?? []}
      sessionsLoading={sessionInventory.isLoading}
      sessionsError={sessionInventory.error}
    />
  );
}

function TodoDetailView({ todo, slug, sessionInventory, sessionsLoading, sessionsError }: {
  todo: ProjectTodo;
  slug: string;
  sessionInventory: ProjectSessionInventoryItem[];
  sessionsLoading: boolean;
  sessionsError: unknown;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const createSession = useCreateProjectTodoSession();
  const updateTodo = useUpdateProjectTodo();
  const postMessage = usePostMessage();
  const plan = useProjectTodoPlan(slug, todo.id);
  const scopedHitl = useAttentionVisibleScopedHitl([slug]);
  const hitlInitialized = useHitlProjectInitialized(slug);
  const selectedResultSession = selectProjectTodoResultSession(sessionInventory, todo.id);
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(todo.content);
  const [reason, setReason] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [isOpeningPlan, setIsOpeningPlan] = useState(false);
  const returnState = useMemo(() => readTodoWorkReturnState(location.state, todo.id), [location.state, todo.id]);
  const [workFilter, setWorkFilter] = useState(returnState?.filter ?? "");
  const [workKind, setWorkKind] = useState<TodoWorkKind>(returnState?.kind ?? "all");
  const planActionInFlight = useRef(false);
  const planMessageRef = useRef<{ sessionId: string; command: string; clientRequestId: string } | null>(null);
  const workScrollRef = useRef<HTMLDivElement | null>(null);
  const surfaceHeadingRef = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    if (!editing) setContent(todo.content);
  }, [editing, todo.content]);

  const associatedSessionItems = sessionInventory
    .filter(({ session }) => session.source !== undefined && rootSessionSourceTodoId(session.source) === todo.id)
    .sort((left, right) => right.session.updatedAt - left.session.updatedAt);
  const associatedSessions = associatedSessionItems.map((item) => item.session);
  const discussionSessions = associatedSessions.filter((session) => session.source?.kind === "todo" && session.source.entry === "discussion");
  const latestWorkItem = associatedSessionItems.find(({ session }) => session.source.kind === "todo" && session.source.entry === "work");
  const isArchived = todo.archivedAt !== undefined;
  const attentionEligible = !isArchived && todo.status !== "rejected";
  const canExecute = !isArchived && (todo.status === "ready" || todo.status === "in_progress");
  const currentLane = isTodoLane(todo.status) ? todo.status : undefined;
  const embeddedDocumentBody = demoteEmbeddedMarkdownHeadings(todo.content);
  const sessionsAvailable = !sessionsLoading && sessionsError === null;
  const attentionAvailable = sessionsAvailable && hitlInitialized;
  const planPresent = plan.data !== undefined && plan.data !== null;
  const referencesPresent = todo.attachmentIds.length > 0;
  const destination = location.pathname.endsWith("/work") ? "work" : "todo";

  useEffect(() => {
    surfaceHeadingRef.current?.focus({ preventScroll: true });
    if (destination !== "work" || returnState === undefined) return;
    requestAnimationFrame(() => {
      if (workScrollRef.current) workScrollRef.current.scrollTop = returnState.scrollTop;
    });
  }, [destination, location.key, returnState]);

  const update = (input: ProjectTodoUpdateInput, onSuccess?: () => void) => {
    setActionError(null);
    updateTodo.mutate({ slug, todoId: todo.id, input }, {
      onSuccess,
      onError: (cause) => setActionError(messageFor(cause)),
    });
  };
  const start = (entry: "discussion" | "work" | "automation") => {
    setActionError(null);
    createSession.mutate({ slug, todoId: todo.id, input: { expectedRevision: todo.revision, entry } }, {
      onSuccess: ({ sessionId }) => navigate(`/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sessionId)}`),
      onError: (cause) => setActionError(messageFor(cause)),
    });
  };
  const openPlan = async () => {
    if (planActionInFlight.current || !sessionsAvailable) return;
    planActionInFlight.current = true;
    setPlanError(null);
    setIsOpeningPlan(true);
    try {
      await coordinateTodoPlanWork({
        todoId: todo.id,
        ...(discussionSessions[0]?.sessionId === undefined ? {} : { existingDiscussionSessionId: discussionSessions[0].sessionId }),
        createPlanDiscussion: async () => (await createSession.mutateAsync({
          slug,
          todoId: todo.id,
          input: { expectedRevision: todo.revision, entry: "discussion", initialIntent: "plan" },
        })).sessionId,
        loadExistingDiscussion: async (sessionId) => {
          try {
            const session = await queryClient.fetchQuery({ ...sessionQueryOptions(slug, sessionId), staleTime: 0 });
            return { isBusy: session.currentExecutionId !== undefined, requestedModelSelection: session.nextModelSelection.requested };
          } catch (cause) {
            if (isUnavailablePlanDiscussion(cause)) return undefined;
            throw cause;
          }
        },
        sendCommand: async (sessionId, command, requestedModelSelection) => {
          const previous = planMessageRef.current;
          const request = previous?.sessionId === sessionId && previous.command === command
            ? previous
            : { sessionId, command, clientRequestId: createClientUuid() };
          planMessageRef.current = request;
          try {
            await postMessage.mutateAsync({
              slug,
              sessionId,
              content: command,
              attachmentIds: [],
              clientRequestId: request.clientRequestId,
              requestedModelSelection,
            });
            planMessageRef.current = null;
            return "sent";
          } catch (cause) {
            if (isUnavailablePlanDiscussion(cause)) {
              planMessageRef.current = null;
              return "unavailable";
            }
            throw cause;
          }
        },
        openSession: (sessionId) => navigate(`/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sessionId)}`),
      });
    } catch (cause) {
      setPlanError(messageFor(cause));
    } finally {
      planActionInFlight.current = false;
      setIsOpeningPlan(false);
    }
  };
  const reject = () => {
    const rejectionReason = reason.trim();
    if (!rejectionReason) {
      setActionError("Rejection reason is required");
      return;
    }
    update({ expectedRevision: todo.revision, status: "rejected", rejectionReason }, () => setRejecting(false));
  };
  const normalizedFilter = workFilter.trim().toLocaleLowerCase();
  const filteredWork = associatedSessionItems.filter((item) => {
    const kind = todoWorkKindFor(item);
    if (workKind !== "all" && workKind !== kind) return false;
    if (!normalizedFilter) return true;
    const presentation = presentProjectTodoLinkedSession(item);
    return [item.session.title, item.session.cwd, presentation.context, presentation.label]
      .join(" ")
      .toLocaleLowerCase()
      .includes(normalizedFilter);
  });
  const activeWork = filteredWork.filter(isActiveTodoWork);
  const historyWork = filteredWork.filter((item) => !isActiveTodoWork(item));
  const workFiltering = normalizedFilter.length > 0 || workKind !== "all";
  const linkedRootIds = new Set(associatedSessionItems.map(({ session }) => session.sessionId));
  const todoHitl = attentionEligible ? scopedHitl.filter((entry) => linkedRootIds.has(entry.rootSessionId)) : [];
  const goalGates = attentionEligible ? associatedSessionItems.filter(({ session }) => {
    const workOrAutomation = session.source.kind === "automation"
      || (session.source.kind === "todo" && (session.source.entry === "work" || session.source.entry === "automation"));
    return workOrAutomation && (session.goal?.status === "blocked" || session.goal?.status === "budget_limited");
  }) : [];

  const openWork = (item: ProjectSessionInventoryItem) => {
    const navigateToSession = () => navigate(
      `/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(item.session.sessionId)}`,
      {
        state: createTodoWorkNavigationState({
          todoId: todo.id,
          filter: workFilter,
          kind: workKind,
          scrollTop: workScrollRef.current?.scrollTop ?? 0,
        }),
      },
    );
    const isExecution = item.session.source.kind === "todo" && item.session.source.entry === "work";
    const input = isExecution ? continueWorkUpdateInput(todo) : undefined;
    if (input) update(input, navigateToSession);
    else navigateToSession();
  };

  const continueWorkFromTodo = (item: ProjectSessionInventoryItem) => {
    const navigateToSession = () => navigate(`/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(item.session.sessionId)}`);
    const input = continueWorkUpdateInput(todo);
    if (input) update(input, navigateToSession);
    else navigateToSession();
  };

  const startOrContinueWorkFromTodo = () => {
    if (!sessionsAvailable) return;
    if (latestWorkItem) continueWorkFromTodo(latestWorkItem);
    else start("work");
  };
  const primaryWorkLabel = sessionsLoading
    ? "Loading work…"
    : sessionsError !== null
      ? "Work unavailable"
      : latestWorkItem
        ? "Continue Work"
        : "Start Work";

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-bg-base">
      <SelectedTodoShell slug={slug} todo={todo} active={destination} workCount={associatedSessionItems.length} />

      {destination === "todo" ? (
        <div className="todo-detail-scroll min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
          <div className="mx-auto w-full max-w-[820px] px-6 pb-[72px] pt-[18px] [@media(max-width:720px)]:px-3 [@media(max-width:720px)]:pb-12 [@media(max-width:720px)]:pt-1">
            <section className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-[14px] border-b border-border-subtle pb-4 [@media(max-width:720px)]:grid-cols-1" aria-label="Todo lifecycle">
              <div>
                <strong className="block text-[11.5px] font-semibold text-text-primary">Todo lifecycle</strong>
                <span className="mt-[3px] block text-[10px] text-text-tertiary">Todo state is independent from Session Execution status.</span>
              </div>
              {isArchived ? (
                <TodoActionButton onClick={() => update({ expectedRevision: todo.revision, archived: false })} disabled={updateTodo.isPending}>Restore</TodoActionButton>
              ) : todo.status === "rejected" ? (
                <TodoActionButton onClick={() => update({ expectedRevision: todo.revision, status: "idea" })} disabled={updateTodo.isPending}>Restore to Idea</TodoActionButton>
              ) : (
                <>
                  <TodoLifecycleBand status={currentLane} archived={false} pending={updateTodo.isPending} onMove={(status) => {
                    if (status !== currentLane) update({ expectedRevision: todo.revision, status });
                  }} />
                  <DropdownMenuRoot>
                    <DropdownMenuTrigger asChild>
                      <button type="button" aria-label="More Todo actions" className="inline-flex min-h-8 items-center justify-center gap-1.5 rounded-md border border-border-default bg-bg-surface px-2.5 text-[11px] font-semibold text-text-secondary transition-colors duration-[var(--motion-fast)] hover:border-border-strong hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:[box-shadow:var(--focus)] [@media(max-width:720px)]:min-h-11 [@media(max-width:720px)]:justify-self-end [@media(pointer:coarse)]:min-h-11">
                        More <ChevronDown size={12} aria-hidden="true" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-[190px]">
                      <DropdownMenuItem onSelect={() => setRejecting(true)}><XCircle size={14} className="text-warning" aria-hidden="true" /> Reject Todo…</DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => update({ expectedRevision: todo.revision, archived: true })}><Archive size={14} aria-hidden="true" /> Archive Todo</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenuRoot>
                </>
              )}
              {rejecting ? <div className="col-span-full grid grid-cols-[minmax(0,1fr)_auto] gap-2 rounded-md border border-warning/30 bg-attention-field p-2.5 [@media(max-width:720px)]:grid-cols-1"><label className="sr-only" htmlFor="todo-rejection-reason">Rejection reason</label><input id="todo-rejection-reason" autoFocus value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why should this Todo be rejected?" className="min-h-11 min-w-0 bg-transparent px-1 text-[16px] text-text-primary outline-none min-[721px]:min-h-8 min-[721px]:text-[12px]" /><div className="flex justify-end gap-1.5"><TodoActionButton onClick={() => setRejecting(false)}>Cancel</TodoActionButton><TodoActionButton variant="danger" onClick={reject}>Reject Todo</TodoActionButton></div></div> : null}
            </section>

            {!isArchived && todo.status === "rejected" ? <div className="mt-4 flex items-start gap-3 rounded-md border border-warning/30 bg-attention-field pb-3 pl-4 pr-3.5 pt-[11px] shadow-[inset_3px_0_0_var(--warning)]"><div><strong className="block text-[12px] font-semibold text-warning">Rejected</strong><span className="mt-[3px] block text-[11px] leading-[1.5] text-text-secondary">{todo.rejectionReason ?? "Returned for reconsideration."}</span></div></div> : null}
            {actionError ? <p role="alert" className="mt-3 text-[11px] leading-4 text-error">{actionError}</p> : null}

            <div className="min-w-0" role="region" aria-label="Todo content">
              <h2 ref={surfaceHeadingRef} tabIndex={-1} className="sr-only">Todo</h2>
            <section aria-labelledby="todo-content-heading">
              <header className="flex items-start justify-between gap-4 pb-3 pt-6 [@media(max-width:720px)]:flex-col [@media(max-width:720px)]:gap-[11px] [@media(max-width:720px)]:pt-5">
                <div>
                  <h2 id="todo-content-heading" className="text-[11px] font-semibold uppercase tracking-[0.05em] text-text-secondary">Todo content</h2>
                  <div className="mt-1.5 text-[11px] text-text-tertiary">Updated <TodoUpdatedTime timestamp={todo.updatedAt} /></div>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-1.5 [@media(max-width:720px)]:w-full [@media(max-width:720px)]:justify-start">
                  {canExecute ? <TodoActionButton variant="primary" onClick={startOrContinueWorkFromTodo} disabled={!sessionsAvailable || createSession.isPending || updateTodo.isPending}>{primaryWorkLabel}</TodoActionButton> : null}
                  {!isArchived ? <TodoActionButton variant="quiet" onClick={() => start("discussion")} disabled={createSession.isPending}><MessageSquare size={12} aria-hidden="true" />Discuss</TodoActionButton> : null}
                  {!editing ? <TodoActionButton compactOnMobile onClick={() => setEditing(true)}>Edit</TodoActionButton> : null}
                </div>
              </header>
              {editing ? (
                <div className="mt-3 space-y-3">
                  <textarea autoFocus aria-label="Todo content" rows={14} value={content} onChange={(event) => setContent(event.target.value)} className="w-full resize-y rounded-sm border border-border-control bg-bg-base px-3 py-3 font-mono text-[12px] leading-5 text-text-primary outline-none focus:border-brand focus:ring-2 focus:ring-brand-subtle" />
                  <div className="flex gap-2">
                    <TodoActionButton variant="primary" disabled={updateTodo.isPending || content.trim().length === 0} onClick={() => update({ expectedRevision: todo.revision, content: content.trim() }, () => setEditing(false))}><Save size={12} />Save</TodoActionButton>
                    <TodoActionButton onClick={() => { setContent(todo.content); setEditing(false); }}>Cancel</TodoActionButton>
                  </div>
                </div>
              ) : <MarkdownContent variant="document">{embeddedDocumentBody}</MarkdownContent>}
            </section>

            <TodoReferences
              slug={slug}
              todo={todo}
              compactWhenEmpty={!referencesPresent}
              starterAction={!planPresent && !isArchived ? <TodoActionButton onClick={() => void openPlan()} disabled={isOpeningPlan || !sessionsAvailable}>{isOpeningPlan ? <LoaderCircle className="animate-activity" size={12} /> : null}{isOpeningPlan ? "Opening…" : "Generate Plan"}</TodoActionButton> : undefined}
            />

            {referencesPresent && !planPresent && !plan.isLoading && !plan.error ? <TodoContextStarter onOpenPlan={() => void openPlan()} disabled={isOpeningPlan || !sessionsAvailable || isArchived} loading={isOpeningPlan} /> : null}
            {planPresent ? <section aria-labelledby="todo-plan-heading" className="border-t border-border-subtle">
              <header className="flex flex-wrap items-start justify-between gap-3 pb-3 pt-[22px] [@media(max-width:720px)]:block [@media(max-width:720px)]:p-3.5">
                <div><h2 id="todo-plan-heading" className="text-[11px] font-semibold uppercase tracking-[0.05em] text-text-secondary">Plan</h2><div className="mt-1.5 flex flex-wrap items-center gap-[7px] text-[11px] text-text-tertiary"><span>Ordinary Markdown</span><span>{plan.data?.path ?? `.archcode/plans/${todo.id}.md`}</span></div></div>
                {!isArchived ? <TodoActionButton onClick={() => void openPlan()} disabled={isOpeningPlan || !sessionsAvailable}>{isOpeningPlan ? <LoaderCircle className="animate-activity" size={12} /> : null}{isOpeningPlan ? "Opening…" : "Improve"}</TodoActionButton> : null}
              </header>
              {planError ? <p role="alert" className="mt-3 text-[11px] text-error">{planError}</p> : null}
              {plan.data && plan.data.markdown.trim().length === 0 ? <p className="mt-4 text-[12px] text-text-tertiary">Plan file exists but is empty. Continue the Discussion to fill it in.</p> : null}
              {plan.data && plan.data.markdown.trim().length > 0 ? <div className="max-w-[820px]"><MarkdownContent variant="document">{demoteEmbeddedMarkdownHeadings(plan.data.markdown)}</MarkdownContent></div> : null}
            </section> : null}
            {plan.isLoading ? <p className="border-t border-border-subtle py-4 text-[11px] text-text-tertiary">Loading Plan…</p> : null}
            {plan.error ? <p role="alert" className="border-t border-border-subtle py-4 text-[11px] text-error">Could not load Plan: {messageFor(plan.error)}</p> : null}
            {planError && !planPresent ? <p role="alert" className="border-t border-border-subtle py-4 text-[11px] text-error">{planError}</p> : null}

            {selectedResultSession ? <TodoResult slug={slug} sessionId={selectedResultSession.sessionId} done={todo.status === "done"} /> : null}
            </div>
          </div>
        </div>
      ) : (
        <div ref={workScrollRef} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
          <div className="mx-auto w-[min(920px,calc(100%_-_48px))] pb-[72px] pt-[34px] [@media(max-width:720px)]:w-full [@media(max-width:720px)]:px-3 [@media(max-width:720px)]:pb-12 [@media(max-width:720px)]:pt-[22px]">
            <header className="flex items-start justify-between gap-6 border-b border-border-subtle pb-5 [@media(max-width:720px)]:block">
              <div>
                <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-text-tertiary">Linked work</span>
                <h2 ref={surfaceHeadingRef} tabIndex={-1} className="mt-[5px] text-[23px] font-bold leading-[1.2] tracking-[-0.025em] text-text-primary focus:outline-none">Work for this Todo</h2>
                <p className="mt-[7px] max-w-[610px] text-[12.5px] leading-[1.55] text-text-tertiary">Discussions shape the intent. Work Sessions implement it. Each row opens its own durable Session and checkout context.</p>
              </div>
              {sessionsAvailable && !isArchived ? <div className="flex flex-wrap justify-end gap-[7px] [@media(max-width:720px)]:mt-4 [@media(max-width:720px)]:justify-start">
                <TodoActionButton onClick={() => start("discussion")} disabled={createSession.isPending}>New discussion</TodoActionButton>
                {(todo.status === "ready" || todo.status === "in_progress") ? <>
                  <TodoActionButton onClick={() => start("automation")} disabled={createSession.isPending}>Create automation</TodoActionButton>
                  <TodoActionButton variant="primary" onClick={() => start("work")} disabled={createSession.isPending}>New work session</TodoActionButton>
                </> : null}
              </div> : null}
            </header>

            {attentionEligible && !hitlInitialized && sessionsError === null ? <p role="status" className="mt-[19px] text-[11px] text-text-tertiary">Loading requests that need you…</p> : null}
            {attentionAvailable && (todoHitl.length > 0 || goalGates.length > 0) ? <TodoAttentionSection
              slug={slug}
              todo={todo}
              hitl={todoHitl}
              goalGates={goalGates}
              returnState={{
                todoId: todo.id,
                filter: workFilter,
                kind: workKind,
                scrollTop: workScrollRef.current?.scrollTop ?? 0,
              }}
            /> : null}

            <div className="grid grid-cols-[minmax(180px,1fr)_auto] items-center gap-[14px] pb-[9px] pt-4 [@media(max-width:720px)]:grid-cols-1">
              <label className="grid h-[38px] max-w-[360px] grid-cols-[15px_minmax(0,1fr)] items-center gap-2 rounded-md border border-border-subtle bg-bg-surface px-2.5 text-text-tertiary transition-[border-color,background-color,box-shadow] duration-[var(--motion-fast)] focus-within:border-brand focus-within:bg-bg-elevated focus-within:[box-shadow:var(--focus)] [@media(max-width:720px)]:h-11 [@media(max-width:720px)]:max-w-none">
                <Search size={15} aria-hidden="true" />
                <input type="search" value={workFilter} onChange={(event) => setWorkFilter(event.target.value)} placeholder="Filter work…" aria-label="Filter work" className="min-w-0 border-0 bg-transparent text-[12px] text-text-primary outline-none placeholder:text-text-tertiary [@media(max-width:720px)]:text-[16px]" />
              </label>
              <div className="flex gap-0.5 overflow-x-auto rounded-md border border-border-subtle bg-bg-surface p-0.5" role="group" aria-label="Work type filter">
                {WORK_KIND_OPTIONS.map(({ value, label }) => <button key={value} type="button" aria-pressed={workKind === value} onClick={() => setWorkKind(value)} className={`h-[27px] min-w-max rounded-sm px-[9px] text-[10.5px] transition-colors duration-[var(--motion-fast)] focus-visible:outline-none focus-visible:[box-shadow:var(--focus)] [@media(max-width:720px)]:min-h-[38px] [@media(max-width:720px)]:flex-1 ${workKind === value ? "bg-bg-active text-text-primary" : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"}`}>{label}</button>)}
              </div>
            </div>

            {sessionsLoading ? <p className="mt-5 text-[12px] text-text-tertiary">Loading linked work…</p> : null}
            {sessionsError !== null ? <p role="alert" className="mt-5 text-[12px] text-error">Could not load linked work: {messageFor(sessionsError)}</p> : null}
            {actionError ? <p role="alert" className="mt-3 text-[11px] leading-4 text-error">{actionError}</p> : null}
            {sessionsAvailable && activeWork.length > 0 ? <TodoWorkSection id="active-todo-work" label="Active" items={activeWork} onOpen={openWork} /> : null}
            {sessionsAvailable && historyWork.length > 0 ? <TodoWorkSection id="history-todo-work" label="History" items={historyWork} onOpen={openWork} /> : null}
            {sessionsAvailable && filteredWork.length === 0 ? <div className="mt-[19px] flex min-h-12 items-center justify-between gap-3 border-y border-border-subtle px-2 py-2 text-[11.5px] text-text-tertiary"><span>{workFiltering ? "No linked work matches these filters." : "No linked work yet."}</span>{workFiltering ? <button type="button" className="min-h-8 rounded-sm px-2.5 font-semibold text-text-secondary hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:[box-shadow:var(--focus)] [@media(pointer:coarse)]:min-h-11" onClick={() => { setWorkFilter(""); setWorkKind("all"); }}>Clear filters</button> : null}</div> : null}
          </div>
        </div>
      )}
    </div>
  );
}

function TodoResult({ slug, sessionId, done }: { slug: string; sessionId: string; done: boolean }) {
  const resultSession = useSession(slug, sessionId);
  const resultParts = resultSession.data === undefined ? [] : extractProjectTodoResultParts(resultSession.data);
  if (resultParts.length === 0) return null;
  return <section aria-labelledby="todo-result-heading" className="border-t border-border-subtle py-5" data-testid="todo-result">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 id="todo-result-heading" className="text-[11px] font-semibold uppercase tracking-[0.05em] text-text-secondary">{done ? "Accepted outcome" : "Result for review"}</h2><p className="mt-1 text-[11px] text-text-tertiary">Trusted final answer from the latest completed Work Session.</p></div><Link to={`/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sessionId)}`} className="text-[12px] font-semibold text-brand hover:underline">Open Session</Link></div>
    <div className="mt-4 max-w-[820px]">{resultParts.map((part, index) => <div key={index} data-testid="todo-result-part"><MarkdownContent>{part}</MarkdownContent></div>)}</div>
  </section>;
}

function TodoUpdatedTime({ timestamp }: { timestamp: number }) {
  const relative = useRelativeTime(timestamp, "full");
  const text = relative === "just now" || /^\d+s ago$/.test(relative) ? "now" : relative;
  return <RelativeTimeValue timestamp={timestamp} text={text} />;
}

function TodoLifecycleBand({ status, archived, pending, onMove }: {
  status?: ProjectTodoLane;
  archived: boolean;
  pending: boolean;
  onMove: (status: ProjectTodoLane) => void;
}) {
  const currentIndex = status === undefined ? -1 : LANES.indexOf(status);
  return <div role="group" aria-label="Todo lifecycle" className="relative inline-flex items-stretch gap-0.5 overflow-x-auto rounded-md border border-border-default bg-bg-surface p-0.5 [@media(max-width:720px)]:w-full">
    {LANES.map((lane, index) => {
      const { Icon } = PROJECT_TODO_LANE_PRESENTATIONS[lane];
      const label = todoLifecycleLabel(lane);
      const current = lane === status;
      const tone = current
        ? lane === "idea"
          ? "border-border-default bg-bg-active text-text-primary"
          : lane === "in_progress"
            ? "border-border-default bg-bg-active text-text-primary"
            : lane === "done"
              ? "border-success/25 bg-success-field text-success"
              : "border-brand/25 bg-brand-field text-brand"
        : index < currentIndex
          ? "text-text-secondary"
          : "text-text-tertiary hover:bg-[color:color-mix(in_srgb,var(--bg-hover)_70%,transparent)] hover:text-text-secondary";
      return <button key={lane} type="button" aria-pressed={current} aria-label={current ? `Current Todo status: ${label}` : `Move Todo to ${label}`} disabled={archived || pending} onClick={() => { if (!current) onMove(lane); }} className={`inline-flex min-h-[31px] min-w-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-[5px] border border-transparent px-[9px] text-[10.5px] font-semibold tracking-[-0.01em] transition-[background-color,border-color,color] duration-[var(--motion-fast)] focus-visible:z-10 focus-visible:outline-none focus-visible:[box-shadow:var(--focus)] disabled:cursor-not-allowed disabled:opacity-45 [@media(max-width:720px)]:min-h-11 [@media(max-width:720px)]:flex-1 ${tone}`}><Icon size={12} strokeWidth={1.7} aria-hidden="true" /><span>{label}</span></button>;
    })}
  </div>;
}

function todoLifecycleLabel(lane: ProjectTodoLane): string {
  if (lane === "idea") return "Idea";
  if (lane === "in_progress") return "In progress";
  return PROJECT_TODO_LANE_PRESENTATIONS[lane].title;
}

function RouteMessage({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "error" }) {
  return <div className={`flex h-full items-center justify-center text-sm ${tone === "error" ? "text-error" : "text-text-tertiary"}`}>{children}</div>;
}
function TodoContextStarter({ onOpenPlan, disabled, loading }: { onOpenPlan: () => void; disabled: boolean; loading: boolean }) {
  return <section className="flex flex-wrap items-center justify-between gap-[18px] border-t border-border-subtle py-4" aria-labelledby="todo-context-starter-plan-heading"><div><h2 id="todo-context-starter-plan-heading" className="text-[12px] font-semibold text-text-primary">Add context when it helps</h2><p className="mt-1 text-[11px] text-text-tertiary">Shape a Plan only when this work needs more structure.</p></div><TodoActionButton onClick={onOpenPlan} disabled={disabled}>{loading ? <LoaderCircle className="animate-activity" size={12} /> : null}{loading ? "Opening…" : "Generate Plan"}</TodoActionButton></section>;
}
function TodoAttentionSection({ slug, todo, hitl, goalGates, returnState }: {
  slug: string;
  todo: ProjectTodo;
  hitl: readonly ScopedHitlView[];
  goalGates: readonly ProjectSessionInventoryItem[];
  returnState: TodoWorkReturnState;
}) {
  const count = hitl.length + goalGates.length;
  const navigationState = createTodoWorkNavigationState(returnState);
  return <section className="mt-[19px]" aria-labelledby="todo-work-needs-you-heading">
    <header className="flex h-7 items-center justify-between text-[9px] font-bold uppercase tracking-[0.08em] text-warning"><h3 id="todo-work-needs-you-heading" className="font-[inherit]">Needs you</h3><b className="font-mono font-normal leading-none">{count}</b></header>
    <div className="rounded-lg border border-warning/30 bg-attention-field shadow-[inset_2px_0_0_var(--warning)]">
      {hitl.map((entry) => <TodoAttentionRow
        key={scopedHitlIdentity(entry)}
        to={hitlAttentionPath(entry)}
        state={navigationState}
        agentName={entry.ownerAgentName}
        sessionTitle={entry.ownerSessionTitle}
        title={entry.view.displayPayload.title}
        mechanism={entry.view.requiresInspection === true ? "Inspection" : entry.view.source.type === "tool_permission" ? "Permission" : "Question"}
      />)}
      {goalGates.map(({ session }) => <TodoAttentionRow
        key={`goal:${session.sessionId}:${session.goal?.instanceId ?? "current"}`}
        to={`/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(session.sessionId)}`}
        state={navigationState}
        agentName={session.agentName}
        sessionTitle={session.title}
        title={session.goal?.status === "budget_limited" ? "Goal budget limit reached" : "Goal is blocked"}
        mechanism="Goal"
      />)}
    </div>
    <p className="sr-only">{count} {count === 1 ? "action" : "actions"} need you for {projectTodoDisplayLead(todo.content)}.</p>
  </section>;
}

function TodoAttentionRow({ to, state, agentName, sessionTitle, title, mechanism }: {
  to: string;
  state: TodoWorkNavigationState;
  agentName: string;
  sessionTitle: string | null;
  title: string;
  mechanism: "Inspection" | "Permission" | "Question" | "Goal";
}) {
  const agentLabel = presentAgentName(agentName);
  return <Link to={to} state={state} className="grid min-h-[58px] grid-cols-[29px_minmax(0,1fr)_auto_14px] items-center gap-[10px] border-b border-warning/20 px-3 py-2 text-left text-text-secondary last:border-b-0 hover:bg-warning-muted hover:text-text-primary focus-visible:outline-none focus-visible:[box-shadow:inset_2px_0_0_var(--warning)] [@media(max-width:720px)]:min-h-[66px]">
    <span className="grid h-[28px] w-[28px] place-items-center rounded-[7px] border border-warning/35 bg-warning-muted font-mono text-[9px] font-bold uppercase text-warning" aria-hidden="true">{agentInitials(agentLabel)}</span>
    <span className="min-w-0"><strong className="block truncate text-[12px] font-semibold text-text-primary">{title}</strong><small className="mt-[3px] block truncate text-[10.5px] text-text-tertiary">{agentLabel}<span aria-hidden="true"> · </span>{sessionTitle || "Untitled Session"}</small></span>
    <span className="rounded-[5px] bg-bg-active px-2 py-1 text-[10px] font-semibold text-warning">{mechanism}</span>
    <ChevronRight size={13} className="text-text-tertiary" aria-hidden="true" />
  </Link>;
}

function presentAgentName(agentName: string): string {
  return agentName.length === 0 ? "Agent" : `${agentName[0]!.toUpperCase()}${agentName.slice(1)}`;
}

function agentInitials(agentLabel: string): string {
  const parts = agentLabel.split(/\s+/u).filter(Boolean);
  return (parts.length > 1 ? parts.map((part) => part[0]).join("") : agentLabel.slice(0, 2)).slice(0, 2).toUpperCase();
}
function TodoWorkSection({ id, label, items, onOpen }: { id: string; label: string; items: ProjectSessionInventoryItem[]; onOpen: (item: ProjectSessionInventoryItem) => void }) {
  return <section className="mt-[19px]" aria-labelledby={id}>
    <header className="flex h-7 items-center justify-between text-[9px] font-bold uppercase tracking-[0.08em] text-text-tertiary"><h3 id={id} className="font-[inherit]">{label}</h3><b className="font-mono font-normal leading-none">{items.length}</b></header>
    <div className="border-t border-border-subtle">{items.map((item) => <TodoWorkRow key={item.session.sessionId} item={item} onOpen={() => onOpen(item)} />)}</div>
  </section>;
}

function TodoWorkRow({ item, onOpen }: { item: ProjectSessionInventoryItem; onOpen: () => void }) {
  const { session } = item;
  const presentation = presentProjectTodoLinkedSession(item);
  const type = todoWorkKindFor(item);
  const title = session.title || session.sessionId;
  const TypeIcon = type === "discussion" ? MessageSquare : type === "automation" ? Repeat2 : Search;
  const live = presentation.kind === "running";
  const iconTone = live ? "border-signal/30 bg-signal-field text-signal-foreground" : "border-border-subtle bg-bg-active text-text-secondary";
  const typeLabel = type === "discussion" ? "Discussion" : type === "automation" ? "Automation Session" : "Work Session";
  return <button type="button" onClick={onOpen} aria-label={`${title}, ${typeLabel}, ${presentation.label}`} className="grid min-h-[68px] w-full grid-cols-[30px_minmax(0,1fr)_auto_14px] items-center gap-[11px] border-b border-border-subtle bg-transparent px-2 py-[9px] text-left text-text-primary transition-colors duration-[var(--motion-fast)] hover:bg-bg-hover focus-visible:outline-none focus-visible:[box-shadow:inset_2px_0_0_var(--brand)] [@media(max-width:720px)]:min-h-[76px] [@media(max-width:720px)]:grid-cols-[30px_minmax(0,1fr)_14px]">
    <span className={`grid h-[29px] w-[29px] place-items-center rounded-md border ${iconTone}`}>{live ? <LoaderCircle size={14} className="animate-activity" aria-hidden="true" /> : <TypeIcon size={14} aria-hidden="true" />}</span>
    <span className="min-w-0"><strong className="block truncate text-[12px] font-semibold">{title}</strong><small className="mt-1 block truncate text-[10px] text-text-tertiary"><span>{typeLabel}</span><span aria-hidden="true"> · </span><span>{session.cwd}</span></small></span>
    <span className="text-right [@media(max-width:720px)]:col-start-2 [@media(max-width:720px)]:row-start-2 [@media(max-width:720px)]:justify-self-start [@media(max-width:720px)]:text-left"><span className={`inline-flex min-h-[23px] items-center rounded-[5px] border border-transparent bg-bg-active px-2 text-[10.5px] font-semibold ${linkedStateTone(presentation.kind)}`}>{presentation.label}</span><small className="mt-[5px] block font-mono text-[9px] leading-none text-text-tertiary [@media(max-width:720px)]:hidden"><TodoUpdatedTime timestamp={session.updatedAt} /></small></span>
    <ChevronRight size={13} className="text-text-tertiary [@media(max-width:720px)]:col-start-3 [@media(max-width:720px)]:row-span-2 [@media(max-width:720px)]:row-start-1" aria-hidden="true" />
  </button>;
}

function linkedStateTone(kind: ReturnType<typeof presentProjectTodoLinkedSession>["kind"]): string {
  return kind === "running" ? "text-signal-foreground"
    : kind === "needs_you" || kind === "paused" ? "text-warning"
      : kind === "completed" ? "text-text-tertiary"
        : kind === "failed" ? "text-error" : "text-text-tertiary";
}
function TodoActionButton({ children, onClick, disabled, variant = "default", compactOnMobile = false }: { children: ReactNode; onClick: () => void; disabled?: boolean; variant?: "default" | "primary" | "quiet" | "danger"; compactOnMobile?: boolean }) {
  const tone = variant === "primary"
    ? "border-brand bg-brand text-brand-ink shadow-[0_1px_3px_rgb(97_87_213_/_30%),inset_0_1px_0_rgb(255_255_255_/_10%)] hover:border-brand-hover hover:bg-brand-hover hover:-translate-y-px hover:shadow-[0_3px_8px_rgb(97_87_213_/_30%),inset_0_1px_0_rgb(255_255_255_/_18%)] active:translate-y-0 active:scale-[0.98]"
    : variant === "quiet"
      ? "border-transparent bg-transparent px-2.5 text-text-tertiary hover:bg-bg-hover hover:text-text-primary"
      : variant === "danger"
        ? "border-error/30 bg-error-muted text-error hover:bg-error/15"
        : "border-border-default bg-bg-elevated text-text-secondary hover:border-border-strong hover:bg-bg-hover hover:text-text-primary";
  const geometry = variant === "quiet" ? "border-0 px-2.5" : `border px-[13px] ${variant === "primary" ? "min-h-[34px]" : ""}`;
  const mobileGeometry = compactOnMobile ? "[@media(max-width:720px)]:min-h-8" : "[@media(max-width:720px)]:min-h-11 [@media(pointer:coarse)]:min-h-11";
  return <button type="button" onClick={onClick} disabled={disabled} className={`inline-flex min-h-8 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-sm text-[12px] font-semibold tracking-[-0.01em] transition-[background-color,border-color,color,box-shadow,transform] duration-[var(--motion-fast)] focus-visible:outline-none focus-visible:[box-shadow:var(--focus)] disabled:cursor-not-allowed disabled:opacity-45 ${mobileGeometry} ${geometry} ${tone}`}>{children}</button>;
}
function todoWorkKindFor(item: ProjectSessionInventoryItem): Exclude<TodoWorkKind, "all"> {
  const source = item.session.source;
  if (source.kind === "automation" || (source.kind === "todo" && source.entry === "automation")) return "automation";
  if (source.kind === "todo" && source.entry === "discussion") return "discussion";
  return "session";
}
function isActiveTodoWork(item: ProjectSessionInventoryItem): boolean {
  return item.latestExecution?.status === "running" || item.latestExecution?.status === "suspended";
}
function isTodoWorkKind(value: unknown): value is TodoWorkKind {
  return value === "all" || value === "discussion" || value === "session" || value === "automation";
}
function isTodoLane(status: ProjectTodo["status"]): status is ProjectTodoLane { return status !== "rejected"; }
function messageFor(cause: unknown): string { return cause instanceof Error ? cause.message : "Action failed"; }
