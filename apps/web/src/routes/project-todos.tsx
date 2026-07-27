import { useMemo, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Archive, Check, GripVertical, MessageCircle, Plus, RotateCcw, Save, Send, X } from "lucide-react";
import { useCreateProjectTodo, useCreateProjectTodoSession, useUpdateProjectTodo } from "../api/mutations";
import { useAutomations, useProjectTodos, useSessions } from "../api/queries";
import type { Automation, ProjectTodo, ProjectTodoStatus, ProjectTodoUpdateInput, SessionSummary } from "../api/types";
import { STATUS_TONE_CLASS, type StatusTone } from "../lib/status-visuals";
import {
  PROJECT_TODO_LANE_PRESENTATIONS,
  presentProjectTodoCard,
  type ProjectTodoLane,
} from "./project-todo-presentation";

type View = "board" | "rejected" | "archived";
type BoardOrder = Record<ProjectTodoLane, string[]>;
const LANES: readonly ProjectTodoLane[] = ["idea", "ready", "in_progress", "done"];

export function deriveProjectTodoGroups(todos: readonly ProjectTodo[]): Record<ProjectTodoLane, ProjectTodo[]> {
  const groups: Record<ProjectTodoLane, ProjectTodo[]> = { idea: [], ready: [], in_progress: [], done: [] };
  for (const todo of todos) {
    if (todo.archivedAt === undefined && todo.status !== "rejected") groups[todo.status].push(todo);
  }
  return groups;
}

function deriveBoardOrder(todos: readonly ProjectTodo[]): BoardOrder {
  const groups = deriveProjectTodoGroups(todos);
  return Object.fromEntries(LANES.map((lane) => [lane, groups[lane].map((todo) => todo.id)])) as BoardOrder;
}

function locateTodo(order: BoardOrder, todoId: string): { lane: ProjectTodoLane; index: number } | undefined {
  for (const lane of LANES) {
    const index = order[lane].indexOf(todoId);
    if (index !== -1) return { lane, index };
  }
  return undefined;
}

/** Component-local projection used exclusively during a drag; server order remains authoritative. */
export function moveTodoInBoard(order: BoardOrder, todoId: string, destination: ProjectTodoLane, destinationIndex: number): BoardOrder {
  const source = locateTodo(order, todoId);
  if (!source) return order;
  const next: BoardOrder = { idea: [...order.idea], ready: [...order.ready], in_progress: [...order.in_progress], done: [...order.done] };
  const [moved] = next[source.lane].splice(source.index, 1);
  if (!moved) return order;
  next[destination].splice(Math.max(0, Math.min(destinationIndex, next[destination].length)), 0, moved);
  return next;
}

export function continueWorkUpdateInput(todo: ProjectTodo): ProjectTodoUpdateInput | undefined {
  return todo.status === "ready"
    ? { expectedRevision: todo.revision, status: "in_progress" }
    : undefined;
}

export function ProjectTodosRoute() {
  const { slug = "" } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: todos = [], isLoading, error } = useProjectTodos(slug);
  const { data: sessions = [] } = useSessions(slug);
  const { data: automations = [] } = useAutomations(slug);
  const createTodo = useCreateProjectTodo();
  const updateTodo = useUpdateProjectTodo();
  const createSession = useCreateProjectTodoSession();
  const [view, setView] = useState<View>("board");
  const [newTitle, setNewTitle] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [temporaryOrder, setTemporaryOrder] = useState<BoardOrder | null>(null);
  const [reorderError, setReorderError] = useState<string | null>(null);
  const selectedId = searchParams.get("todo");
  const selectedTodo = todos.find((todo) => todo.id === selectedId);
  const canonicalOrder = useMemo(() => deriveBoardOrder(todos), [todos]);
  const boardOrder = temporaryOrder ?? canonicalOrder;
  const todoById = useMemo(() => new Map(todos.map((todo) => [todo.id, todo])), [todos]);
  const announcements = useMemo(() => createDragAnnouncements(boardOrder, todoById), [boardOrder, todoById]);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const selectTodo = (id: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (id) next.set("todo", id);
    else next.delete("todo");
    setSearchParams(next, { replace: true });
  };

  const create = () => {
    const title = newTitle.trim();
    if (!title) {
      setCreateError("Title is required");
      return;
    }
    setCreateError(null);
    createTodo.mutate({ slug, input: { title } }, {
      onSuccess: ({ todo }) => {
        setNewTitle("");
        setView("board");
        selectTodo(todo.id);
      },
      onError: (cause) => setCreateError(messageFor(cause)),
    });
  };

  const resolveDrop = (activeId: string, overId: string | null): { lane: ProjectTodoLane; index: number } | undefined => {
    if (!overId) return undefined;
    if (isLane(overId)) return { lane: overId, index: boardOrder[overId].length };
    const target = locateTodo(boardOrder, overId);
    return target ? { lane: target.lane, index: target.index } : undefined;
  };

  const onDragStart = ({ active }: DragStartEvent) => {
    setReorderError(null);
    setDraggedId(String(active.id));
    setTemporaryOrder(canonicalOrder);
  };
  const onDragOver = ({ active, over }: DragOverEvent) => {
    const todoId = String(active.id);
    const destination = resolveDrop(todoId, over ? String(over.id) : null);
    if (!destination) return;
    setTemporaryOrder((previous) => moveTodoInBoard(previous ?? canonicalOrder, todoId, destination.lane, destination.index));
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    const todoId = String(active.id);
    const todo = todoById.get(todoId);
    const destination = resolveDrop(todoId, over ? String(over.id) : null);
    const finalOrder = temporaryOrder ?? canonicalOrder;
    setDraggedId(null);
    if (!todo || !destination) {
      setTemporaryOrder(null);
      return;
    }
    const result = locateTodo(finalOrder, todoId);
    if (!result) {
      setTemporaryOrder(null);
      return;
    }
    const beforeTodoId = finalOrder[result.lane][result.index + 1] ?? null;
    const stateChanged = todo.status !== result.lane;
    const positionChanged = canonicalOrder[result.lane].indexOf(todoId) !== result.index || todo.status !== result.lane;
    if (!stateChanged && !positionChanged) {
      setTemporaryOrder(null);
      return;
    }
    updateTodo.mutate({
      slug,
      todoId,
      input: { expectedRevision: todo.revision, ...(stateChanged ? { status: result.lane } : {}), beforeTodoId },
    }, {
      onSuccess: () => setTemporaryOrder(null),
      onError: (cause) => {
        setTemporaryOrder(null);
        setReorderError(messageFor(cause));
      },
    });
  };
  const onDragCancel = () => {
    setDraggedId(null);
    setTemporaryOrder(null);
  };

  if (isLoading) return <div className="flex h-full items-center justify-center text-sm text-text-tertiary">Loading Todos…</div>;
  if (error) return <div className="flex h-full items-center justify-center text-sm text-error">Failed to load Todos</div>;

  const visibleTodos = view === "archived"
    ? todos.filter((todo) => todo.archivedAt !== undefined)
    : view === "rejected"
      ? todos.filter((todo) => todo.archivedAt === undefined && todo.status === "rejected")
      : [];

  return (
    <div className="flex h-full flex-col overflow-hidden bg-bg-base">
      <header className="flex min-h-[68px] shrink-0 flex-wrap items-center justify-between gap-4 border-b border-border-default bg-bg-surface px-4 py-3 min-[621px]:px-6">
        <div><h1 className="text-[20px] font-semibold leading-7 tracking-[-0.02em] text-text-primary">Todos</h1><p className="mt-0.5 text-[12px] leading-5 text-text-tertiary">Shape intent, then start as many discussions or work sessions as useful.</p></div>
        <div className="flex items-center rounded-md border border-border-default bg-bg-muted p-0.5" role="group" aria-label="Todo views">
          <ViewButton active={view === "board"} onClick={() => setView("board")}>Board</ViewButton>
          <ViewButton active={view === "rejected"} onClick={() => setView("rejected")}>Rejected</ViewButton>
          <ViewButton active={view === "archived"} onClick={() => setView("archived")}>Archived</ViewButton>
        </div>
      </header>
      <div className="shrink-0 px-4 pt-4 min-[621px]:px-6">
        <div className="mx-auto flex max-w-[1500px] gap-2 rounded-lg border border-border-control bg-bg-elevated p-2.5 shadow-sm focus-within:border-brand focus-within:ring-2 focus-within:ring-brand-subtle">
          <Plus size={15} className="shrink-0 self-center text-text-tertiary" aria-hidden="true" />
          <input aria-label="New Todo" value={newTitle} onChange={(event) => { setNewTitle(event.target.value); setCreateError(null); }} onKeyDown={(event) => { if (event.key === "Enter") create(); }} placeholder="Capture a Todo…" className="h-8 min-w-0 flex-1 bg-transparent px-1 text-[13px] text-text-primary outline-none placeholder:text-text-muted" />
          <button type="button" onClick={create} disabled={createTodo.isPending} className="h-8 rounded-sm bg-brand px-3 text-[12px] font-medium text-bg-overlay hover:bg-brand-hover disabled:opacity-40">Add</button>
        </div>
        {createError ? <p role="alert" className="mx-auto mt-1 max-w-[1500px] text-[11px] text-error">{createError}</p> : null}
      </div>
      <main className="min-h-0 flex-1 overflow-auto px-4 py-4 min-[621px]:px-6">
        {view === "board" ? (
          <DndContext sensors={sensors} collisionDetection={closestCorners} onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd} onDragCancel={onDragCancel} accessibility={{ announcements }}>
            <div className="mx-auto grid max-w-[1500px] grid-cols-1 gap-3 min-[700px]:grid-cols-2 min-[1100px]:grid-cols-4" data-testid="todo-board">
              {LANES.map((lane) => <TodoLane key={lane} lane={lane} order={boardOrder[lane]} todoById={todoById} selectedId={selectedId} onSelect={selectTodo} />)}
            </div>
            <DragOverlay dropAnimation={null}>{draggedId ? <DragPreview todo={todoById.get(draggedId)} /> : null}</DragOverlay>
          </DndContext>
        ) : <TodoFlatList view={view} todos={visibleTodos} selectedId={selectedId} onSelect={selectTodo} />}
      </main>
      {reorderError ? <p role="alert" className="shrink-0 border-t border-error/20 bg-error-muted px-5 py-3 text-[11px] text-error">Could not move Todo: {reorderError}</p> : null}
      <TodoDetailDrawer todo={selectedTodo} slug={slug} sessions={sessions} automations={automations} navigate={navigate} onClose={() => selectTodo(null)} createSession={createSession} updateTodo={updateTodo} />
    </div>
  );
}

function TodoLane({ lane, order, todoById, selectedId, onSelect }: { lane: ProjectTodoLane; order: string[]; todoById: Map<string, ProjectTodo>; selectedId: string | null; onSelect: (id: string) => void }) {
  const presentation = PROJECT_TODO_LANE_PRESENTATIONS[lane];
  const { Icon } = presentation;
  const { setNodeRef } = useDroppable({ id: lane, data: { type: "lane", lane } });
  return <section ref={setNodeRef} className="min-h-40 rounded-lg border border-border-default bg-bg-surface p-3 min-[1100px]:min-h-[500px]" aria-label={presentation.title} data-testid={`todo-lane-${lane}`}>
    <header className="flex min-h-11 items-center justify-between gap-2 border-b border-border-subtle pb-2"><div className="flex items-center gap-2"><Icon size={14} className={STATUS_TONE_CLASS[presentation.tone]} /><div><h2 className="text-[14px] font-semibold text-text-primary">{presentation.title}</h2><p className="text-[11px] text-text-tertiary">{presentation.hint}</p></div></div><span className="border border-border-default bg-bg-muted px-1.5 py-0.5 text-[11px] text-text-tertiary">{order.length}</span></header>
    <SortableContext items={order} strategy={verticalListSortingStrategy}><div className="mt-3 flex min-h-24 flex-col gap-2.5">{order.length ? order.map((id) => { const todo = todoById.get(id); return todo ? <SortableTodoCard key={id} todo={todo} selected={selectedId === id} onSelect={() => onSelect(id)} /> : null; }) : <div className="flex min-h-24 flex-col items-center justify-center px-3 text-center"><p className="text-[11px] font-medium text-text-tertiary">{presentation.emptyTitle}</p><p className="mt-1 text-[11px] text-text-tertiary">{presentation.emptyHint}</p></div>}</div></SortableContext>
  </section>;
}

function SortableTodoCard({ todo, selected, onSelect }: { todo: ProjectTodo; selected: boolean; onSelect: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: todo.id, data: { type: "todo", todo } });
  const presentation = presentProjectTodoCard({ status: todo.status, ...(todo.archivedAt === undefined ? {} : { archivedAt: todo.archivedAt }) });
  const { Icon } = presentation;
  return <article ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className={`rounded-md border bg-bg-elevated ${selected ? "border-brand" : "border-border-default"} ${isDragging ? "opacity-35" : ""}`} data-testid={`todo-${todo.id}`}>
    <div className="flex items-start gap-1 p-2.5"><button type="button" className="mt-0.5 shrink-0 touch-none rounded-sm p-1 text-text-tertiary hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand" aria-label={`Drag ${todo.title}`} {...attributes} {...listeners}><GripVertical size={14} /></button><button type="button" data-testid={`todo-open-${todo.id}`} className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand" onClick={onSelect} aria-haspopup="dialog" aria-expanded={selected}><span className={`inline-flex items-center gap-1 text-[11px] font-semibold ${STATUS_TONE_CLASS[presentation.tone]}`}><Icon size={12} />{presentation.label}</span><span className="mt-2 block text-[14px] font-semibold leading-5 text-text-primary">{todo.title}</span>{todo.body ? <span className="mt-1 line-clamp-2 block text-[12px] leading-5 text-text-tertiary">{todo.body}</span> : null}</button></div>
  </article>;
}

function DragPreview({ todo }: { todo?: ProjectTodo }) {
  if (!todo) return null;
  return <div className="w-64 rounded-md border border-brand bg-bg-elevated p-3 shadow-lg"><p className="text-[13px] font-semibold text-text-primary">{todo.title}</p></div>;
}

function TodoFlatList({ view, todos, selectedId, onSelect }: { view: Exclude<View, "board">; todos: ProjectTodo[]; selectedId: string | null; onSelect: (id: string) => void }) {
  const title = view === "rejected" ? "Rejected Todos" : "Archived Todos";
  return <section className="mx-auto max-w-[980px]" aria-label={title}><h2 className="border-b border-border-default pb-3 text-[14px] font-semibold text-text-primary">{title}</h2><div className="divide-y divide-border-subtle">{todos.map((todo) => <button key={todo.id} type="button" data-testid={`todo-${todo.id}`} onClick={() => onSelect(todo.id)} className={`block w-full px-3 py-3 text-left hover:bg-bg-hover ${selectedId === todo.id ? "bg-brand-subtle" : ""}`}><span className="text-[13px] font-semibold text-text-primary">{todo.title}</span><span className="mt-1 block text-[11px] text-text-tertiary">{view === "rejected" ? todo.rejectionReason : "Archived"}</span></button>)}</div></section>;
}

function TodoDetailDrawer({ todo, slug, sessions, automations, navigate, onClose, createSession, updateTodo }: { todo?: ProjectTodo; slug: string; sessions: SessionSummary[]; automations: Automation[]; navigate: ReturnType<typeof useNavigate>; onClose: () => void; createSession: ReturnType<typeof useCreateProjectTodoSession>; updateTodo: ReturnType<typeof useUpdateProjectTodo> }) {
  if (!todo) return null;
  return <DialogPrimitive.Root open onOpenChange={(open) => { if (!open) onClose(); }}><DialogPrimitive.Portal><DialogPrimitive.Overlay forceMount className="fixed inset-0 z-[60] bg-black/45" /><DialogPrimitive.Content forceMount data-testid="todo-detail-drawer" className="fixed inset-y-0 right-0 z-[61] flex w-[min(430px,calc(100%-18px))] flex-col border-l border-border-strong bg-bg-elevated shadow-2xl focus:outline-none"><TodoDetailPanel key={todo.id} todo={todo} slug={slug} sessions={sessions} automations={automations} navigate={navigate} createSession={createSession} updateTodo={updateTodo} /><DialogPrimitive.Close asChild><button type="button" aria-label="Close Todo details" className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-sm text-text-tertiary hover:bg-bg-hover"><X size={15} /></button></DialogPrimitive.Close></DialogPrimitive.Content></DialogPrimitive.Portal></DialogPrimitive.Root>;
}

function TodoDetailPanel({ todo, slug, sessions, automations, navigate, createSession, updateTodo }: { todo: ProjectTodo; slug: string; sessions: SessionSummary[]; automations: Automation[]; navigate: ReturnType<typeof useNavigate>; createSession: ReturnType<typeof useCreateProjectTodoSession>; updateTodo: ReturnType<typeof useUpdateProjectTodo> }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(todo.title);
  const [body, setBody] = useState(todo.body);
  const [reason, setReason] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const associatedSessions = sessions.filter((session) => session.projectTodo?.todoId === todo.id).sort((left, right) => right.updatedAt - left.updatedAt);
  const discussionSessions = associatedSessions.filter((session) => session.projectTodo?.entry === "discussion");
  const workSessions = associatedSessions.filter((session) => session.projectTodo?.entry === "work");
  const associatedAutomations = automations.filter((automation) => automation.projectTodoId === todo.id).sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  const isArchived = todo.archivedAt !== undefined;
  const presentation = presentProjectTodoCard({ status: todo.status, ...(isArchived ? { archivedAt: todo.archivedAt } : {}) });
  const update = (input: ProjectTodoUpdateInput, onSuccess?: () => void) => {
    setActionError(null);
    updateTodo.mutate({ slug, todoId: todo.id, input }, { onSuccess, onError: (cause) => setActionError(messageFor(cause)) });
  };
  const start = (entry: "discussion" | "work" | "automation") => {
    setActionError(null);
    createSession.mutate({ slug, todoId: todo.id, input: { expectedRevision: todo.revision, entry } }, { onSuccess: ({ sessionId }) => navigate(`/projects/${slug}/sessions/${sessionId}`), onError: (cause) => setActionError(messageFor(cause)) });
  };
  const reject = () => {
    const rejectionReason = reason.trim();
    if (!rejectionReason) { setActionError("Rejection reason is required"); return; }
    update({ expectedRevision: todo.revision, status: "rejected", rejectionReason }, () => setRejecting(false));
  };
  const continueWork = () => {
    const sessionId = workSessions[0]?.sessionId;
    if (!sessionId) return;
    const navigateToSession = () => navigate(`/projects/${slug}/sessions/${sessionId}`);
    const input = continueWorkUpdateInput(todo);
    if (input) {
      update(input, navigateToSession);
      return;
    }
    navigateToSession();
  };
  return <><header className="shrink-0 border-b border-border-default px-5 pb-4 pr-14 pt-4"><span className={`inline-flex items-center gap-2 text-[11px] font-semibold ${STATUS_TONE_CLASS[presentation.tone]}`}><presentation.Icon size={13} />{presentation.label}</span><DialogPrimitive.Title className="mt-2 text-[18px] font-semibold leading-6 text-text-primary">{todo.title}</DialogPrimitive.Title><DialogPrimitive.Description className="mt-1 text-[11px] leading-4 text-text-tertiary">A Todo can source multiple discussions, work sessions, and automations.</DialogPrimitive.Description></header><div className="min-h-0 flex-1 overflow-y-auto px-5 py-4"><div className="space-y-5"><section aria-label="Todo content">{editing ? <div className="space-y-2"><input aria-label="Todo title" value={title} onChange={(event) => setTitle(event.target.value)} className="h-8 w-full rounded-sm border border-border-control bg-bg-base px-3 text-[12px]" /><textarea aria-label="Todo body" rows={4} value={body} onChange={(event) => setBody(event.target.value)} className="w-full resize-y rounded-sm border border-border-control bg-bg-base px-3 py-2 text-[12px]" /><div className="flex gap-2"><TodoActionButton variant="primary" onClick={() => update({ expectedRevision: todo.revision, title: title.trim(), body }, () => setEditing(false))}><Save size={12} />Save</TodoActionButton><TodoActionButton onClick={() => setEditing(false)}>Cancel</TodoActionButton></div></div> : <><p className="whitespace-pre-wrap text-[12px] leading-5 text-text-secondary">{todo.body || "No additional details."}</p><div className="mt-3 flex flex-wrap gap-2"><TodoActionButton onClick={() => setEditing(true)}>Edit</TodoActionButton>{!isArchived && discussionSessions[0] ? <TodoActionButton onClick={() => navigate(`/projects/${slug}/sessions/${discussionSessions[0]!.sessionId}`)}>Continue Discussion</TodoActionButton> : null}{!isArchived ? <TodoActionButton variant="brand" onClick={() => start("discussion")} disabled={createSession.isPending}><MessageCircle size={12} />New Discussion</TodoActionButton> : null}</div></>}</section><section className="border-t border-border-subtle pt-4" aria-label="Linked sessions"><h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-text-tertiary">Sessions</h3><AssociatedSessions slug={slug} sessions={associatedSessions} /></section><section className="border-t border-border-subtle pt-4" aria-label="Linked automations"><h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-text-tertiary">Automations</h3>{associatedAutomations.length ? <div className="space-y-2">{associatedAutomations.map((automation) => <Link key={automation.id} to={`/projects/${slug}/automations/${automation.id}`} className="block text-[12px] text-brand hover:underline">{automation.name}</Link>)}</div> : <p className="text-[12px] text-text-tertiary">No automations yet.</p>}</section><section className="border-t border-border-subtle pt-4" aria-label="Todo actions"><h3 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-text-tertiary">Actions</h3><div className="flex flex-wrap gap-2">{!isArchived && (todo.status === "ready" || todo.status === "in_progress") ? <><TodoActionButton variant="primary" onClick={() => start("work")} disabled={createSession.isPending}><Send size={12} />Start Work</TodoActionButton>{workSessions[0] ? <TodoActionButton onClick={continueWork} disabled={updateTodo.isPending}>Continue Work</TodoActionButton> : null}<TodoActionButton onClick={() => start("automation")} disabled={createSession.isPending}>Create Automation</TodoActionButton></> : null}{!isArchived && todo.status === "rejected" ? <TodoActionButton onClick={() => update({ expectedRevision: todo.revision, status: "idea" })}><RotateCcw size={12} />Restore to Ideas</TodoActionButton> : null}{!isArchived && todo.status !== "rejected" ? <TodoActionButton onClick={() => setRejecting(true)}>Reject</TodoActionButton> : null}{!isArchived && todo.status !== "rejected" && LANES.filter((status) => status !== todo.status).map((status) => <TodoActionButton key={status} onClick={() => update({ expectedRevision: todo.revision, status })}>Move to {labelForStatus(status)}</TodoActionButton>)}{!isArchived ? <TodoActionButton onClick={() => update({ expectedRevision: todo.revision, archived: true })}><Archive size={12} />Archive</TodoActionButton> : <TodoActionButton onClick={() => update({ expectedRevision: todo.revision, archived: false })}><RotateCcw size={12} />Restore</TodoActionButton>}</div>{rejecting ? <div className="mt-3 border-y border-warning/30 bg-warning-muted p-3"><textarea autoFocus aria-label="Rejection reason" rows={2} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why should this Todo be rejected?" className="w-full resize-none bg-transparent text-[12px] outline-none" /><div className="mt-2 flex justify-end gap-2"><TodoActionButton onClick={() => setRejecting(false)}>Cancel</TodoActionButton><TodoActionButton variant="danger" onClick={reject}>Reject Todo</TodoActionButton></div></div> : null}</section></div></div>{actionError ? <p role="alert" className="shrink-0 border-t border-error/20 bg-error-muted px-5 py-3 text-[11px] text-error">{actionError}</p> : null}</>;
}

function AssociatedSessions({ slug, sessions }: { slug: string; sessions: SessionSummary[] }) { return sessions.length ? <div className="space-y-2">{sessions.map((session) => <Link key={session.sessionId} className="flex items-center justify-between gap-3 text-[12px] text-brand hover:underline" to={`/projects/${slug}/sessions/${session.sessionId}`}><span className="truncate">{session.title || session.sessionId}</span><span className="shrink-0 text-[11px] text-text-tertiary">{entryLabel(session.projectTodo?.entry)}</span></Link>)}</div> : <p className="text-[12px] text-text-tertiary">No sessions yet.</p>; }
function TodoActionButton({ children, onClick, disabled, variant = "default" }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; variant?: "default" | "primary" | "brand" | "danger" }) { const tone = variant === "primary" ? "bg-brand text-bg-overlay hover:bg-brand-hover" : variant === "brand" ? "border-brand/40 bg-brand-subtle text-brand hover:bg-brand/15" : variant === "danger" ? "border-error/30 bg-error-muted text-error hover:bg-error/15" : "border-border-default bg-bg-active text-text-secondary hover:bg-bg-hover hover:text-text-primary"; return <button type="button" onClick={onClick} disabled={disabled} className={`inline-flex h-8 items-center gap-1.5 rounded-sm border px-2.5 text-[12px] font-medium disabled:opacity-40 ${tone}`}>{children}</button>; }
function ViewButton({ children, active, onClick }: { children: React.ReactNode; active: boolean; onClick: () => void }) { return <button type="button" onClick={onClick} className={`h-7 rounded-md px-2.5 text-[11px] font-medium ${active ? "bg-bg-elevated text-text-primary shadow-sm" : "text-text-tertiary hover:text-text-secondary"}`}>{children}</button>; }
function entryLabel(entry?: "discussion" | "work" | "automation"): string { return entry === "discussion" ? "Discussion" : entry === "automation" ? "Automation setup" : "Work"; }
function labelForStatus(status: ProjectTodoLane): string { return status === "idea" ? "Ideas" : status === "ready" ? "Ready" : status === "in_progress" ? "In Progress" : "Done"; }
function isLane(value: string): value is ProjectTodoLane { return (LANES as readonly string[]).includes(value); }
function messageFor(cause: unknown): string { return cause instanceof Error ? cause.message : "Action failed"; }

export function createDragAnnouncements(order: BoardOrder, todoById: ReadonlyMap<string, ProjectTodo>) {
  const titleFor = (id: string | number) => todoById.get(String(id))?.title ?? "Todo";
  const describeTarget = (target: { lane: ProjectTodoLane; index: number } | undefined) => {
    if (!target) return undefined;
    const count = Math.max(1, order[target.lane].length, target.index + 1);
    return `${labelForStatus(target.lane)}, position ${target.index + 1} of ${count}`;
  };
  const targetFor = (overId: string | number) => {
    const id = String(overId);
    return describeTarget(isLane(id)
      ? { lane: id, index: order[id].length }
      : locateTodo(order, id));
  };
  return {
    onDragStart: ({ active }: { active: { id: string | number } }) => `Picked up ${titleFor(active.id)}.`,
    onDragOver: ({ active, over }: { active: { id: string | number }; over: { id: string | number } | null }) => {
      const target = over ? targetFor(over.id) : undefined;
      return target ? `Moving ${titleFor(active.id)} to ${target}.` : undefined;
    },
    onDragEnd: ({ active, over }: { active: { id: string | number }; over: { id: string | number } | null }) => {
      const target = describeTarget(locateTodo(order, String(active.id)))
        ?? (over ? targetFor(over.id) : undefined);
      return target ? `Dropped ${titleFor(active.id)} in ${target}.` : `Cancelled move for ${titleFor(active.id)}.`;
    },
    onDragCancel: ({ active }: { active: { id: string | number } }) => `Cancelled move for ${titleFor(active.id)}.`,
  };
}
