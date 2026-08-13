import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  rootSessionSourceTodoId,
  isSessionMessageUnavailableCode,
  type RequestedModelSelection,
} from "@archcode/protocol";
import { CircleCheck, LoaderCircle, Save } from "lucide-react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { ApiError } from "../api/client";
import { useCreateProjectTodoSession, usePostMessage, useUpdateProjectTodo } from "../api/mutations";
import { sessionQueryOptions, useAutomationInventory, useProjectTodoPlan, useProjectTodos, useSession, useSessionInventory } from "../api/queries";
import type { Automation, ProjectSessionInventoryItem, ProjectTodo, ProjectTodoUpdateInput } from "../api/types";
import { MarkdownContent } from "../components/primitives/MarkdownContent";
import { StatusGlyph } from "../components/primitives/StatusGlyph";
import { RelativeTimeValue, useRelativeTime } from "../components/primitives/TemporalText";
import { TodoReferences } from "../components/features/TodoReferences";
import { formatAutomationTrigger } from "../lib/automation-trigger-presentation";
import { createClientUuid } from "../lib/client-uuid";
import { demoteEmbeddedMarkdownHeadings, presentProjectTodoLinkedSession, PROJECT_TODO_LANE_PRESENTATIONS, type ProjectTodoLane } from "./project-todo-presentation";
import { extractProjectTodoResultParts, selectProjectTodoResultSession } from "./project-todo-result";

const LANES: readonly ProjectTodoLane[] = ["idea", "ready", "in_progress", "done"];
export const TODO_PLAN_ACTION_LABEL = "Generate / Improve Plan";

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
  const automationInventory = useAutomationInventory(slug);
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
      automations={(automationInventory.data ?? []).map((item) => item.automation)}
      automationsLoading={automationInventory.isLoading}
      automationsError={automationInventory.error}
      onBack={backToTodos}
    />
  );
}

function TodoDetailView({ todo, slug, sessionInventory, sessionsLoading, sessionsError, automations, automationsLoading, automationsError, onBack }: {
  todo: ProjectTodo;
  slug: string;
  sessionInventory: ProjectSessionInventoryItem[];
  sessionsLoading: boolean;
  sessionsError: unknown;
  automations: Automation[];
  automationsLoading: boolean;
  automationsError: unknown;
  onBack: () => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const createSession = useCreateProjectTodoSession();
  const updateTodo = useUpdateProjectTodo();
  const postMessage = usePostMessage();
  const plan = useProjectTodoPlan(slug, todo.id);
  const selectedResultSession = selectProjectTodoResultSession(sessionInventory, todo.id);
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(todo.content);
  const [reason, setReason] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [isOpeningPlan, setIsOpeningPlan] = useState(false);
  const planActionInFlight = useRef(false);
  const planMessageRef = useRef<{ sessionId: string; command: string; clientRequestId: string } | null>(null);
  useEffect(() => {
    if (!editing) setContent(todo.content);
  }, [editing, todo.content]);

  const associatedSessionItems = sessionInventory
    .filter(({ session }) => session.source !== undefined && rootSessionSourceTodoId(session.source) === todo.id)
    .sort((left, right) => right.session.updatedAt - left.session.updatedAt);
  const associatedSessions = associatedSessionItems.map((item) => item.session);
  const discussionSessions = associatedSessions.filter((session) => session.source?.kind === "todo" && session.source.entry === "discussion");
  const workSessions = associatedSessions.filter((session) => session.source?.kind === "todo" && session.source.entry === "work");
  const associatedAutomations = automations
    .filter((automation) => automation.origin.kind === "todo" && automation.origin.todoId === todo.id)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  const isArchived = todo.archivedAt !== undefined;
  const currentLane = isTodoLane(todo.status) ? todo.status : undefined;
  const embeddedDocumentBody = demoteEmbeddedMarkdownHeadings(todo.content);
  const sessionsAvailable = !sessionsLoading && sessionsError === null;
  const planPresent = plan.data !== undefined && plan.data !== null;
  const referencesPresent = todo.attachmentIds.length > 0;

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
  const continueWork = () => {
    const sessionId = workSessions[0]?.sessionId;
    if (!sessionId) return;
    const navigateToSession = () => navigate(`/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sessionId)}`);
    const input = continueWorkUpdateInput(todo);
    if (input) update(input, navigateToSession);
    else navigateToSession();
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-bg-base">
      <header className="shrink-0 border-b border-border-default bg-bg-surface px-6 pb-0 pt-2.5 max-[761px]:px-3.5 max-[761px]:pt-2">
        <div className="flex min-h-9 items-center gap-3">
          <button type="button" onClick={onBack} aria-label="Back to Todos list" className="inline-flex min-h-8 items-center rounded-[6px] py-0 pl-0.5 pr-2 text-[12px] font-[640] tracking-[-0.01em] text-text-secondary transition-[background-color,color] duration-[var(--motion-hover)] hover:bg-[color:color-mix(in_srgb,var(--brand-field)_45%,transparent)] hover:text-brand focus-visible:outline-none focus-visible:[box-shadow:var(--focus)] [@media(pointer:coarse)]:min-h-11">Todos</button>
          <div className="flex min-w-0 flex-1 items-baseline gap-2 overflow-hidden whitespace-nowrap text-[11px] text-text-tertiary" data-testid="todo-detail-meta"><span className="shrink-0">Updated <TodoUpdatedTime timestamp={todo.updatedAt} /></span><span aria-hidden="true">·</span><span className="truncate font-mono" title={todo.id}>{todo.id}</span></div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 py-3 pb-3.5 max-[761px]:grid max-[761px]:grid-cols-[minmax(0,1fr)] max-[761px]:justify-normal max-[761px]:gap-2.5">
          <TodoLifecycleBand status={currentLane} archived={isArchived} pending={updateTodo.isPending} onMove={(status) => {
            if (status !== currentLane) update({ expectedRevision: todo.revision, status });
          }} />
          <span className="whitespace-nowrap text-[11.5px] font-[520] text-text-tertiary max-[761px]:hidden">{currentLane ? lifecycleHint(currentLane) : isArchived ? "Archived · restore before changing status" : "Rejected · returned for reconsideration"}</span>
        </div>
        {!isArchived && todo.status === "rejected" ? <div className="mt-3 flex items-start gap-3 rounded-md border border-[color:color-mix(in_srgb,var(--warning)_34%,var(--border-default))] bg-attention-field pb-3 pl-4 pr-3.5 pt-[11px] shadow-[inset_3px_0_0_var(--warning)]"><div><strong className="block text-[12px] font-[640] text-warning">Rejected</strong><span className="mt-[3px] block text-[11px] leading-[1.5] text-text-secondary">{todo.rejectionReason ?? "Returned for reconsideration."}</span></div></div> : null}
        <h1 className="sr-only">Todo detail</h1>
      </header>
      <div className="todo-detail-scroll min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        <div className="mx-auto grid w-full max-w-[1280px] gap-7 px-6 pb-12 pt-[18px] min-[1041px]:grid-cols-[minmax(0,1fr)_280px] max-[761px]:gap-6 max-[761px]:px-3">
          <div className="min-w-0 border-y border-border-subtle" role="region" aria-label="Todo document">
            <section aria-labelledby="todo-brief-heading">
              <header className="flex items-start justify-between gap-4 pb-3 pt-[22px] max-[761px]:block max-[761px]:p-3.5">
                <div>
                  <h2 id="todo-brief-heading" className="text-[11px] font-[680] uppercase tracking-[0.05em] text-text-secondary">Brief / PRD</h2>
                  <div className="mt-1.5 flex flex-wrap items-center gap-[7px] text-[11px] text-text-tertiary"><span>Markdown</span><span>Saved with this Todo</span><TodoUpdatedTime timestamp={todo.updatedAt} /></div>
                </div>
                {!editing ? <div className="max-[761px]:mt-3"><TodoActionButton compactOnMobile onClick={() => setEditing(true)}>Edit</TodoActionButton></div> : null}
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
              <header className="flex flex-wrap items-start justify-between gap-3 pb-3 pt-[22px] max-[761px]:block max-[761px]:p-3.5">
                <div><h2 id="todo-plan-heading" className="text-[11px] font-[680] uppercase tracking-[0.05em] text-text-secondary">Plan</h2><div className="mt-1.5 flex flex-wrap items-center gap-[7px] text-[11px] text-text-tertiary"><span>Ordinary Markdown</span><span>{plan.data?.path ?? `.archcode/plans/${todo.id}.md`}</span></div></div>
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

          <aside className="min-w-0 border-t border-border-subtle pt-6 min-[1041px]:border-l min-[1041px]:border-t-0 min-[1041px]:pl-[26px] min-[1041px]:pt-0 max-[761px]:pt-5" aria-label="Todo work and lifecycle">
            <section aria-labelledby="todo-work-heading"><h2 id="todo-work-heading" className="text-[11px] font-[680] uppercase tracking-[0.05em] text-text-secondary">Work</h2><p className="mt-2 text-[12px] leading-[1.5] text-text-tertiary">Shape the intent or continue execution without leaving this Todo&apos;s context.</p><div>
              {sessionsLoading ? <p className="text-[12px] text-text-tertiary">Loading linked work…</p> : null}
              {sessionsError !== null ? <p className="text-[12px] text-text-tertiary">Linked work is unavailable because Sessions could not load.</p> : null}
              {sessionsAvailable && !isArchived ? <ActionGroup label="Discuss & Plan">
                {discussionSessions[0] ? <TodoActionButton onClick={() => navigate(`/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(discussionSessions[0]!.sessionId)}`)}>Continue Discussion</TodoActionButton> : null}
                <TodoActionButton variant={discussionSessions[0] ? "quiet" : "default"} onClick={() => start("discussion")} disabled={createSession.isPending}>New Discussion</TodoActionButton>
              </ActionGroup> : null}
              {sessionsAvailable && !isArchived && (todo.status === "ready" || todo.status === "in_progress") ? <ActionGroup label="Execution" separated>
                {workSessions[0] ? <><TodoActionButton variant="primary" onClick={continueWork} disabled={updateTodo.isPending}>Continue Work</TodoActionButton><TodoActionButton onClick={() => start("work")} disabled={createSession.isPending}>New Work Session</TodoActionButton></> : <TodoActionButton variant="primary" onClick={() => start("work")} disabled={createSession.isPending}>Start Work</TodoActionButton>}
                <TodoActionButton variant="quiet" onClick={() => start("automation")} disabled={createSession.isPending}>Create Automation</TodoActionButton>
              </ActionGroup> : null}
              {actionError ? <p role="alert" className="text-[11px] leading-4 text-error">{actionError}</p> : null}
            </div></section>

            {associatedSessions.length > 0 || sessionsLoading || sessionsError !== null ? <section className="mt-[26px] border-t border-border-subtle pt-6" aria-labelledby="todo-sessions-heading"><h2 id="todo-sessions-heading" className="text-[11px] font-[680] uppercase tracking-[0.05em] text-text-secondary">Sessions</h2><p className="mt-2 text-[12px] leading-[1.5] text-text-tertiary">Discussion and execution history stays attached to this Todo.</p><div className="mt-[13px]">
              {sessionsLoading ? <p className="text-[12px] text-text-tertiary">Loading sessions…</p> : null}
              {sessionsError !== null ? <p role="alert" className="text-[12px] text-error">Could not load sessions: {messageFor(sessionsError)}</p> : null}
              {sessionsAvailable ? <AssociatedSessions slug={slug} items={associatedSessionItems} /> : null}
            </div></section> : null}
            {associatedAutomations.length > 0 || automationsLoading || automationsError !== null ? <section className="mt-[26px] border-t border-border-subtle pt-6" aria-labelledby="todo-automations-heading"><h2 id="todo-automations-heading" className="text-[11px] font-[680] uppercase tracking-[0.05em] text-text-secondary">Automations</h2><p className="mt-2 text-[12px] leading-[1.5] text-text-tertiary">Recurring work is managed separately and remains traceable here.</p><div className="mt-[13px]">
              {automationsLoading ? <p className="text-[12px] text-text-tertiary">Loading automations…</p> : null}
              {automationsError !== null ? <p role="alert" className="text-[12px] text-error">Could not load automations: {messageFor(automationsError)}</p> : null}
              {!automationsLoading && automationsError === null ? <div className="border-t border-border-subtle">{associatedAutomations.map((automation) => <LinkedAutomationRow key={automation.id} slug={slug} automation={automation} />)}</div> : null}
            </div></section> : null}
            <section className="mt-[26px] border-t border-border-subtle pt-6" aria-labelledby="todo-lifecycle-heading"><h2 id="todo-lifecycle-heading" className="text-[11px] font-[680] uppercase tracking-[0.05em] text-text-secondary">Lifecycle</h2><p className="mt-2 text-[12px] leading-[1.5] text-text-tertiary">Lifecycle describes the work item. Execution status comes from linked Sessions and Automation runs.</p><div className="mt-3">
              <div className="flex flex-wrap gap-2">
                {!isArchived && todo.status !== "rejected" ? <TodoActionButton variant="quiet" onClick={() => setRejecting(true)}>Reject</TodoActionButton> : null}
                {!isArchived ? <TodoActionButton variant="quiet" onClick={() => update({ expectedRevision: todo.revision, archived: true })}>Archive</TodoActionButton> : <TodoActionButton variant="quiet" onClick={() => update({ expectedRevision: todo.revision, archived: false })}>Restore</TodoActionButton>}
              </div>
              {rejecting ? <div className="mt-3 border-y border-warning/30 bg-warning-muted p-3"><textarea autoFocus aria-label="Rejection reason" rows={3} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why should this Todo be rejected?" className="w-full resize-y bg-transparent text-[12px] outline-none" /><div className="mt-2 flex justify-end gap-2"><TodoActionButton onClick={() => setRejecting(false)}>Cancel</TodoActionButton><TodoActionButton variant="danger" onClick={reject}>Reject Todo</TodoActionButton></div></div> : null}
            </div><p className="mt-2.5 text-[10px] leading-[1.5] text-text-tertiary">No Plan state, Goal state, or execution phase is added to the Todo.</p></section>
          </aside>
        </div>
      </div>
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
  const done = status === "done";
  return <div role="group" aria-label="Todo lifecycle" className={`relative inline-flex h-9 items-stretch rounded-sm border p-[3px] max-[761px]:h-[52px] max-[761px]:w-full max-[761px]:overflow-x-auto ${done ? "border-[color:color-mix(in_srgb,var(--success)_30%,var(--border-default))] bg-success-field" : "border-border-default bg-bg-muted"}`}>
    {LANES.map((lane, index) => {
      const { Icon, title } = PROJECT_TODO_LANE_PRESENTATIONS[lane];
      const current = lane === status;
      const tone = current
        ? lane === "idea"
          ? "bg-brand-field text-brand"
          : lane === "in_progress"
            ? "bg-signal-field text-signal-foreground"
            : lane === "done"
              ? "bg-success-field text-success"
              : "bg-bg-elevated text-text-primary shadow-[inset_0_0_0_1px_var(--border-default)]"
        : index < currentIndex
          ? "text-text-secondary"
          : "text-text-tertiary hover:bg-[color:color-mix(in_srgb,var(--bg-hover)_70%,transparent)] hover:text-text-secondary";
      return <button key={lane} type="button" aria-pressed={current} aria-label={current ? `Current Todo status: ${title}` : `Move Todo to ${title}`} disabled={archived || pending} onClick={() => { if (!current) onMove(lane); }} className={`inline-flex min-w-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-[2px] border-0 px-3 text-[12px] font-semibold tracking-[-0.01em] transition-[background-color,color] duration-[var(--motion-hover)] focus-visible:z-10 focus-visible:outline-none focus-visible:[box-shadow:var(--focus)] disabled:cursor-not-allowed disabled:opacity-45 max-[761px]:min-h-11 max-[761px]:flex-1 max-[761px]:justify-center max-[761px]:px-2 ${tone}`}><Icon className={current && lane === "in_progress" ? "animate-activity-pulse" : ""} size={14} strokeWidth={1.7} aria-hidden="true" /><span className={`${current ? "max-[761px]:inline" : "max-[761px]:hidden"}`}>{title}</span></button>;
    })}
    {done ? <span className="ml-1 inline-flex items-center gap-[7px] whitespace-nowrap py-0 pl-1 pr-2.5 text-[12px] font-[680] tracking-[-0.01em] text-success max-[761px]:hidden" aria-hidden="true"><CircleCheck size={15} strokeWidth={2.4} />Accepted</span> : null}
  </div>;
}

function RouteMessage({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "error" }) {
  return <div className={`flex h-full items-center justify-center text-sm ${tone === "error" ? "text-error" : "text-text-tertiary"}`}>{children}</div>;
}
function TodoContextStarter({ onOpenPlan, disabled, loading }: { onOpenPlan: () => void; disabled: boolean; loading: boolean }) {
  return <section className="flex flex-wrap items-center justify-between gap-[18px] border-t border-border-subtle py-4" aria-labelledby="todo-context-starter-plan-heading"><div><h2 id="todo-context-starter-plan-heading" className="text-[12px] font-semibold text-text-primary">Add context when it helps</h2><p className="mt-1 text-[11px] text-text-tertiary">Shape a Plan only when this work needs more structure.</p></div><TodoActionButton onClick={onOpenPlan} disabled={disabled}>{loading ? <LoaderCircle className="animate-activity" size={12} /> : null}{loading ? "Opening…" : "Generate Plan"}</TodoActionButton></section>;
}
function ActionGroup({ label, children, separated = false }: { label: string; children: ReactNode; separated?: boolean }) {
  return <div role="group" aria-label={label} className={`mt-4 ${separated ? "border-t border-border-subtle pt-3.5" : ""}`}><h3 className="text-[11px] font-[680] uppercase tracking-[0.05em] text-text-tertiary">{label}</h3><div className="mt-2.5 flex flex-wrap gap-2">{children}</div></div>;
}
function AssociatedSessions({ slug, items }: { slug: string; items: ProjectSessionInventoryItem[] }) {
  return items.length ? <div className="border-t border-border-subtle">{items.map((item) => {
    const { session } = item;
    const presentation = presentProjectTodoLinkedSession(item);
    const title = session.title || session.sessionId;
    return <Link key={session.sessionId} aria-label={`${title}, ${presentation.context}, ${presentation.label}`} className="grid grid-cols-[13px_minmax(0,1fr)_auto] gap-[9px] border-b border-border-subtle px-0.5 py-[13px] text-left text-text-secondary transition-colors duration-[var(--motion-hover)] hover:text-text-primary focus-visible:outline-none focus-visible:[box-shadow:var(--focus)]" to={`/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(session.sessionId)}`}><StatusGlyph kind={presentation.kind} size={11} className="mt-[3px]" /><span className="min-w-0"><strong className="block truncate text-[12px] font-[630]">{title}</strong><small className="mt-1 block text-[10px] leading-[1.4] text-text-tertiary">{presentation.context}</small></span><span className={`whitespace-nowrap text-[9px] font-[650] ${linkedStateTone(presentation.kind)}`}>{presentation.label}</span></Link>;
  })}</div> : <p className="text-[12px] text-text-tertiary">No sessions yet.</p>;
}

function LinkedAutomationRow({ slug, automation }: { slug: string; automation: Automation }) {
  const label = automation.status === "active" ? "Scheduled" : automation.status === "paused" ? "Paused" : "Inactive";
  const kind = automation.status === "active" ? "enabled" : automation.status === "paused" ? "paused" : "disabled";
  const marker = automation.status === "active"
    ? <span aria-hidden="true" className="mt-[3px] h-[11px] w-[11px] rounded-full border border-text-tertiary" />
    : <StatusGlyph kind={kind} size={11} className="mt-[3px]" />;
  const stateTone = automation.status === "active" ? "text-text-tertiary" : linkedStateTone(kind);
  return <Link aria-label={`${automation.name}, ${formatAutomationTrigger(automation.trigger)}, ${label}`} className="grid grid-cols-[13px_minmax(0,1fr)_auto] gap-[9px] border-b border-border-subtle px-0.5 py-[13px] text-left text-text-secondary transition-colors duration-[var(--motion-hover)] hover:text-text-primary focus-visible:outline-none focus-visible:[box-shadow:var(--focus)]" to={`/projects/${encodeURIComponent(slug)}/automations/${encodeURIComponent(automation.id)}`}>{marker}<span className="min-w-0"><strong className="block truncate text-[12px] font-[630]">{automation.name}</strong><small className="mt-1 block text-[10px] leading-[1.4] text-text-tertiary">{formatAutomationTrigger(automation.trigger)}</small></span><span className={`whitespace-nowrap text-[9px] font-[650] ${stateTone}`}>{label}</span></Link>;
}

function linkedStateTone(kind: ReturnType<typeof presentProjectTodoLinkedSession>["kind"]): string {
  return kind === "running" ? "text-signal-foreground"
    : kind === "needs_you" || kind === "paused" ? "text-warning"
      : kind === "completed" ? "text-text-tertiary"
        : kind === "failed" ? "text-error"
          : kind === "enabled" ? "text-info" : "text-text-tertiary";
}
function TodoActionButton({ children, onClick, disabled, variant = "default", compactOnMobile = false }: { children: ReactNode; onClick: () => void; disabled?: boolean; variant?: "default" | "primary" | "quiet" | "danger"; compactOnMobile?: boolean }) {
  const tone = variant === "primary"
    ? "border-brand bg-brand text-brand-ink shadow-[0_1px_3px_rgb(97_87_213_/_30%),inset_0_1px_0_rgb(255_255_255_/_10%)] hover:border-brand-hover hover:bg-brand-hover hover:-translate-y-px hover:shadow-[0_3px_8px_rgb(97_87_213_/_30%),inset_0_1px_0_rgb(255_255_255_/_18%)] active:translate-y-0 active:scale-[0.98]"
    : variant === "quiet"
      ? "border-transparent bg-transparent px-2.5 text-text-tertiary hover:bg-bg-hover hover:text-text-primary"
      : variant === "danger"
        ? "border-error/30 bg-error-muted text-error hover:bg-error/15"
        : "border-border-default bg-bg-elevated text-text-secondary hover:border-border-strong hover:bg-bg-hover hover:text-text-primary";
  const geometry = variant === "quiet" ? "border-0 px-2.5" : "border px-[13px]";
  const mobileGeometry = compactOnMobile ? "max-[761px]:min-h-8" : "max-[761px]:min-h-11 [@media(pointer:coarse)]:min-h-11";
  return <button type="button" onClick={onClick} disabled={disabled} className={`inline-flex min-h-8 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-sm text-[12px] font-semibold tracking-[-0.01em] transition-[background-color,border-color,color,box-shadow,transform] duration-[var(--motion-hover)] focus-visible:outline-none focus-visible:[box-shadow:var(--focus)] disabled:cursor-not-allowed disabled:opacity-45 ${mobileGeometry} ${geometry} ${tone}`}>{children}</button>;
}
function lifecycleHint(status: ProjectTodoLane): string { return status === "idea" ? "Ideas · captured, not committed" : status === "ready" ? "Ready · clear enough to start" : status === "in_progress" ? "In Progress · execution is attached" : "Done · explicitly accepted"; }
function isTodoLane(status: ProjectTodo["status"]): status is ProjectTodoLane { return status !== "rejected"; }
function messageFor(cause: unknown): string { return cause instanceof Error ? cause.message : "Action failed"; }
