import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  projectTodoDisplayLabel,
  isSessionMessageUnavailableCode,
  type RequestedModelSelection,
} from "@archcode/protocol";
import { Archive, ArrowLeft, FileText, LoaderCircle, MessageCircle, Plus, RotateCcw, Save, Send } from "lucide-react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { ApiError } from "../api/client";
import { useCreateProjectTodoSession, usePostMessage, useUpdateProjectTodo } from "../api/mutations";
import { sessionQueryOptions, useAutomationInventory, useProjectTodoPlan, useProjectTodos, useSessionInventory } from "../api/queries";
import type { Automation, ProjectTodo, ProjectTodoUpdateInput, SessionSummary } from "../api/types";
import { MarkdownContent } from "../components/primitives/MarkdownContent";
import { STATUS_TONE_CLASS } from "../lib/status-visuals";
import { demoteEmbeddedMarkdownHeadings, projectTodoContentRemainder, presentProjectTodoCard, type ProjectTodoLane } from "./project-todo-presentation";

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
  if (todos.error) return <RouteMessage tone="error">Failed to load Todo</RouteMessage>;
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
      sessions={(sessionInventory.data ?? []).map((item) => item.session)}
      sessionsLoading={sessionInventory.isLoading}
      sessionsError={sessionInventory.error}
      automations={(automationInventory.data ?? []).map((item) => item.automation)}
      automationsLoading={automationInventory.isLoading}
      automationsError={automationInventory.error}
      onBack={backToTodos}
    />
  );
}

function TodoDetailView({ todo, slug, sessions, sessionsLoading, sessionsError, automations, automationsLoading, automationsError, onBack }: {
  todo: ProjectTodo;
  slug: string;
  sessions: SessionSummary[];
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
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(todo.content);
  const [reason, setReason] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [isOpeningPlan, setIsOpeningPlan] = useState(false);
  const planActionInFlight = useRef(false);
  useEffect(() => {
    if (!editing) setContent(todo.content);
  }, [editing, todo.content]);

  const associatedSessions = sessions
    .filter((session) => session.source?.kind === "todo" && session.source.todoId === todo.id)
    .sort((left, right) => right.updatedAt - left.updatedAt);
  const discussionSessions = associatedSessions.filter((session) => session.source?.kind === "todo" && session.source.entry === "discussion");
  const workSessions = associatedSessions.filter((session) => session.source?.kind === "todo" && session.source.entry === "work");
  const associatedAutomations = automations
    .filter((automation) => automation.origin.kind === "todo" && automation.origin.todoId === todo.id)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  const isArchived = todo.archivedAt !== undefined;
  const presentation = presentProjectTodoCard({ status: todo.status, ...(isArchived ? { archivedAt: todo.archivedAt } : {}) });
  const label = projectTodoDisplayLabel(todo.content, todo.id);
  const documentBody = projectTodoContentRemainder(todo.content);
  const embeddedDocumentBody = demoteEmbeddedMarkdownHeadings(documentBody);
  const sessionsAvailable = !sessionsLoading && sessionsError === null;

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
          try {
            await postMessage.mutateAsync({ slug, sessionId, content: command, attachmentIds: [], requestedModelSelection });
            return "sent";
          } catch (cause) {
            if (isUnavailablePlanDiscussion(cause)) return "unavailable";
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
      <header className="shrink-0 border-b border-border-default bg-bg-surface px-4 py-4 min-[621px]:px-6">
        <div className="mx-auto flex max-w-[1280px] items-start gap-3">
          <button type="button" onClick={onBack} aria-label="Back to Todos" className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-text-tertiary hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"><ArrowLeft size={16} /></button>
          <div className="min-w-0 flex-1">
            <span className={`inline-flex items-center gap-1.5 text-[11px] font-semibold ${STATUS_TONE_CLASS[presentation.tone]}`}><presentation.Icon size={13} />{presentation.label}</span>
            <h1 className="mt-1 max-w-[900px] text-[20px] font-semibold leading-7 text-text-primary">{label}</h1>
            <p className="mt-1 font-mono text-[10px] text-text-tertiary">{todo.id}</p>
          </div>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 min-[621px]:px-6">
        <div className="mx-auto grid max-w-[1280px] gap-6 min-[1050px]:grid-cols-[minmax(0,1fr)_320px]">
          <div className="min-w-0 space-y-6">
            <section aria-labelledby="todo-brief-heading" className="rounded-lg border border-border-default bg-bg-elevated p-4 min-[621px]:p-5">
              <div className="flex items-center justify-between gap-3">
                <h2 id="todo-brief-heading" className="text-[13px] font-semibold text-text-primary">Brief / PRD</h2>
                {!editing ? <TodoActionButton onClick={() => setEditing(true)}>Edit</TodoActionButton> : null}
              </div>
              {editing ? (
                <div className="mt-3 space-y-3">
                  <textarea autoFocus aria-label="Todo content" rows={14} value={content} onChange={(event) => setContent(event.target.value)} className="w-full resize-y rounded-sm border border-border-control bg-bg-base px-3 py-3 font-mono text-[12px] leading-5 text-text-primary outline-none focus:border-brand focus:ring-2 focus:ring-brand-subtle" />
                  <div className="flex gap-2">
                    <TodoActionButton variant="primary" disabled={updateTodo.isPending || content.trim().length === 0} onClick={() => update({ expectedRevision: todo.revision, content: content.trim() }, () => setEditing(false))}><Save size={12} />Save</TodoActionButton>
                    <TodoActionButton onClick={() => { setContent(todo.content); setEditing(false); }}>Cancel</TodoActionButton>
                  </div>
                </div>
              ) : documentBody.length > 0
                ? <div className="mt-4 max-w-[820px]"><MarkdownContent>{embeddedDocumentBody}</MarkdownContent></div>
                : <p className="mt-4 text-[12px] text-text-tertiary">No additional detail yet.</p>}
            </section>

            <section aria-labelledby="todo-plan-heading" className="rounded-lg border border-border-default bg-bg-elevated p-4 min-[621px]:p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div><h2 id="todo-plan-heading" className="text-[13px] font-semibold text-text-primary">Plan</h2><p className="mt-1 text-[11px] text-text-tertiary">Ordinary Markdown shaped through Discussion.</p></div>
                {!isArchived ? <TodoActionButton onClick={() => void openPlan()} disabled={isOpeningPlan || !sessionsAvailable}>{isOpeningPlan ? <LoaderCircle className="animate-activity" size={12} /> : <FileText size={12} />}{isOpeningPlan ? "Opening…" : TODO_PLAN_ACTION_LABEL}</TodoActionButton> : null}
              </div>
              {sessionsLoading ? <p className="mt-3 text-[11px] text-text-tertiary">Plan actions are available after Sessions load.</p> : null}
              {sessionsError !== null ? <p className="mt-3 text-[11px] text-text-tertiary">Plan actions are unavailable because Sessions could not load.</p> : null}
              {planError ? <p role="alert" className="mt-3 text-[11px] text-error">{planError}</p> : null}
              {plan.isLoading ? <p className="mt-4 text-[12px] text-text-tertiary">Loading Plan…</p> : null}
              {plan.error ? <p role="alert" className="mt-4 text-[12px] text-error">Could not load Plan: {messageFor(plan.error)}</p> : null}
              {!plan.isLoading && !plan.error && plan.data === null ? <p className="mt-4 text-[12px] text-text-tertiary">No Plan yet. Generate one through Discussion.</p> : null}
              {plan.data && plan.data.markdown.trim().length === 0 ? <p className="mt-4 text-[12px] text-text-tertiary">Plan file exists but is empty. Continue the Discussion to fill it in.</p> : null}
              {plan.data && plan.data.markdown.trim().length > 0 ? <div className="mt-4 max-w-[820px] border-t border-border-subtle pt-4"><MarkdownContent>{demoteEmbeddedMarkdownHeadings(plan.data.markdown)}</MarkdownContent></div> : null}
            </section>
          </div>

          <aside className="min-w-0 space-y-4" aria-label="Todo work and lifecycle">
            <DetailPanel title="Work">
              {sessionsLoading ? <p className="text-[12px] text-text-tertiary">Loading linked work…</p> : null}
              {sessionsError !== null ? <p className="text-[12px] text-text-tertiary">Linked work is unavailable because Sessions could not load.</p> : null}
              {sessionsAvailable && !isArchived ? <ActionGroup label="Discuss & Plan">
                {discussionSessions[0] ? <TodoActionButton onClick={() => navigate(`/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(discussionSessions[0]!.sessionId)}`)}>Continue Discussion</TodoActionButton> : null}
                <TodoActionButton variant="brand" onClick={() => start("discussion")} disabled={createSession.isPending}><MessageCircle size={12} />New Discussion</TodoActionButton>
              </ActionGroup> : null}
              {sessionsAvailable && !isArchived && (todo.status === "ready" || todo.status === "in_progress") ? <ActionGroup label="Execution">
                {workSessions[0] ? <><TodoActionButton variant="primary" onClick={continueWork} disabled={updateTodo.isPending}><Send size={12} />Continue Work</TodoActionButton><TodoActionButton onClick={() => start("work")} disabled={createSession.isPending}><Plus size={12} />New Work Session</TodoActionButton></> : <TodoActionButton variant="primary" onClick={() => start("work")} disabled={createSession.isPending}><Send size={12} />Start Work</TodoActionButton>}
                <TodoActionButton onClick={() => start("automation")} disabled={createSession.isPending}>Create Automation</TodoActionButton>
              </ActionGroup> : null}
              {actionError ? <p role="alert" className="text-[11px] leading-4 text-error">{actionError}</p> : null}
            </DetailPanel>

            <DetailPanel title="Sessions">
              {sessionsLoading ? <p className="text-[12px] text-text-tertiary">Loading sessions…</p> : null}
              {sessionsError !== null ? <p role="alert" className="text-[12px] text-error">Could not load sessions: {messageFor(sessionsError)}</p> : null}
              {sessionsAvailable ? <AssociatedSessions slug={slug} sessions={associatedSessions} /> : null}
            </DetailPanel>
            <DetailPanel title="Automations">
              {automationsLoading ? <p className="text-[12px] text-text-tertiary">Loading automations…</p> : null}
              {automationsError !== null ? <p role="alert" className="text-[12px] text-error">Could not load automations: {messageFor(automationsError)}</p> : null}
              {!automationsLoading && automationsError === null && (associatedAutomations.length ? <div className="space-y-2">{associatedAutomations.map((automation) => <Link key={automation.id} to={`/projects/${encodeURIComponent(slug)}/automations/${encodeURIComponent(automation.id)}`} className="block truncate text-[12px] text-brand hover:underline">{automation.name}</Link>)}</div> : <p className="text-[12px] text-text-tertiary">No automations yet.</p>)}
            </DetailPanel>
            <DetailPanel title="Lifecycle">
              <div className="flex flex-wrap gap-2">
                {!isArchived && todo.status === "rejected" ? <TodoActionButton onClick={() => update({ expectedRevision: todo.revision, status: "idea" })}><RotateCcw size={12} />Restore to Ideas</TodoActionButton> : null}
                {!isArchived && todo.status !== "rejected" ? <TodoActionButton onClick={() => setRejecting(true)}>Reject</TodoActionButton> : null}
                {!isArchived && todo.status !== "rejected" ? LANES.filter((status) => status !== todo.status).map((status) => <TodoActionButton key={status} onClick={() => update({ expectedRevision: todo.revision, status })}>Move to {labelForStatus(status)}</TodoActionButton>) : null}
                {!isArchived ? <TodoActionButton onClick={() => update({ expectedRevision: todo.revision, archived: true })}><Archive size={12} />Archive</TodoActionButton> : <TodoActionButton onClick={() => update({ expectedRevision: todo.revision, archived: false })}><RotateCcw size={12} />Restore</TodoActionButton>}
              </div>
              {rejecting ? <div className="mt-3 border-y border-warning/30 bg-warning-muted p-3"><textarea autoFocus aria-label="Rejection reason" rows={3} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why should this Todo be rejected?" className="w-full resize-y bg-transparent text-[12px] outline-none" /><div className="mt-2 flex justify-end gap-2"><TodoActionButton onClick={() => setRejecting(false)}>Cancel</TodoActionButton><TodoActionButton variant="danger" onClick={reject}>Reject Todo</TodoActionButton></div></div> : null}
            </DetailPanel>
          </aside>
        </div>
      </div>
    </div>
  );
}

function RouteMessage({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "error" }) {
  return <div className={`flex h-full items-center justify-center text-sm ${tone === "error" ? "text-error" : "text-text-tertiary"}`}>{children}</div>;
}
function DetailPanel({ title, children }: { title: string; children: ReactNode }) {
  return <section className="rounded-lg border border-border-default bg-bg-elevated p-4"><h2 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-text-tertiary">{title}</h2><div className="space-y-4">{children}</div></section>;
}
function ActionGroup({ label, children }: { label: string; children: ReactNode }) {
  return <div role="group" aria-label={label}><h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-text-muted">{label}</h3><div className="mt-2 flex flex-wrap gap-2">{children}</div></div>;
}
function AssociatedSessions({ slug, sessions }: { slug: string; sessions: SessionSummary[] }) {
  return sessions.length ? <div className="space-y-2">{sessions.map((session) => <Link key={session.sessionId} className="flex items-center justify-between gap-3 text-[12px] text-brand hover:underline" to={`/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(session.sessionId)}`}><span className="truncate">{session.title || session.sessionId}</span><span className="shrink-0 text-[11px] text-text-tertiary">{entryLabel(session.source?.kind === "todo" ? session.source.entry : undefined)}</span></Link>)}</div> : <p className="text-[12px] text-text-tertiary">No sessions yet.</p>;
}
function TodoActionButton({ children, onClick, disabled, variant = "default" }: { children: ReactNode; onClick: () => void; disabled?: boolean; variant?: "default" | "primary" | "brand" | "danger" }) {
  const tone = variant === "primary" ? "border-brand bg-brand text-bg-overlay hover:bg-brand-hover" : variant === "brand" ? "border-brand/40 bg-brand-subtle text-brand hover:bg-brand/15" : variant === "danger" ? "border-error/30 bg-error-muted text-error hover:bg-error/15" : "border-border-default bg-bg-active text-text-secondary hover:bg-bg-hover hover:text-text-primary";
  return <button type="button" onClick={onClick} disabled={disabled} className={`inline-flex min-h-8 items-center gap-1.5 rounded-sm border px-2.5 text-[12px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-40 [@media(pointer:coarse)]:min-h-11 ${tone}`}>{children}</button>;
}
function entryLabel(entry?: "discussion" | "work" | "automation"): string { return entry === "discussion" ? "Discussion" : entry === "automation" ? "Automation setup" : "Work"; }
function labelForStatus(status: ProjectTodoLane): string { return status === "idea" ? "Ideas" : status === "ready" ? "Ready" : status === "in_progress" ? "In Progress" : "Done"; }
function messageFor(cause: unknown): string { return cause instanceof Error ? cause.message : "Action failed"; }
