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
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ChevronRight, Columns3, GripVertical, LayoutList, Search, X } from "lucide-react";
import { useCreateProjectTodoSession, useUpdateProjectTodo } from "../api/mutations";
import { useAutomationInventory, useProjectTodos, useSessionInventory } from "../api/queries";
import type { ProjectTodo, SessionSummary } from "../api/types";
import { STATUS_TONE_CLASS, type StatusTone } from "../lib/status-visuals";
import { RelativeTime } from "../components/primitives/TemporalText";
import { hitlAttentionLabelsByRootSession, useAttentionVisibleScopedHitl, useHitlProjectInitialized } from "../store/hitl-store";
import { runtimeFamilyKey, useSessionRuntimeFamilies, useSessionRuntimeInitialized } from "../store/session-runtime-store";
import {
  deriveProjectTodoOperationalState,
  presentProjectTodoCard,
  projectTodoDisplayLead,
  projectTodoPreviewExcerpt,
  PROJECT_TODO_LANE_PRESENTATIONS,
  type ProjectTodoLane,
  type ProjectTodoOperationalState,
  type ProjectTodoStatus,
} from "./project-todo-presentation";

type TodoSurface = "active" | "rejected" | "archived";
type ActiveLayout = "list" | "board";
type BoardOrder = Record<ProjectTodoLane, string[]>;
const LANES: readonly ProjectTodoLane[] = ["idea", "ready", "in_progress", "done"];

export function todoFlatListEmptyMessage(view: Exclude<TodoSurface, "active">, filtered: boolean): string {
  return filtered ? `No ${view} Todos match this filter.` : `No ${view} Todos yet.`;
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

/** Pointer/touch follows the pointer; keyboard dragging retains geometric fallback. */
export const pointerFirstCollisionDetection: CollisionDetection = (args) => (
  args.pointerCoordinates === null ? closestCorners(args) : pointerWithin(args)
);

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
  const createSession = useCreateProjectTodoSession();
  const updateTodo = useUpdateProjectTodo();

  const requestedSurface = searchParams.get("surface");
  const surface: TodoSurface = requestedSurface === "rejected" || requestedSurface === "archived" ? requestedSurface : "active";
  const layout: ActiveLayout = searchParams.get("layout") === "board" ? "board" : "list";
  const query = searchParams.get("q") ?? "";
  const focusedTodoId = searchParams.get("focus");
  const [selectedTodoId, setSelectedTodoId] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [temporaryOrder, setTemporaryOrder] = useState<BoardOrder | null>(null);
  const [reorderError, setReorderError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const originFocusRef = useRef<HTMLElement | null>(null);
  const modalOpenRef = useRef(false);
  const itemRefs = useRef(new Map<string, HTMLButtonElement>());
  const scrollStorageKey = `archcode.todo-inventory-scroll:${slug}`;

  const activityBySessionId = useMemo(() => new Map((sessionInventory.data ?? []).map(({ session }) => [
    session.sessionId,
    runtimeFamilies[runtimeFamilyKey(slug, session.sessionId)]?.activity ?? "idle",
  ])), [runtimeFamilies, sessionInventory.data, slug]);
  const attentionBySessionId = useMemo(() => hitlAttentionLabelsByRootSession(attention), [attention]);
  const operationalStateByTodoId = useMemo(() => {
    const authoritative = sessionInventory.isSuccess && automationInventory.isSuccess && runtimeInitialized && hitlInitialized;
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
  const filteredTodos = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return todos;
    return todos.filter((todo) => {
      const linkedSessions = sessions.filter((session) => session.source?.kind === "todo" && session.source.todoId === todo.id);
      const linkedAutomations = automations.filter((automation) => automation.origin.kind === "todo" && automation.origin.todoId === todo.id);
      const operational = operationalStateByTodoId.get(todo.id);
      return [
        todo.id,
        todo.content,
        operational?.label ?? "",
        operational?.detail ?? "",
        ...linkedSessions.map((session) => session.title ?? session.sessionId),
        ...linkedAutomations.map((automation) => automation.name),
      ].some((value) => value.toLocaleLowerCase().includes(needle));
    });
  }, [automations, operationalStateByTodoId, query, sessions, todos]);
  const activeTodos = useMemo(() => filteredTodos.filter((todo) => todo.archivedAt === undefined && todo.status !== "rejected"), [filteredTodos]);
  const groups = useMemo(() => deriveProjectTodoGroups(activeTodos), [activeTodos]);
  const canonicalOrder = useMemo(() => deriveBoardOrder(activeTodos), [activeTodos]);
  const boardOrder = temporaryOrder ?? canonicalOrder;
  const todoById = useMemo(() => new Map(todos.map((todo) => [todo.id, todo])), [todos]);
  const filteredTodoById = useMemo(() => new Map(activeTodos.map((todo) => [todo.id, todo])), [activeTodos]);
  const selectedTodo = selectedTodoId === null ? undefined : todoById.get(selectedTodoId);
  modalOpenRef.current = selectedTodo !== undefined;
  const announcements = useMemo(() => createDragAnnouncements(boardOrder, filteredTodoById), [boardOrder, filteredTodoById]);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const updateUrl = (change: { surface?: TodoSurface; layout?: ActiveLayout; query?: string; focus?: string | null }) => {
    const next = new URLSearchParams(searchParams);
    if (change.surface !== undefined) change.surface === "active" ? next.delete("surface") : next.set("surface", change.surface);
    if (change.layout !== undefined) change.layout === "list" ? next.delete("layout") : next.set("layout", change.layout);
    if (change.query !== undefined) change.query ? next.set("q", change.query) : next.delete("q");
    if (change.focus !== undefined) change.focus ? next.set("focus", change.focus) : next.delete("focus");
    setSearchParams(next, { replace: true });
  };

  useEffect(() => {
    const saved = window.sessionStorage.getItem(scrollStorageKey);
    if (saved !== null && scrollRef.current !== null) scrollRef.current.scrollTop = Number(saved) || 0;
    return () => window.sessionStorage.setItem(scrollStorageKey, String(scrollRef.current?.scrollTop ?? 0));
  }, [scrollStorageKey]);
  useEffect(() => {
    if (focusedTodoId === null) return;
    requestAnimationFrame(() => {
      if (!modalOpenRef.current) itemRefs.current.get(focusedTodoId)?.focus({ preventScroll: true });
    });
  }, [focusedTodoId, layout, surface]);
  const closePreview = (restoreFocus = true) => {
    if (selectedTodoId === null) return;
    setSelectedTodoId(null);
    if (restoreFocus) requestAnimationFrame(() => originFocusRef.current?.focus());
  };
  const openDetails = (todoId: string) => {
    window.sessionStorage.setItem(scrollStorageKey, String(scrollRef.current?.scrollTop ?? 0));
    navigate(`/projects/${encodeURIComponent(slug)}/todos/${encodeURIComponent(todoId)}`, { state: { fromTodos: true } });
  };
  const selectTodo = (todoId: string, trigger: HTMLElement) => {
    updateUrl({ focus: todoId });
    if (surface !== "active" || window.matchMedia("(max-width: 720px)").matches) {
      openDetails(todoId);
      return;
    }
    originFocusRef.current = trigger;
    setSelectedTodoId(todoId);
  };
  const sessionsFor = (todoId: string, entry?: "discussion" | "work") => sessions
    .filter((session) => session.source?.kind === "todo" && session.source.todoId === todoId && (entry === undefined || session.source.entry === entry))
    .sort(compareSessionUpdated);
  const startEntry = (todo: ProjectTodo, entry: "discussion" | "work") => {
    setCreateError(null);
    createSession.mutate({ slug, todoId: todo.id, input: { expectedRevision: todo.revision, entry } }, {
      onSuccess: ({ sessionId }) => navigate(`/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sessionId)}`),
      onError: (cause) => setCreateError(messageFor(cause)),
    });
  };
  const continueWork = (todo: ProjectTodo, sessionId: string) => {
    const go = () => navigate(`/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sessionId)}`);
    if (todo.status === "ready") {
      updateTodo.mutate({ slug, todoId: todo.id, input: { expectedRevision: todo.revision, status: "in_progress" } }, { onSuccess: go, onError: (cause) => setCreateError(messageFor(cause)) });
    } else go();
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && selectedTodoId !== null) {
        event.preventDefault();
        closePreview();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const resolveDrop = (overId: string | null): { lane: ProjectTodoLane; index: number } | undefined => {
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
    const destination = resolveDrop(over ? String(over.id) : null);
    if (destination) setTemporaryOrder((previous) => moveTodoInBoard(previous ?? canonicalOrder, todoId, destination.lane, destination.index));
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    const todoId = String(active.id);
    const todo = filteredTodoById.get(todoId);
    const destination = resolveDrop(over ? String(over.id) : null);
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
    const positionChanged = canonicalOrder[result.lane].indexOf(todoId) !== result.index || stateChanged;
    if (!positionChanged) {
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

  if (isLoading) return <div className="flex h-full items-center justify-center text-sm text-text-tertiary">Loading Todos…</div>;
  if (error) return <div className="flex h-full items-center justify-center text-sm text-error">Failed to load Todos</div>;

  const flatTodos = surface === "archived"
    ? filteredTodos.filter((todo) => todo.archivedAt !== undefined)
    : filteredTodos.filter((todo) => todo.archivedAt === undefined && todo.status === "rejected");

  return (
    <div className="relative flex h-full min-w-0 flex-col overflow-hidden bg-bg-base">
      <header className="flex h-[54px] shrink-0 items-center gap-2 border-b border-border-default bg-bg-surface py-[7px] pl-[51px] pr-[9px] min-[721px]:h-[58px] min-[721px]:pl-[66px] min-[721px]:pr-4 min-[981px]:px-[18px]">
        <div className="min-w-0">
          <p className="text-[10.5px] font-medium uppercase leading-[1.2] tracking-[0.08em] text-text-tertiary">Work</p>
          <div className="mt-0.5 flex min-w-0 items-center gap-2">
            <h1 className="truncate text-[17.5px] font-bold leading-[1.3] tracking-[-0.022em] text-text-primary">All todos</h1>
            <span className="rounded-full bg-bg-muted px-2 py-0.5 font-mono text-[10px] tabular-nums text-text-tertiary">{todos.length}</span>
          </div>
        </div>
      </header>
      <div className="flex shrink-0 flex-col items-stretch gap-[14px] border-b border-border-default bg-bg-surface px-3 pb-[14px] pt-[18px] min-[721px]:px-5 min-[721px]:pt-7 min-[981px]:flex-row min-[981px]:items-start min-[981px]:justify-between">
        <div className="flex min-w-0 items-center gap-2">
          <label className="group flex h-11 w-full max-w-none min-w-0 items-center gap-2 rounded-sm border border-border-subtle bg-[color-mix(in_srgb,var(--bg-base)_82%,var(--bg-surface))] py-0 pl-3 pr-1 text-text-tertiary shadow-[inset_0_1px_0_rgb(255_255_255/3%)] transition-[border-color,background-color,box-shadow] duration-[var(--motion-fast)] hover:border-border-default hover:bg-bg-elevated focus-within:border-brand focus-within:bg-bg-elevated focus-within:[box-shadow:var(--focus)] min-[721px]:h-[38px] min-[721px]:max-w-[430px] min-[981px]:w-[430px] min-[981px]:flex-none">
            <Search className="shrink-0 transition-colors duration-[var(--motion-fast)] group-focus-within:text-brand" size={14} aria-hidden="true" />
            <span className="sr-only">Filter Todos</span>
            <input type="search" value={query} onChange={(event) => updateUrl({ query: event.target.value, focus: null })} placeholder="Filter todos…" autoComplete="off" spellCheck={false} className="h-full min-w-0 flex-1 appearance-none border-0 bg-transparent px-0.5 text-[16px] text-text-primary outline-none placeholder:text-text-tertiary [&::-webkit-search-cancel-button]:appearance-none min-[721px]:text-[12px]" />
            {query ? <button type="button" aria-label="Clear Todo filter" onClick={() => updateUrl({ query: "", focus: null })} className="grid h-7 w-7 shrink-0 place-items-center rounded-sm text-text-tertiary hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:[box-shadow:var(--focus)]"><X size={12} aria-hidden="true" /></button> : null}
          </label>
          <div className="flex h-10 shrink-0 items-center gap-0.5 rounded-sm border border-border-subtle bg-bg-surface p-[3px] [@media(pointer:coarse)]:!h-[46px]" role="group" aria-label="Active layout">
            <IconToggle label="List layout" active={layout === "list"} disabled={surface !== "active"} onClick={() => updateUrl({ layout: "list" })}><LayoutList size={14} /></IconToggle>
            <IconToggle label="Board layout" active={layout === "board"} disabled={surface !== "active"} onClick={() => updateUrl({ layout: "board" })}><Columns3 size={14} /></IconToggle>
          </div>
        </div>
        <div className="flex w-full items-center gap-2 min-[981px]:w-auto">
          <div className="grid h-[46px] min-w-0 flex-1 grid-cols-3 rounded-sm border border-border-default bg-bg-muted p-[3px] min-[721px]:h-[38px] min-[981px]:w-[228px] min-[981px]:flex-none" role="group" aria-label="Todo surfaces">
            <SegmentButton active={surface === "active"} onClick={() => { closePreview(); updateUrl({ surface: "active" }); }}>Active</SegmentButton>
            <SegmentButton active={surface === "rejected"} onClick={() => { closePreview(); updateUrl({ surface: "rejected" }); }}>Rejected</SegmentButton>
            <SegmentButton active={surface === "archived"} onClick={() => { closePreview(); updateUrl({ surface: "archived" }); }}>Archived</SegmentButton>
          </div>
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} className="h-full overflow-auto px-3 pb-16 pt-[22px] min-[721px]:px-5">
          {surface === "active" && activeTodos.length === 0 ? <EmptyFilter filtered={query.trim().length > 0} /> : null}
          {surface === "active" && layout === "list" && activeTodos.length > 0 ? (
            <ActiveTodoList groups={groups} operationalStateByTodoId={operationalStateByTodoId} focusedTodoId={focusedTodoId} selectedTodoId={selectedTodoId} itemRefs={itemRefs} onSelect={selectTodo} />
          ) : null}
          {surface === "active" && layout === "board" && activeTodos.length > 0 ? (
            <DndContext sensors={sensors} collisionDetection={pointerFirstCollisionDetection} onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd} onDragCancel={() => { setDraggedId(null); setTemporaryOrder(null); }} accessibility={{ announcements }}>
              <div className={`mx-auto grid w-full min-h-[360px] min-w-0 max-w-[1500px] grid-flow-col auto-cols-[min(240px,82vw)] grid-cols-none items-stretch gap-3 overflow-x-auto pb-[18px] min-[721px]:min-h-[max(420px,calc(100dvh-226px))] min-[721px]:grid-flow-row min-[721px]:auto-cols-auto min-[721px]:grid-cols-2 min-[721px]:overflow-x-visible min-[761px]:min-h-[max(420px,calc(100dvh-174px))] min-[1261px]:grid-cols-4 ${draggedId ? "cursor-grabbing [&_*]:cursor-grabbing" : ""}`} data-testid="todo-board">
                {LANES.map((lane) => <TodoLane key={lane} lane={lane} order={boardOrder[lane]} todoById={filteredTodoById} operationalStateByTodoId={operationalStateByTodoId} focusedTodoId={focusedTodoId} selectedTodoId={selectedTodoId} itemRefs={itemRefs} onSelect={selectTodo} />)}
              </div>
              <DragOverlay dropAnimation={null}>{draggedId ? <DragPreview todo={filteredTodoById.get(draggedId)} /> : null}</DragOverlay>
            </DndContext>
          ) : null}
          {surface !== "active" ? <TodoFlatList view={surface} todos={flatTodos} filtered={query.trim().length > 0} slug={slug} updateTodo={updateTodo} onSelect={selectTodo} /> : null}
        </div>
        {selectedTodo ? <TodoPreview key={selectedTodo.id} todo={selectedTodo} slug={slug} operationalState={operationalStateByTodoId.get(selectedTodo.id)} sessions={sessionsFor(selectedTodo.id)} onClose={closePreview} onOpenDetails={() => openDetails(selectedTodo.id)} onOpenSession={(sessionId) => navigate(`/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sessionId)}`)} onStart={startEntry} onContinueWork={continueWork} /> : null}
      </div>
      {createError ? <p role="alert" className="shrink-0 border-t border-error/20 bg-error-muted px-5 py-3 text-[11px] text-error">{createError}</p> : null}
      {reorderError ? <p role="alert" className="shrink-0 border-t border-error/20 bg-error-muted px-5 py-3 text-[11px] text-error">Could not move Todo: {reorderError}</p> : null}
    </div>
  );
}

function ActiveTodoList({ groups, operationalStateByTodoId, focusedTodoId, selectedTodoId, itemRefs, onSelect }: {
  groups: Record<ProjectTodoLane, ProjectTodo[]>;
  operationalStateByTodoId: ReadonlyMap<string, ProjectTodoOperationalState>;
  focusedTodoId: string | null;
  selectedTodoId: string | null;
  itemRefs: React.MutableRefObject<Map<string, HTMLButtonElement>>;
  onSelect: (id: string, trigger: HTMLElement) => void;
}) {
  return <div className="grid w-full gap-[26px]" data-testid="todo-active-list">{LANES.map((lane) => {
    const presentation = PROJECT_TODO_LANE_PRESENTATIONS[lane];
    return <section key={lane} aria-labelledby={`todo-list-${lane}`}>
      <header className="flex min-h-[29px] items-center gap-2 border-b border-border-subtle px-[7px] pb-2 text-[10.5px] font-bold uppercase tracking-[0.08em] text-text-tertiary"><span className={`h-1.5 w-1.5 shrink-0 rounded-full ${lane === "ready" ? "bg-brand" : lane === "in_progress" ? "bg-signal" : lane === "done" ? "bg-success" : "bg-text-muted"}`} aria-hidden="true" /><h2 id={`todo-list-${lane}`} className="text-inherit">{presentation.title}</h2><span className="font-mono text-[10.5px] font-medium tabular-nums text-text-muted">{groups[lane].length}</span></header>
      <div className="divide-y divide-border-subtle">{groups[lane].length ? groups[lane].map((todo) => <TodoListRow key={todo.id} todo={todo} operationalState={operationalStateByTodoId.get(todo.id)} focused={focusedTodoId === todo.id} selected={selectedTodoId === todo.id} itemRefs={itemRefs} onSelect={onSelect} />) : <p className="px-8 py-4 text-[11px] text-text-tertiary">{presentation.emptyTitle}</p>}</div>
    </section>;
  })}</div>;
}

function TodoListRow({ todo, operationalState, focused, selected, itemRefs, onSelect }: {
  todo: ProjectTodo;
  operationalState?: ProjectTodoOperationalState;
  focused: boolean;
  selected: boolean;
  itemRefs: React.MutableRefObject<Map<string, HTMLButtonElement>>;
  onSelect: (id: string, trigger: HTMLElement) => void;
}) {
  const presentation = PROJECT_TODO_LANE_PRESENTATIONS[todo.status as ProjectTodoLane];
  const { Icon } = presentation;
  const featured = operationalState?.kind === "running";
  return <button ref={(node) => { node ? itemRefs.current.set(todo.id, node) : itemRefs.current.delete(todo.id); }} type="button" data-testid={`todo-open-${todo.id}`} onClick={(event) => onSelect(todo.id, event.currentTarget)} className={`workbench-row-lift grid min-h-[66px] w-full grid-cols-[30px_minmax(0,1fr)_14px] items-center gap-3 px-2 py-2.5 text-left transition-[background-color,border-color,box-shadow,transform] duration-[var(--motion-fast)] hover:bg-bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand ${featured ? "my-[5px] rounded-[8px] border border-border-strong bg-[linear-gradient(90deg,color-mix(in_srgb,var(--brand)_6%,var(--bg-surface)),transparent_72%)] px-2.5 shadow-[inset_2px_0_0_var(--brand)]" : "border-b border-border-subtle"} ${focused || selected ? "bg-selection-field shadow-[inset_2px_0_0_var(--brand)]" : ""}`}>
    <span className={`grid h-[27px] w-[27px] place-items-center rounded-[7px] border shadow-[inset_0_1px_0_rgb(255_255_255/3%)] ${todoListOrbitClass(todo.status as ProjectTodoLane, operationalState)}`}><Icon size={12} aria-hidden="true" /></span>
    <span className="min-w-0"><span className="block truncate text-[13.5px] font-semibold leading-[1.35] text-text-primary">{projectTodoDisplayLead(todo.content)}</span><span className="mt-1 flex min-w-0 flex-wrap items-center gap-2 text-[11.5px] leading-[1.35] tracking-normal text-text-muted"><span>Updated&nbsp;<RelativeTime timestamp={todo.updatedAt} style="short" /></span>{operationalState ? <OperationalLine state={operationalState} todoId={todo.id} compact /> : null}</span></span>
    <ChevronRight size={13} className="text-text-muted" aria-hidden="true" />
  </button>;
}

function todoListOrbitClass(lane: ProjectTodoLane, state?: ProjectTodoOperationalState): string {
  if (state?.kind === "needs_you") return "border-[color:color-mix(in_srgb,var(--warning)_30%,var(--border-subtle))] bg-[linear-gradient(160deg,var(--warning-field),color-mix(in_srgb,var(--warning-field)_78%,var(--bg-muted)))] text-warning";
  if (state?.kind === "running") return "border-[color:color-mix(in_srgb,var(--signal)_28%,var(--border-subtle))] bg-[linear-gradient(160deg,var(--signal-field),color-mix(in_srgb,var(--signal-field)_78%,var(--bg-muted)))] text-signal-foreground";
  if (state?.kind === "failed") return "border-[color:color-mix(in_srgb,var(--error)_28%,var(--border-subtle))] bg-error-field text-error";
  if (state?.kind === "completed" || lane === "ready") return "border-[color:color-mix(in_srgb,var(--brand)_24%,var(--border-subtle))] bg-[linear-gradient(160deg,var(--brand-field),color-mix(in_srgb,var(--brand-field)_78%,var(--bg-muted)))] text-brand";
  if (lane === "done") return "border-[color:color-mix(in_srgb,var(--success)_24%,var(--border-subtle))] bg-[linear-gradient(160deg,var(--success-field),color-mix(in_srgb,var(--success-field)_78%,var(--bg-muted)))] text-success";
  return "border-border-subtle bg-[linear-gradient(160deg,color-mix(in_srgb,var(--bg-elevated)_62%,var(--bg-muted)),var(--bg-muted))] text-text-tertiary";
}

function TodoLane({ lane, order, todoById, operationalStateByTodoId, focusedTodoId, selectedTodoId, itemRefs, onSelect }: {
  lane: ProjectTodoLane;
  order: string[];
  todoById: Map<string, ProjectTodo>;
  operationalStateByTodoId: ReadonlyMap<string, ProjectTodoOperationalState>;
  focusedTodoId: string | null;
  selectedTodoId: string | null;
  itemRefs: React.MutableRefObject<Map<string, HTMLButtonElement>>;
  onSelect: (id: string, trigger: HTMLElement) => void;
}) {
  const presentation = PROJECT_TODO_LANE_PRESENTATIONS[lane];
  const { Icon } = presentation;
  const { setNodeRef, isOver } = useDroppable({ id: lane, data: { type: "lane", lane } });
  const laneAccent = lane === "ready" ? "var(--brand)" : lane === "in_progress" ? "var(--signal)" : lane === "done" ? "var(--success)" : "var(--text-muted)";
  return <section ref={setNodeRef} style={{ "--todo-lane-accent": laneAccent } as React.CSSProperties} className={`relative min-h-[360px] min-w-0 border-t-2 border-t-[color:color-mix(in_srgb,var(--todo-lane-accent)_58%,var(--border-default))] bg-[linear-gradient(180deg,color-mix(in_srgb,var(--todo-lane-accent)_7%,var(--bg-surface))_0,color-mix(in_srgb,var(--bg-surface)_26%,transparent)_190px,transparent_100%)] min-[721px]:min-h-full ${isOver ? "!border-t-brand !bg-[linear-gradient(180deg,color-mix(in_srgb,var(--brand-field)_48%,transparent),color-mix(in_srgb,var(--bg-surface)_12%,transparent))] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--brand)_20%,transparent)]" : ""}`} aria-label={presentation.title} data-testid={`todo-lane-${lane}`}>
    <header className="flex h-[42px] items-center justify-between border-b border-border-subtle bg-[linear-gradient(90deg,color-mix(in_srgb,var(--todo-lane-accent)_9%,transparent),transparent_76%)] px-2.5"><span className={`inline-flex items-center gap-[7px] text-[11px] font-semibold ${STATUS_TONE_CLASS[presentation.tone]}`}><Icon size={13} strokeWidth={1.9} data-icon={lane === "done" ? "check" : undefined} /><h2 className="text-inherit">{presentation.title}</h2></span><span className="font-mono text-[10px] leading-none tabular-nums text-text-muted">{order.length}</span></header>
    <SortableContext items={order} strategy={verticalListSortingStrategy}><div>{order.length ? order.map((id) => { const todo = todoById.get(id); return todo ? <SortableTodoCard key={id} todo={todo} operationalState={operationalStateByTodoId.get(id)} focused={focusedTodoId === id} selected={selectedTodoId === id} itemRefs={itemRefs} onSelect={onSelect} /> : null; }) : <p className="sr-only">{presentation.emptyTitle}</p>}</div></SortableContext>
  </section>;
}

function SortableTodoCard({ todo, operationalState, focused, selected, itemRefs, onSelect }: {
  todo: ProjectTodo;
  operationalState?: ProjectTodoOperationalState;
  focused: boolean;
  selected: boolean;
  itemRefs: React.MutableRefObject<Map<string, HTMLButtonElement>>;
  onSelect: (id: string, trigger: HTMLElement) => void;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: todo.id, data: { type: "todo", todo } });
  const excerpt = projectTodoDisplayLead(todo.content);
  return <article ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className={`group/todo-card workbench-row-lift mx-2 mt-2.5 grid grid-cols-[28px_minmax(0,1fr)] overflow-hidden rounded-[6px] border border-[color:color-mix(in_srgb,var(--border-strong)_58%,var(--border-default))] bg-bg-elevated shadow-[inset_0_1px_0_color-mix(in_srgb,var(--text-primary)_3%,transparent)] transition-[background,border-color,transform,opacity] duration-[var(--motion-fast)] hover:border-[color:color-mix(in_srgb,var(--todo-lane-accent)_28%,var(--border-strong))] hover:bg-bg-hover active:!translate-y-0 active:scale-[0.995] focus-within:border-[color:color-mix(in_srgb,var(--brand)_45%,var(--border-default))] focus-within:bg-selection-field focus-within:shadow-[inset_2px_0_0_var(--brand)] [@media(pointer:coarse)]:grid-cols-[44px_minmax(0,1fr)] ${focused || selected ? "todo-card-selected border-[color:color-mix(in_srgb,var(--brand)_45%,var(--border-default))] bg-selection-field" : ""} ${isDragging ? "z-[3] opacity-[0.88] shadow-[0_14px_34px_rgb(0_0_0/28%)]" : ""}`} data-testid={`todo-${todo.id}`}>
    <button ref={setActivatorNodeRef} type="button" className={`grid min-h-full w-7 touch-none place-items-center self-stretch border-0 border-r border-border-subtle bg-transparent text-text-muted transition-[background-color,color] duration-[var(--motion-fast)] hover:bg-bg-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:w-11 ${isDragging ? "cursor-grabbing text-brand" : "cursor-grab active:cursor-grabbing"}`} aria-label={`Drag ${excerpt}`} {...attributes} {...listeners}><GripVertical size={13} /></button><button ref={(node) => { node ? itemRefs.current.set(todo.id, node) : itemRefs.current.delete(todo.id); }} type="button" data-testid={`todo-open-${todo.id}`} className="block min-w-0 cursor-pointer bg-transparent p-2.5 text-left tracking-normal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand" onClick={(event) => onSelect(todo.id, event.currentTarget)}><span className={`line-clamp-2 text-[12.5px] font-medium leading-[1.48] tracking-normal transition-colors duration-[var(--motion-fast)] group-hover/todo-card:text-text-primary ${focused || selected ? "text-text-primary" : "text-text-secondary"}`}>{excerpt}</span>{operationalState ? <OperationalLine state={operationalState} todoId={todo.id} /> : null}</button>
  </article>;
}

function OperationalLine({ state, todoId, compact = false }: { state: ProjectTodoOperationalState; todoId?: string; compact?: boolean }) {
  const detail = state.detail !== state.label ? state.detail : undefined;
  if (compact) return <span data-testid={todoId ? `todo-operational-${todoId}` : undefined} className={`inline-flex items-center gap-1.5 font-semibold ${STATUS_TONE_CLASS[toneForOperational(state)]}`}><span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" /><span>{state.label}</span>{detail ? <span className="truncate text-text-tertiary">· {detail}</span> : null}</span>;
  return <span data-testid={todoId ? `todo-operational-${todoId}` : undefined} className={`mt-1 flex items-center gap-1.5 text-[11.5px] font-medium leading-[1.4] tracking-normal ${STATUS_TONE_CLASS[toneForOperational(state)]}`}><span className={`h-1.5 w-1.5 shrink-0 rounded-full bg-current ${state.kind === "running" ? "animate-activity-pulse" : ""}`} aria-hidden="true" /><span>{state.label}</span>{detail ? <span className="truncate text-text-tertiary">· {detail}</span> : null}</span>;
}

function TodoPreview({ todo, slug, operationalState, sessions, onClose, onOpenDetails, onOpenSession, onStart, onContinueWork }: {
  todo: ProjectTodo;
  slug: string;
  operationalState?: ProjectTodoOperationalState;
  sessions: SessionSummary[];
  onClose: () => void;
  onOpenDetails: () => void;
  onOpenSession: (sessionId: string) => void;
  onStart: (todo: ProjectTodo, entry: "discussion" | "work") => void;
  onContinueWork: (todo: ProjectTodo, sessionId: string) => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const discussion = sessions.filter((session) => session.source?.kind === "todo" && session.source.entry === "discussion")[0];
  const work = sessions.filter((session) => session.source?.kind === "todo" && session.source.entry === "work")[0];
  const active = todo.status !== "rejected" && todo.archivedAt === undefined;
  const canExecute = active && (todo.status === "ready" || todo.status === "in_progress");
  const canDiscuss = active && todo.status !== "done";
  const runtimeVisible = operationalState !== undefined && (operationalState.kind === "needs_you" || operationalState.kind === "failed" || operationalState.kind === "running" || operationalState.kind === "completed");
  useEffect(() => {
    requestAnimationFrame(() => headingRef.current?.focus());
  }, []);
  const trapFocus = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Tab") return;
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]), a[href]") ?? [])];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) return;
    if (document.activeElement === headingRef.current) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
    else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  return <><button type="button" tabIndex={-1} aria-label="Close Todo preview" onClick={onClose} className="animate-todo-preview-scrim absolute inset-0 z-20 cursor-pointer border-0 bg-[linear-gradient(90deg,rgb(0_0_0/6%),rgb(0_0_0/16%))] p-0 [@media(max-width:720px)]:hidden" /><aside ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="todo-preview-heading" onKeyDown={trapFocus} className="animate-todo-preview-enter absolute inset-y-0 right-0 z-30 flex w-[min(420px,calc(100%-48px))] max-w-[420px] flex-col overflow-hidden border-l border-border-default bg-[linear-gradient(180deg,color-mix(in_srgb,var(--bg-elevated)_56%,var(--bg-surface))_0%,var(--bg-surface)_120px)] shadow-[-16px_0_42px_rgb(0_0_0/18%)] [@media(max-width:720px)]:hidden" data-testid="todo-preview">
    <header className="flex h-[52px] shrink-0 items-center gap-2.5 border-b border-border-default pl-4 pr-3"><span className="inline-flex min-w-0 flex-1 items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-text-tertiary"><span className="h-1.5 w-1.5 rounded-full bg-brand shadow-[0_0_0_3px_color-mix(in_srgb,var(--brand)_16%,transparent)]" aria-hidden="true" />Preview</span><button ref={closeRef} type="button" aria-label="Close preview" onClick={onClose} className="grid h-[34px] w-[34px] place-items-center rounded-sm text-text-tertiary hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:[box-shadow:var(--focus)]"><X size={15} /></button><h1 ref={headingRef} id="todo-preview-heading" tabIndex={-1} className="sr-only">Todo detail</h1></header>
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden"><div className="min-h-0 flex-1 overflow-auto px-[18px] py-[22px]"><h2 className="text-[18px] font-semibold leading-[1.35] tracking-[-0.02em] text-text-primary">{projectTodoDisplayLead(todo.content)}</h2><p className="mt-[14px] line-clamp-5 text-[13px] leading-[1.65] text-text-secondary">{projectTodoPreviewExcerpt(todo.content)}</p><div className="mt-3 flex flex-wrap items-center gap-[9px]"><span className="inline-flex min-h-6 items-center rounded-full border border-border-subtle bg-bg-muted px-[9px] text-[10.5px] font-semibold tabular-nums text-text-secondary">Updated&nbsp;<RelativeTime timestamp={todo.updatedAt} style="short" /></span><span className="inline-flex min-h-6 items-center rounded-full border border-border-subtle bg-bg-muted px-[9px] text-[10.5px] font-semibold text-text-primary">{labelForStatus(todo.status as ProjectTodoLane)}</span></div>
      {runtimeVisible && operationalState ? <div className={`mt-[18px] flex items-start gap-2.5 rounded-[7px] border px-3 py-[11px] ${previewRuntimeSurface(operationalState)}`}><span className={`mt-[5px] h-2 w-2 shrink-0 rounded-full ${previewRuntimeMark(operationalState)}`} aria-hidden="true" /><span><strong className="block text-[11.5px] font-semibold leading-[1.45] text-text-primary">{operationalState.label}</strong><span className="mt-[3px] block text-[11.5px] leading-[1.45] text-text-secondary">{previewRuntimeCopy(operationalState)}</span></span></div> : null}
      {sessions.length ? <section className="mt-5"><h3 className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.05em] text-text-tertiary">Linked work</h3><div className="grid gap-2">{sessions.slice(0, 3).map((session) => { const discussionSession = session.source?.kind === "todo" && session.source.entry === "discussion"; const stateLabel = discussionSession ? "Discussion" : operationalState?.label ?? "Idle"; const stateTone = discussionSession ? "text-text-tertiary" : operationalState ? STATUS_TONE_CLASS[toneForOperational(operationalState)] : "text-text-tertiary"; const agent = `${session.agentName.slice(0, 1).toUpperCase()}${session.agentName.slice(1)}`; const detail = operationalState?.detail !== operationalState?.label ? operationalState?.detail : undefined; return <Link key={session.sessionId} to={`/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(session.sessionId)}`} aria-label={`${session.title || session.sessionId}, ${discussionSession ? "Discussion" : "Work Session"}, ${stateLabel}`} className="grid min-h-[52px] grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-[9px] rounded-[7px] border border-border-default bg-bg-muted px-[9px] py-[7px] text-inherit transition-[background-color,border-color] duration-[var(--motion-fast)] hover:border-border-strong hover:bg-bg-hover focus-visible:outline-none focus-visible:[box-shadow:var(--focus)]"><span className={`grid h-[27px] w-[27px] place-items-center rounded-[7px] border border-border-subtle ${discussionSession ? "text-text-tertiary" : stateTone}`} aria-hidden="true"><span className={`h-2 w-2 rounded-full ${discussionSession ? "bg-text-tertiary" : previewLinkedOrbit(operationalState)}`} /></span><span className="min-w-0"><strong className="block truncate text-[11.5px] font-semibold text-text-primary">{session.title || session.sessionId}</strong><small className="mt-[3px] block truncate text-[9.5px] text-text-tertiary">{agent} · {discussionSession ? "Discussion" : detail ?? "Work Session"}</small></span><span className={`whitespace-nowrap text-[10.5px] font-semibold ${stateTone}`}>{stateLabel}</span></Link>; })}</div></section> : null}
      <p className="mt-5 text-[10.5px] leading-[1.55] text-text-tertiary">Preview is read-only. Open details for the complete Markdown, references, Plan, lifecycle, and result.</p>
    </div>
    <footer className="grid shrink-0 gap-2 border-t border-border-default bg-bg-muted px-4 py-3">{canExecute ? <TodoPreviewAction variant="primary" onClick={() => work ? onContinueWork(todo, work.sessionId) : onStart(todo, "work")}>{work ? "Continue Work" : "Start Work"}</TodoPreviewAction> : canDiscuss ? <TodoPreviewAction variant="primary" onClick={() => discussion ? onOpenSession(discussion.sessionId) : onStart(todo, "discussion")}>{discussion ? "Continue Discussion" : "Start discussion"}</TodoPreviewAction> : null}<div className={`grid gap-1.5 ${canExecute && canDiscuss ? "grid-cols-[minmax(0,1fr)_auto]" : "grid-cols-1"}`}><TodoPreviewAction variant="secondary" onClick={onOpenDetails}>Open details</TodoPreviewAction>{canExecute && canDiscuss ? <TodoPreviewAction variant="quiet" onClick={() => discussion ? onOpenSession(discussion.sessionId) : onStart(todo, "discussion")}>{discussion ? "Continue Discussion" : "Discussion"}</TodoPreviewAction> : null}</div></footer>
    </div>
  </aside></>;
}

function TodoFlatList({ view, todos, filtered, slug, updateTodo, onSelect }: {
  view: Exclude<TodoSurface, "active">;
  todos: ProjectTodo[];
  filtered: boolean;
  slug: string;
  updateTodo: ReturnType<typeof useUpdateProjectTodo>;
  onSelect: (id: string, trigger: HTMLElement) => void;
}) {
  return <section className="mx-auto max-w-[980px]" aria-label={view === "rejected" ? "Rejected Todos" : "Archived Todos"}><h2 className="border-b border-border-default pb-3 text-[12px] font-semibold uppercase tracking-[0.05em] text-text-secondary">{view === "rejected" ? "Rejected" : "Archived"}</h2>{todos.length === 0 ? <p className="py-16 text-center text-[13px] text-text-tertiary">{todoFlatListEmptyMessage(view, filtered)}</p> : <div className="divide-y divide-border-subtle">{todos.map((todo) => <TodoFlatRow key={todo.id} todo={todo} view={view} slug={slug} updateTodo={updateTodo} onSelect={onSelect} />)}</div>}</section>;
}

function TodoFlatRow({ todo, view, slug, updateTodo, onSelect }: {
  todo: ProjectTodo;
  view: Exclude<TodoSurface, "active">;
  slug: string;
  updateTodo: ReturnType<typeof useUpdateProjectTodo>;
  onSelect: (id: string, trigger: HTMLElement) => void;
}) {
  const presentation = presentProjectTodoCard({ status: todo.status as ProjectTodoStatus, archivedAt: todo.archivedAt });
  const { Icon } = presentation;
  const secondary = view === "rejected" ? `Rejected · ${todo.rejectionReason}` : "Archived";
  const displayLead = projectTodoDisplayLead(todo.content);
  return <div className="grid min-h-14 grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-3 px-3 py-2.5 hover:bg-bg-hover"><Icon aria-hidden="true" className={STATUS_TONE_CLASS[presentation.tone]} size={14} /><button type="button" data-testid={`todo-${todo.id}`} aria-label={`${displayLead}, ${secondary}`} onClick={(event) => onSelect(todo.id, event.currentTarget)} className="min-w-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"><span className="line-clamp-2 text-[13px] font-medium leading-5 text-text-primary">{displayLead}</span><span className={`mt-1 block text-[11px] ${view === "rejected" ? "text-warning" : "text-text-tertiary"}`}>{secondary}</span></button><button type="button" disabled={updateTodo.isPending} onClick={() => updateTodo.mutate({ slug, todoId: todo.id, input: view === "rejected" ? { expectedRevision: todo.revision, status: "idea" } : { expectedRevision: todo.revision, archived: false } })} className="min-h-8 rounded-sm border border-border-default bg-bg-active px-2.5 text-[11px] font-semibold text-text-secondary hover:bg-bg-hover disabled:opacity-40 [@media(pointer:coarse)]:min-h-11">{view === "rejected" ? "Restore to Idea" : "Restore"}</button></div>;
}

function EmptyFilter({ filtered }: { filtered: boolean }) {
  return <div className="mx-auto max-w-[980px] py-16 text-center"><p className="text-[13px] font-medium text-text-secondary">{filtered ? "No active Todos match this filter." : "No active Todos yet."}</p><p className="mt-1 text-[11px] text-text-tertiary">{filtered ? "Try another ID, content, or visible work-state term." : "Create a Todo when you have work to shape."}</p></div>;
}

function DragPreview({ todo }: { todo?: ProjectTodo }) {
  return todo ? <div className="w-64 cursor-grabbing rounded-md border border-brand bg-bg-elevated p-3 shadow-lg"><p className="line-clamp-2 text-[13px] font-medium leading-5 text-text-primary">{projectTodoDisplayLead(todo.content)}</p></div> : null;
}

function SegmentButton({ children, active, onClick }: { children: React.ReactNode; active: boolean; onClick: () => void }) {
  return <button type="button" aria-pressed={active} onClick={onClick} className={`h-[38px] min-w-0 cursor-pointer rounded-sm px-2.5 text-[11px] font-semibold min-[721px]:h-[30px] ${active ? "bg-bg-elevated text-text-primary shadow-[inset_0_-2px_0_var(--brand)]" : "text-text-secondary hover:text-text-primary"}`}>{children}</button>;
}
function IconToggle({ children, label, active, disabled, onClick }: { children: React.ReactNode; label: string; active: boolean; disabled: boolean; onClick: () => void }) {
  return <button type="button" aria-label={label} title={label} aria-pressed={active} disabled={disabled} onClick={onClick} className={`grid h-8 w-8 min-w-8 cursor-pointer place-items-center rounded-sm focus-visible:outline-none focus-visible:[box-shadow:var(--focus)] [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11 [@media(pointer:coarse)]:!min-w-11 ${active ? "bg-bg-muted text-text-primary shadow-[inset_2px_0_0_var(--brand)]" : "text-text-tertiary hover:bg-bg-hover hover:text-text-secondary"} disabled:cursor-not-allowed disabled:opacity-35`}>{children}</button>;
}
function TodoPreviewAction({ children, variant, onClick }: { children: React.ReactNode; variant: "primary" | "secondary" | "quiet"; onClick: () => void }) {
  const visual = variant === "primary"
    ? "primary-action-button relative overflow-hidden border border-brand bg-brand px-[13px] text-brand-ink hover:-translate-y-px hover:border-brand-hover hover:bg-brand-hover active:translate-y-0 active:scale-[0.98]"
    : variant === "secondary"
      ? "border border-border-default bg-bg-elevated px-[13px] text-text-secondary hover:border-border-strong hover:bg-bg-hover hover:text-text-primary"
      : "border-0 bg-transparent px-2.5 text-text-secondary hover:bg-bg-hover hover:text-text-primary";
  return <button type="button" onClick={onClick} className={`inline-flex w-full items-center justify-center gap-1.5 rounded-sm text-[11.5px] font-semibold tracking-[-0.01em] transition-[background-color,border-color,color,box-shadow,transform] duration-[var(--motion-fast)] focus-visible:outline-none focus-visible:[box-shadow:var(--focus)] [@media(pointer:coarse)]:min-h-11 ${variant === "primary" ? "min-h-9" : "min-h-[34px]"} ${visual}`}>{children}</button>;
}

function compareSessionUpdated(left: SessionSummary, right: SessionSummary): number { return right.updatedAt - left.updatedAt || left.sessionId.localeCompare(right.sessionId); }
function toneForOperational(state: ProjectTodoOperationalState): StatusTone { return state.kind === "needs_you" ? "warning" : state.kind === "running" ? "signal" : state.kind === "completed" ? "brand" : state.kind === "failed" ? "error" : "neutral"; }
function labelForStatus(status: ProjectTodoLane): string { return status === "idea" ? "Idea" : status === "ready" ? "Ready" : status === "in_progress" ? "In Progress" : "Done"; }
function previewRuntimeSurface(state: ProjectTodoOperationalState): string {
  if (state.kind === "running") return "border-[color:color-mix(in_srgb,var(--signal)_24%,var(--border-subtle))] bg-signal-field";
  if (state.kind === "completed") return "border-[color:color-mix(in_srgb,var(--brand)_22%,var(--border-subtle))] bg-brand-field";
  if (state.kind === "failed") return "border-[color:color-mix(in_srgb,var(--error)_26%,var(--border-subtle))] bg-error-field";
  return "border-[color:color-mix(in_srgb,var(--warning)_26%,var(--border-subtle))] bg-attention-field";
}
function previewRuntimeMark(state: ProjectTodoOperationalState): string {
  if (state.kind === "running") return "border-[1.5px] border-signal-foreground bg-transparent";
  if (state.kind === "completed") return "bg-brand shadow-[0_0_0_3px_color-mix(in_srgb,var(--brand)_18%,transparent)]";
  if (state.kind === "failed") return "bg-error shadow-[0_0_0_3px_color-mix(in_srgb,var(--error)_18%,transparent)]";
  return "bg-warning shadow-[0_0_0_3px_color-mix(in_srgb,var(--warning)_18%,transparent)]";
}
function previewLinkedOrbit(state: ProjectTodoOperationalState | undefined): string {
  if (state?.kind === "running") return "border-[1.5px] border-signal-foreground bg-transparent";
  if (state?.kind === "needs_you") return "bg-warning";
  if (state?.kind === "failed") return "bg-error";
  if (state?.kind === "completed") return "bg-brand";
  return "bg-border-strong";
}
function previewRuntimeCopy(state: ProjectTodoOperationalState): string {
  const detail = state.detail !== state.label ? state.detail : undefined;
  if (state.kind === "needs_you") return detail === undefined ? "A bound Session is waiting before work can continue." : `Lead · ${detail}`;
  if (state.kind === "failed") return detail === undefined ? "The latest linked attempt failed and needs recovery." : `The latest linked attempt failed · ${detail}`;
  if (state.kind === "running") return detail === undefined ? "Execution is attached to this Todo." : `Lead · ${detail}`;
  return "Implementation is waiting for review.";
}
function isLane(value: string): value is ProjectTodoLane { return (LANES as readonly string[]).includes(value); }
function messageFor(cause: unknown): string { return cause instanceof Error ? cause.message : "Action failed"; }

export function createDragAnnouncements(order: BoardOrder, todoById: ReadonlyMap<string, ProjectTodo>) {
  const titleFor = (id: string | number) => todoById.get(String(id)) === undefined ? "Todo" : projectTodoDisplayLead(todoById.get(String(id))!.content);
  const describeTarget = (target: { lane: ProjectTodoLane; index: number } | undefined) => target ? `${PROJECT_TODO_LANE_PRESENTATIONS[target.lane].title}, position ${target.index + 1} of ${Math.max(1, order[target.lane].length, target.index + 1)}` : undefined;
  const targetFor = (overId: string | number) => {
    const id = String(overId);
    return describeTarget(isLane(id) ? { lane: id, index: order[id].length } : locateTodo(order, id));
  };
  return {
    onDragStart: ({ active }: { active: { id: string | number } }) => `Picked up ${titleFor(active.id)}.`,
    onDragOver: ({ active, over }: { active: { id: string | number }; over: { id: string | number } | null }) => {
      const target = over ? targetFor(over.id) : undefined;
      return target ? `Moving ${titleFor(active.id)} to ${target}.` : undefined;
    },
    onDragEnd: ({ active, over }: { active: { id: string | number }; over: { id: string | number } | null }) => {
      const target = describeTarget(locateTodo(order, String(active.id))) ?? (over ? targetFor(over.id) : undefined);
      return target ? `Dropped ${titleFor(active.id)} in ${target}.` : `Cancelled move for ${titleFor(active.id)}.`;
    },
    onDragCancel: ({ active }: { active: { id: string | number } }) => `Cancelled move for ${titleFor(active.id)}.`,
  };
}
