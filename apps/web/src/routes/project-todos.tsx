import { useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCorners,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
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
import { projectTodoContentExcerpt } from "@archcode/protocol";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { GripVertical, Plus, Search } from "lucide-react";
import { ApiError } from "../api/client";
import { useCreateProjectTodo, useRunProjectTodoNow, useUpdateProjectTodo } from "../api/mutations";
import { useAutomationInventory, useProjectTodos, useSessionInventory } from "../api/queries";
import type { ProjectTodo } from "../api/types";
import { createClientUuid } from "../lib/client-uuid";
import { STATUS_TONE_CLASS } from "../lib/status-visuals";
import { StatusGlyph } from "../components/primitives/StatusGlyph";
import { useAttentionVisibleScopedHitl, useHitlProjectInitialized } from "../store/hitl-store";
import { runtimeFamilyKey, useSessionRuntimeFamilies, useSessionRuntimeInitialized } from "../store/session-runtime-store";
import {
  deriveProjectTodoOperationalState,
  PROJECT_TODO_LANE_PRESENTATIONS,
  type ProjectTodoAttentionLabel,
  type ProjectTodoLane,
  type ProjectTodoOperationalState,
} from "./project-todo-presentation";

type View = "board" | "rejected" | "archived";
type BoardOrder = Record<ProjectTodoLane, string[]>;
const LANES: readonly ProjectTodoLane[] = ["idea", "ready", "in_progress", "done"];

interface ProjectTodoRunNowRecovery {
  readonly todoId: string;
  readonly sessionId?: string;
  readonly message: string;
}

export function projectTodoRunNowRecovery(cause: unknown): ProjectTodoRunNowRecovery | null {
  if (!(cause instanceof ApiError) || cause.details === null || typeof cause.details !== "object") return null;
  const details = cause.details as Record<string, unknown>;
  if (details.scopeCode !== "PROJECT_TODO_RUN_NOW_RECOVERY_REQUIRED" || typeof details.todoId !== "string") return null;
  return {
    todoId: details.todoId,
    ...(typeof details.sessionId === "string" ? { sessionId: details.sessionId } : {}),
    message: cause.message,
  };
}

export function todoFlatListEmptyMessage(view: Exclude<View, "board">, filtered: boolean): string {
  const label = view === "rejected" ? "rejected" : "archived";
  return filtered ? `No ${label} Todos match this filter.` : `No ${label} Todos yet.`;
}

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

/**
 * Pointer and touch drags target what the user is actually pointing at.
 * Keyboard drags have no pointer coordinates, so they retain geometric
 * collision detection.
 */
export const pointerFirstCollisionDetection: CollisionDetection = (args) => {
  return args.pointerCoordinates === null
    ? closestCorners(args)
    : pointerWithin(args);
};

export function ProjectTodosRoute() {
  const { slug = "" } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: todos = [], isLoading, error } = useProjectTodos(slug);
  const sessionInventory = useSessionInventory(slug);
  const automationInventory = useAutomationInventory(slug);
  const sessions = useMemo(() => (sessionInventory.data ?? []).map((item) => item.session), [sessionInventory.data]);
  const automations = useMemo(() => (automationInventory.data ?? []).map((item) => item.automation), [automationInventory.data]);
  const runtimeFamilies = useSessionRuntimeFamilies();
  const runtimeInitialized = useSessionRuntimeInitialized(slug);
  const attention = useAttentionVisibleScopedHitl([slug]);
  const hitlInitialized = useHitlProjectInitialized(slug);
  const createTodo = useCreateProjectTodo();
  const runNow = useRunProjectTodoNow();
  const updateTodo = useUpdateProjectTodo();
  const requestedView = searchParams.get("view");
  const view: View = requestedView === "rejected" || requestedView === "archived" ? requestedView : "board";
  const query = searchParams.get("q") ?? "";
  const [newContent, setNewContent] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [runNowRecovery, setRunNowRecovery] = useState<ProjectTodoRunNowRecovery | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [temporaryOrder, setTemporaryOrder] = useState<BoardOrder | null>(null);
  const [reorderError, setReorderError] = useState<string | null>(null);
  const runNowRequestRef = useRef<{ requestId: string; content: string } | null>(null);
  const boardScrollRef = useRef<HTMLDivElement>(null);
  const scrollStorageKey = `archcode.todo-board-scroll:${slug}:${searchParams.get("view") ?? "board"}:${searchParams.get("q") ?? ""}`;
  useEffect(() => {
    const saved = window.sessionStorage.getItem(scrollStorageKey);
    if (saved !== null && boardScrollRef.current !== null) boardScrollRef.current.scrollTop = Number(saved) || 0;
  }, [scrollStorageKey]);
  const filteredTodos = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return todos;
    return todos.filter((todo) => {
      const linkedSessions = sessions.filter((session) => session.source?.kind === "todo" && session.source.todoId === todo.id);
      const linkedAutomations = automations.filter((automation) => automation.origin.kind === "todo" && automation.origin.todoId === todo.id);
      return [todo.id, todo.content, ...linkedSessions.map((session) => session.title ?? session.sessionId), ...linkedAutomations.map((automation) => automation.name)]
        .some((value) => value.toLocaleLowerCase().includes(needle));
    });
  }, [automations, query, sessions, todos]);
  const canonicalOrder = useMemo(() => deriveBoardOrder(filteredTodos), [filteredTodos]);
  const boardOrder = temporaryOrder ?? canonicalOrder;
  const todoById = useMemo(() => new Map(filteredTodos.map((todo) => [todo.id, todo])), [filteredTodos]);
  const activityBySessionId = useMemo(() => new Map((sessionInventory.data ?? []).map(({ session }) => [
    session.sessionId,
    runtimeFamilies[runtimeFamilyKey(slug, session.sessionId)]?.activity ?? "idle",
  ])), [runtimeFamilies, sessionInventory.data, slug]);
  const attentionBySessionId = useMemo(() => {
    const labels = new Map<string, ProjectTodoAttentionLabel>();
    for (const entry of attention) {
      const label = entry.view.requiresInspection === true
        ? "Inspection"
        : entry.view.source.type === "tool_permission" ? "Permission" : "Question";
      if (label === "Inspection" || label === "Permission" || !labels.has(entry.rootSessionId)) {
        labels.set(entry.rootSessionId, label);
      }
    }
    return labels;
  }, [attention]);
  const operationalStateByTodoId = useMemo(() => {
    const authoritative = sessionInventory.isSuccess
      && automationInventory.isSuccess
      && runtimeInitialized
      && hitlInitialized;
    return new Map(todos.flatMap((todo) => {
      const state = deriveProjectTodoOperationalState({
        todo,
        sessions: sessionInventory.data ?? [],
        automations: automationInventory.data ?? [],
        activityBySessionId,
        attentionBySessionId,
        authoritative,
      });
      return state === undefined ? [] : [[todo.id, state] as const];
    }));
  }, [activityBySessionId, attentionBySessionId, automationInventory.data, automationInventory.isSuccess, hitlInitialized, runtimeInitialized, sessionInventory.data, sessionInventory.isSuccess, todos]);
  const announcements = useMemo(() => createDragAnnouncements(boardOrder, todoById), [boardOrder, todoById]);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const selectTodo = (id: string) => {
    window.sessionStorage.setItem(scrollStorageKey, String(boardScrollRef.current?.scrollTop ?? 0));
    navigate(`/projects/${encodeURIComponent(slug)}/todos/${encodeURIComponent(id)}`, { state: { fromTodos: true } });
  };

  const setView = (nextView: View) => {
    const next = new URLSearchParams(searchParams);
    if (nextView === "board") next.delete("view");
    else next.set("view", nextView);
    setSearchParams(next, { replace: true });
  };

  const setQuery = (value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set("q", value);
    else next.delete("q");
    setSearchParams(next, { replace: true });
  };

  const create = () => {
    const content = newContent.trim();
    if (!content) {
      setCreateError("Todo content is required");
      return;
    }
    setCreateError(null);
    createTodo.mutate({ slug, input: { content } }, {
      onSuccess: ({ todo }) => {
        setNewContent("");
        navigate(`/projects/${encodeURIComponent(slug)}/todos/${encodeURIComponent(todo.id)}`, { state: { fromTodos: true } });
      },
      onError: (cause) => setCreateError(messageFor(cause)),
    });
  };

  const run = () => {
    const content = newContent.trim();
    if (!content) {
      setCreateError("Todo content is required");
      return;
    }
    const previous = runNowRequestRef.current;
    const requestId = previous?.content === content ? previous.requestId : createClientUuid();
    runNowRequestRef.current = { requestId, content };
    setCreateError(null);
    runNow.mutate({ slug, clientRequestId: requestId, content }, {
      onSuccess: ({ session }) => {
        runNowRequestRef.current = null;
        setRunNowRecovery(null);
        setNewContent("");
        navigate(`/projects/${slug}/sessions/${session.sessionId}`);
      },
      onError: (cause) => {
        const recovery = projectTodoRunNowRecovery(cause);
        if (recovery !== null) {
          runNowRequestRef.current = null;
          setCreateError(null);
          setRunNowRecovery(recovery);
          return;
        }
        setCreateError(messageFor(cause));
      },
    });
  };

  const resetCaptureFailure = () => {
    setCreateError(null);
    setRunNowRecovery(null);
    runNowRequestRef.current = null;
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
    ? filteredTodos.filter((todo) => todo.archivedAt !== undefined)
    : view === "rejected"
      ? filteredTodos.filter((todo) => todo.archivedAt === undefined && todo.status === "rejected")
      : [];

  return (
    <div className="flex h-full flex-col overflow-hidden bg-bg-base">
      <header className="flex min-h-14 shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border-default bg-bg-surface px-4 py-2 min-[621px]:px-6">
        <label className="relative min-w-[220px] flex-1 max-w-[520px]">
          <span className="sr-only">Filter Todos</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" size={14} aria-hidden="true" />
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter Todos…" className="h-9 w-full rounded-sm border border-control-border bg-bg-elevated pl-9 pr-3 text-[13px] outline-none focus:border-brand focus:ring-2 focus:ring-brand-subtle [@media(pointer:coarse)]:h-11" />
        </label>
        <div className="flex items-center rounded-md border border-border-default bg-bg-muted p-0.5" role="group" aria-label="Todo views">
          <ViewButton active={view === "board"} onClick={() => setView("board")}>Board</ViewButton>
          <ViewButton active={view === "rejected"} onClick={() => setView("rejected")}>Rejected</ViewButton>
          <ViewButton active={view === "archived"} onClick={() => setView("archived")}>Archived</ViewButton>
        </div>
      </header>
      <div className="shrink-0 px-4 pt-4 min-[621px]:px-6">
        <div className="mx-auto flex max-w-[1500px] flex-wrap gap-2 rounded-lg border border-border-control bg-bg-elevated p-2.5 shadow-sm focus-within:border-brand focus-within:ring-2 focus-within:ring-brand-subtle">
          <Plus size={15} className="shrink-0 self-center text-text-tertiary" aria-hidden="true" />
          <textarea aria-label="New Todo content" rows={2} value={newContent} onChange={(event) => { setNewContent(event.target.value); resetCaptureFailure(); }} placeholder="Capture an idea, bug, feature, or paste a PRD…" className="min-h-12 min-w-0 flex-1 resize-y bg-transparent px-1 py-1 text-[13px] leading-5 text-text-primary outline-none placeholder:text-text-muted max-[620px]:basis-[calc(100%-24px)]" />
          <div className="ml-auto flex gap-2 max-[620px]:basis-full max-[620px]:grid max-[620px]:grid-cols-2">
            <button type="button" onClick={create} disabled={createTodo.isPending || runNow.isPending || runNowRecovery !== null} className="h-8 rounded-sm border border-border-default bg-bg-active px-3 text-[12px] font-medium text-text-secondary hover:bg-bg-hover disabled:opacity-40 max-[620px]:h-11 [@media(pointer:coarse)]:h-11">Save</button>
            <button type="button" onClick={run} disabled={createTodo.isPending || runNow.isPending || runNowRecovery !== null} className="h-8 rounded-sm bg-brand px-3 text-[12px] font-medium text-brand-ink hover:bg-brand-hover disabled:opacity-40 max-[620px]:h-11 [@media(pointer:coarse)]:h-11">{runNow.isPending ? "Starting…" : "Run now"}</button>
          </div>
        </div>
        {createError ? <p role="alert" className="mx-auto mt-1 max-w-[1500px] text-[11px] text-error">{createError}</p> : null}
        {runNowRecovery ? (
          <div role="alert" className="mx-auto mt-2 max-w-[1500px] border-l-2 border-error bg-error-muted px-3 py-2 text-[11px] leading-5 text-error">
            <p>{runNowRecovery.message} Do not retry this unchanged request; inspect the retained work first.</p>
            <div className="flex flex-wrap gap-x-3">
              <Link className="font-medium underline" to={`/projects/${encodeURIComponent(slug)}/todos/${encodeURIComponent(runNowRecovery.todoId)}`}>Open Todo {runNowRecovery.todoId}</Link>
              {runNowRecovery.sessionId ? <Link className="font-medium underline" to={`/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(runNowRecovery.sessionId)}`}>Open Session {runNowRecovery.sessionId}</Link> : null}
            </div>
            <p>Edit the Todo content before starting a different request.</p>
          </div>
        ) : null}
      </div>
      <div ref={boardScrollRef} className="min-h-0 flex-1 overflow-auto px-4 py-4 min-[621px]:px-6">
        {view === "board" ? (
          <DndContext sensors={sensors} collisionDetection={pointerFirstCollisionDetection} onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd} onDragCancel={onDragCancel} accessibility={{ announcements }}>
            <div className={`mx-auto grid max-w-[1500px] grid-cols-1 gap-3 min-[700px]:grid-cols-2 min-[1100px]:grid-cols-4 ${draggedId ? "cursor-grabbing [&_*]:cursor-grabbing" : ""}`} data-testid="todo-board">
              {LANES.map((lane) => <TodoLane key={lane} lane={lane} order={boardOrder[lane]} todoById={todoById} operationalStateByTodoId={operationalStateByTodoId} onSelect={selectTodo} />)}
            </div>
            <DragOverlay dropAnimation={null}>{draggedId ? <DragPreview todo={todoById.get(draggedId)} /> : null}</DragOverlay>
          </DndContext>
        ) : <TodoFlatList view={view} todos={visibleTodos} onSelect={selectTodo} filtered={query.trim().length > 0} />}
      </div>
      {reorderError ? <p role="alert" className="shrink-0 border-t border-error/20 bg-error-muted px-5 py-3 text-[11px] text-error">Could not move Todo: {reorderError}</p> : null}
    </div>
  );
}

function TodoLane({ lane, order, todoById, operationalStateByTodoId, onSelect }: { lane: ProjectTodoLane; order: string[]; todoById: Map<string, ProjectTodo>; operationalStateByTodoId: ReadonlyMap<string, ProjectTodoOperationalState>; onSelect: (id: string) => void }) {
  const presentation = PROJECT_TODO_LANE_PRESENTATIONS[lane];
  const { Icon } = presentation;
  const { setNodeRef } = useDroppable({ id: lane, data: { type: "lane", lane } });
  return <section ref={setNodeRef} className="min-h-40 rounded-lg border border-border-default bg-bg-surface p-3 min-[1100px]:min-h-[500px]" aria-label={presentation.title} data-testid={`todo-lane-${lane}`}>
    <header className="flex min-h-11 items-center justify-between gap-2 border-b border-border-subtle pb-2"><div className="flex items-center gap-2"><Icon size={14} className={STATUS_TONE_CLASS[presentation.tone]} /><div><h2 className="text-[14px] font-semibold text-text-primary">{presentation.title}</h2><p className="text-[11px] text-text-tertiary">{presentation.hint}</p></div></div><span className="border border-border-default bg-bg-muted px-1.5 py-0.5 text-[11px] text-text-tertiary">{order.length}</span></header>
    <SortableContext items={order} strategy={verticalListSortingStrategy}><div className="mt-3 flex min-h-24 flex-col gap-2.5">{order.length ? order.map((id) => { const todo = todoById.get(id); return todo ? <SortableTodoCard key={id} todo={todo} operationalState={operationalStateByTodoId.get(id)} onSelect={() => onSelect(id)} /> : null; }) : <div className="flex min-h-24 flex-col items-center justify-center px-3 text-center"><p className="text-[11px] font-medium text-text-tertiary">{presentation.emptyTitle}</p><p className="mt-1 text-[11px] text-text-tertiary">{presentation.emptyHint}</p></div>}</div></SortableContext>
  </section>;
}

function SortableTodoCard({ todo, operationalState, onSelect }: { todo: ProjectTodo; operationalState?: ProjectTodoOperationalState; onSelect: () => void }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: todo.id, data: { type: "todo", todo } });
  const excerpt = projectTodoContentExcerpt(todo.content);
  return <article ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className={`overflow-hidden rounded-md border border-border-default bg-bg-elevated ${isDragging ? "opacity-35" : ""}`} data-testid={`todo-${todo.id}`}>
    <div className="flex min-h-11 items-stretch"><button ref={setActivatorNodeRef} type="button" className={`flex min-h-11 w-11 shrink-0 touch-none items-center justify-center border-r border-border-subtle text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand ${isDragging ? "cursor-grabbing bg-brand-subtle text-brand" : "cursor-grab active:cursor-grabbing"}`} aria-label={`Drag ${excerpt}`} {...attributes} {...listeners}><GripVertical size={16} /></button><button type="button" data-testid={`todo-open-${todo.id}`} className="min-w-0 flex-1 cursor-pointer px-2.5 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand" onClick={onSelect}><span className="line-clamp-2 text-[13px] font-medium leading-5 text-text-primary">{excerpt}</span>{operationalState ? <span className="mt-1.5 flex items-center gap-1.5 border-t border-border-subtle pt-1.5 text-[11px] leading-4 text-text-secondary" data-testid={`todo-operational-${todo.id}`}><StatusGlyph kind={operationalState.kind} size={12} /><span className="font-medium">{operationalState.label}</span>{operationalState.detail ? <span className="truncate text-text-tertiary">· {operationalState.detail}</span> : null}</span> : null}</button></div>
  </article>;
}

function DragPreview({ todo }: { todo?: ProjectTodo }) {
  if (!todo) return null;
  return <div className="w-64 cursor-grabbing rounded-md border border-brand bg-bg-elevated p-3 shadow-lg"><p className="line-clamp-2 text-[13px] font-medium leading-5 text-text-primary">{projectTodoContentExcerpt(todo.content)}</p></div>;
}

function TodoFlatList({ view, todos, onSelect, filtered }: { view: Exclude<View, "board">; todos: ProjectTodo[]; onSelect: (id: string) => void; filtered: boolean }) {
  const title = view === "rejected" ? "Rejected Todos" : "Archived Todos";
  return <section className="mx-auto max-w-[980px]" aria-label={title}><h2 className="border-b border-border-default pb-3 text-[14px] font-semibold text-text-primary">{title}</h2>{todos.length === 0 ? <p className="py-16 text-center text-[13px] text-text-tertiary">{todoFlatListEmptyMessage(view, filtered)}</p> : <div className="divide-y divide-border-subtle">{todos.map((todo) => <button key={todo.id} type="button" data-testid={`todo-${todo.id}`} onClick={() => onSelect(todo.id)} className="block w-full px-3 py-3 text-left hover:bg-bg-hover"><span className="line-clamp-2 text-[13px] font-medium leading-5 text-text-primary">{projectTodoContentExcerpt(todo.content)}</span><span className="mt-1 block text-[11px] text-text-tertiary">{view === "rejected" ? todo.rejectionReason : "Archived"}</span></button>)}</div>}</section>;
}

function ViewButton({ children, active, onClick }: { children: React.ReactNode; active: boolean; onClick: () => void }) { return <button type="button" onClick={onClick} className={`h-7 rounded-md px-2.5 text-[11px] font-medium [@media(pointer:coarse)]:h-11 ${active ? "bg-bg-elevated text-text-primary shadow-sm" : "text-text-tertiary hover:text-text-secondary"}`}>{children}</button>; }
function labelForStatus(status: ProjectTodoLane): string { return status === "idea" ? "Ideas" : status === "ready" ? "Ready" : status === "in_progress" ? "In Progress" : "Done"; }
function isLane(value: string): value is ProjectTodoLane { return (LANES as readonly string[]).includes(value); }
function messageFor(cause: unknown): string { return cause instanceof Error ? cause.message : "Action failed"; }

export function createDragAnnouncements(order: BoardOrder, todoById: ReadonlyMap<string, ProjectTodo>) {
  const titleFor = (id: string | number) => {
    const todo = todoById.get(String(id));
    return todo === undefined ? "Todo" : projectTodoContentExcerpt(todo.content);
  };
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
