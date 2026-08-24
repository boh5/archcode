import { useEffect, useId, useMemo, useRef, useState } from "react";
import { rootSessionSourceTodoId, type SessionFamilyActivity } from "@archcode/protocol";
import { Check, ChevronDown, ChevronRight, Search, X } from "lucide-react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ApiError } from "../api/client";
import { useCreateProjectTodoSession, useUpdateProjectTodo } from "../api/mutations";
import { useAutomationInventory, useProjectTodos, useSessionInventory } from "../api/queries";
import type { ProjectSessionInventoryItem, ProjectTodo } from "../api/types";
import { RelativeTime } from "../components/primitives/TemporalText";
import { STATUS_TONE_CLASS, type StatusTone } from "../lib/status-visuals";
import { hitlAttentionLabelsByRootSession, useAttentionVisibleScopedHitl, useHitlProjectInitialized } from "../store/hitl-store";
import { runtimeFamilyKey, useSessionRuntimeFamilies, useSessionRuntimeInitialized } from "../store/session-runtime-store";
import {
  deriveProjectTodoOperationalState,
  presentProjectTodoCard,
  presentProjectTodoLinkedSession,
  projectTodoDisplayLead,
  projectTodoPreviewExcerpt,
  PROJECT_TODO_LANE_PRESENTATIONS,
  type ProjectTodoAttentionLabel,
  type ProjectTodoLane,
  type ProjectTodoOperationalState,
  type ProjectTodoStatus,
} from "./project-todo-presentation";

type TodoSurface = "active" | "rejected" | "archived";
type TodoReadiness = "loading" | "ready" | "unavailable";
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

export function ProjectTodosRoute() {
  const { slug = "" } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: todos = [], isLoading, error } = useProjectTodos(slug);
  const sessionInventory = useSessionInventory(slug);
  const automationInventory = useAutomationInventory(slug);
  const runtimeFamilies = useSessionRuntimeFamilies();
  const runtimeInitialized = useSessionRuntimeInitialized(slug);
  const attention = useAttentionVisibleScopedHitl([slug]);
  const hitlInitialized = useHitlProjectInitialized(slug);
  const createSession = useCreateProjectTodoSession();
  const updateTodo = useUpdateProjectTodo();

  const requestedSurface = searchParams.get("surface");
  const surface: TodoSurface = requestedSurface === "rejected" || requestedSurface === "archived" ? requestedSurface : "active";
  const query = searchParams.get("q") ?? "";
  const focusedTodoId = searchParams.get("focus");
  const [selectedTodoId, setSelectedTodoId] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef(new Map<string, HTMLButtonElement>());
  const scrollStorageKey = `archcode.todo-inventory-scroll:${slug}`;

  const activityBySessionId = useMemo(() => new Map((sessionInventory.data ?? []).map(({ session }) => [
    session.sessionId,
    runtimeFamilies[runtimeFamilyKey(slug, session.sessionId)]?.activity ?? "idle",
  ])), [runtimeFamilies, sessionInventory.data, slug]);
  const attentionBySessionId = useMemo(() => hitlAttentionLabelsByRootSession(attention), [attention]);
  const sessionInventoryReadiness: TodoReadiness = sessionInventory.error !== null
    ? "unavailable"
    : sessionInventory.isSuccess ? "ready" : "loading";
  const operationalReadiness: TodoReadiness = sessionInventoryReadiness === "unavailable" || automationInventory.error !== null
    ? "unavailable"
    : sessionInventoryReadiness === "ready" && automationInventory.isSuccess && runtimeInitialized && hitlInitialized
      ? "ready"
      : "loading";
  const operationalStateByTodoId = useMemo(() => {
    return new Map(todos.flatMap((todo) => {
      const state = deriveProjectTodoOperationalState({
        todo,
        sessions: sessionInventory.data ?? [],
        automations: automationInventory.data ?? [],
        activityBySessionId,
        attentionBySessionId,
        authoritative: operationalReadiness === "ready",
      });
      return state === undefined ? [] : [[todo.id, state] as const];
    }));
  }, [activityBySessionId, attentionBySessionId, automationInventory.data, operationalReadiness, sessionInventory.data, todos]);
  const filteredTodos = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return todos;
    return todos.filter((todo) => {
      const linkedSessions = (sessionInventory.data ?? []).filter(({ session }) => rootSessionSourceTodoId(session.source) === todo.id);
      const linkedAutomations = (automationInventory.data ?? []).filter(({ automation }) => automation.origin.kind === "todo" && automation.origin.todoId === todo.id);
      const operational = operationalStateByTodoId.get(todo.id);
      return [
        todo.id,
        todo.content,
        operational?.label ?? "",
        operational?.detail ?? "",
        ...linkedSessions.map(({ session }) => session.title ?? session.sessionId),
        ...linkedAutomations.map(({ automation }) => automation.name),
      ].some((value) => value.toLocaleLowerCase().includes(needle));
    });
  }, [automationInventory.data, operationalStateByTodoId, query, sessionInventory.data, todos]);
  const canonicalActiveTodos = useMemo(() => todos.filter((todo) => todo.archivedAt === undefined && todo.status !== "rejected"), [todos]);
  const activeTodos = useMemo(() => filteredTodos.filter((todo) => todo.archivedAt === undefined && todo.status !== "rejected"), [filteredTodos]);
  const groups = useMemo(() => deriveProjectTodoGroups(activeTodos), [activeTodos]);
  const canonicalGroups = useMemo(() => deriveProjectTodoGroups(canonicalActiveTodos), [canonicalActiveTodos]);
  const todoById = useMemo(() => new Map(todos.map((todo) => [todo.id, todo])), [todos]);
  const selectedTodo = selectedTodoId === null ? undefined : todoById.get(selectedTodoId);
  const queryActive = query.trim().length > 0;

  const updateUrl = (change: { surface?: TodoSurface; query?: string; focus?: string | null }) => {
    const next = new URLSearchParams();
    const nextSurface = change.surface ?? surface;
    const nextQuery = change.query ?? query;
    const nextFocus = change.focus === undefined ? focusedTodoId : change.focus;
    if (nextSurface !== "active") next.set("surface", nextSurface);
    if (nextQuery) next.set("q", nextQuery);
    if (nextFocus) next.set("focus", nextFocus);
    setSearchParams(next, { replace: true });
  };

  useEffect(() => {
    const saved = window.sessionStorage.getItem(scrollStorageKey);
    if (saved !== null && scrollRef.current !== null) scrollRef.current.scrollTop = Number(saved) || 0;
    return () => window.sessionStorage.setItem(scrollStorageKey, String(scrollRef.current?.scrollTop ?? 0));
  }, [scrollStorageKey]);
  useEffect(() => {
    if (focusedTodoId === null || selectedTodoId !== null) return;
    requestAnimationFrame(() => itemRefs.current.get(focusedTodoId)?.focus({ preventScroll: true }));
  }, [focusedTodoId, selectedTodoId, surface]);

  const closePreview = () => {
    if (selectedTodoId === null) return;
    const restoreTodoId = selectedTodoId;
    setSelectedTodoId(null);
    requestAnimationFrame(() => itemRefs.current.get(restoreTodoId)?.focus({ preventScroll: true }));
  };
  const openDetails = (todoId: string) => {
    window.sessionStorage.setItem(scrollStorageKey, String(scrollRef.current?.scrollTop ?? 0));
    navigate(`/projects/${encodeURIComponent(slug)}/todos/${encodeURIComponent(todoId)}`, { state: { fromTodos: true } });
  };
  const selectTodo = (todoId: string, _trigger: HTMLElement) => {
    updateUrl({ focus: todoId });
    if (surface !== "active" || window.matchMedia("(max-width: 720px)").matches) {
      openDetails(todoId);
      return;
    }
    setSelectedTodoId(todoId);
  };
  const sessionsFor = (todoId: string): ProjectSessionInventoryItem[] => (sessionInventory.data ?? [])
    .filter(({ session }) => rootSessionSourceTodoId(session.source) === todoId)
    .sort(compareSessionItemUpdated);
  const startEntry = (todo: ProjectTodo, entry: "discussion" | "work") => {
    if (sessionInventoryReadiness !== "ready") return;
    setCreateError(null);
    createSession.mutate({ slug, todoId: todo.id, input: { expectedRevision: todo.revision, entry } }, {
      onSuccess: ({ sessionId }) => navigate(`/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sessionId)}`),
      onError: (cause) => setCreateError(messageFor(cause)),
    });
  };
  const continueWork = (todo: ProjectTodo, sessionId: string) => {
    if (sessionInventoryReadiness !== "ready") return;
    const go = () => navigate(`/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sessionId)}`);
    if (todo.status === "ready") {
      updateTodo.mutate({ slug, todoId: todo.id, input: { expectedRevision: todo.revision, status: "in_progress" } }, { onSuccess: go, onError: (cause) => setCreateError(messageFor(cause)) });
    } else go();
  };
  const updateStage = async (todo: ProjectTodo, status: ProjectTodoLane): Promise<void> => {
    await updateTodo.mutateAsync({ slug, todoId: todo.id, input: { expectedRevision: todo.revision, status } });
  };

  if (isLoading) return <div className="flex h-full items-center justify-center text-sm text-text-tertiary">Loading Todos…</div>;
  if (error) return <div className="flex h-full items-center justify-center text-sm text-error">Failed to load Todos</div>;

  const flatTodos = surface === "archived"
    ? filteredTodos.filter((todo) => todo.archivedAt !== undefined)
    : filteredTodos.filter((todo) => todo.archivedAt === undefined && todo.status === "rejected");

  return (
    <div className="relative flex h-full min-w-0 flex-col overflow-hidden bg-bg-base">
      <header className="flex h-[54px] shrink-0 items-center gap-2 border-b border-border-default bg-bg-surface py-[7px] pl-[51px] pr-[9px] min-[721px]:h-[58px] min-[721px]:pl-[66px] min-[721px]:pr-4 min-[981px]:px-[18px]">
        <div className="min-w-0"><p className="text-[10.5px] font-medium uppercase leading-[1.2] tracking-[0.08em] text-text-tertiary">Work</p><div className="mt-0.5 flex min-w-0 items-center gap-2"><h1 className="truncate text-[17.5px] font-bold leading-[1.3] tracking-[-0.022em] text-text-primary">All todos</h1><span className="rounded-full bg-bg-muted px-2 py-0.5 font-mono text-[10px] tabular-nums text-text-tertiary">{canonicalActiveTodos.length}</span></div></div>
      </header>
      <div className="flex shrink-0 flex-col items-stretch gap-[14px] border-b border-border-default bg-bg-surface px-3 pb-[14px] pt-[18px] min-[721px]:px-5 min-[721px]:pt-7 min-[981px]:flex-row min-[981px]:items-start min-[981px]:justify-between">
        <label className="group flex h-11 w-full max-w-none min-w-0 items-center gap-2 rounded-sm border border-border-subtle bg-[color-mix(in_srgb,var(--bg-base)_82%,var(--bg-surface))] py-0 pl-3 pr-1 text-text-tertiary shadow-[inset_0_1px_0_rgb(255_255_255/3%)] transition-[border-color,background-color,box-shadow] duration-[var(--motion-fast)] hover:border-border-default hover:bg-bg-elevated focus-within:border-brand focus-within:bg-bg-elevated focus-within:[box-shadow:var(--focus)] min-[721px]:h-[38px] min-[721px]:max-w-[430px] min-[981px]:w-[430px] min-[981px]:flex-none"><Search className="shrink-0 transition-colors duration-[var(--motion-fast)] group-focus-within:text-brand" size={14} aria-hidden="true" /><span className="sr-only">Filter Todos</span><input type="search" value={query} onChange={(event) => updateUrl({ query: event.target.value, focus: null })} placeholder="Filter todos…" autoComplete="off" spellCheck={false} className="h-full min-w-0 flex-1 appearance-none border-0 bg-transparent px-0.5 text-[16px] text-text-primary outline-none placeholder:text-text-tertiary [&::-webkit-search-cancel-button]:appearance-none min-[721px]:text-[12px]" />{query ? <button type="button" aria-label="Clear Todo filter" onClick={() => updateUrl({ query: "", focus: null })} className="grid h-7 w-7 shrink-0 place-items-center rounded-sm text-text-tertiary hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:[box-shadow:var(--focus)]"><X size={12} aria-hidden="true" /></button> : null}</label>
        <div className="grid h-[46px] w-full min-w-0 grid-cols-3 rounded-sm border border-border-default bg-bg-muted p-[3px] min-[721px]:h-[38px] min-[981px]:w-[228px] min-[981px]:flex-none" role="group" aria-label="Todo surfaces"><SegmentButton active={surface === "active"} onClick={() => { closePreview(); updateUrl({ surface: "active" }); }}>Active</SegmentButton><SegmentButton active={surface === "rejected"} onClick={() => { closePreview(); updateUrl({ surface: "rejected" }); }}>Rejected</SegmentButton><SegmentButton active={surface === "archived"} onClick={() => { closePreview(); updateUrl({ surface: "archived" }); }}>Archived</SegmentButton></div>
      </div>
      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} className="h-full overflow-auto px-3 pb-16 pt-[18px] min-[721px]:px-5 min-[721px]:pt-7">
          {surface === "active" && todos.length === 0 ? <FirstUseTodoState /> : null}
          {surface === "active" && todos.length > 0 && queryActive && activeTodos.length === 0 ? <TodoFilterEmpty query={query} onClear={() => updateUrl({ query: "", focus: null })} /> : null}
          {surface === "active" && todos.length > 0 && (!queryActive || activeTodos.length > 0) ? <ActiveTodoList groups={groups} canonicalGroups={canonicalGroups} filtered={queryActive} operationalStateByTodoId={operationalStateByTodoId} focusedTodoId={focusedTodoId} selectedTodoId={selectedTodoId} itemRefs={itemRefs} onSelect={selectTodo} /> : null}
          {surface !== "active" ? <TodoFlatList view={surface} todos={flatTodos} filtered={queryActive} slug={slug} updateTodo={updateTodo} onSelect={selectTodo} onClear={() => updateUrl({ query: "", focus: null })} /> : null}
        </div>
        {selectedTodo ? <TodoPreview key={selectedTodo.id} todo={selectedTodo} slug={slug} operationalState={operationalStateByTodoId.get(selectedTodo.id)} operationalReadiness={operationalReadiness} sessionInventoryReadiness={sessionInventoryReadiness} sessions={sessionsFor(selectedTodo.id)} activityBySessionId={activityBySessionId} attentionBySessionId={attentionBySessionId} onClose={closePreview} onOpenDetails={() => openDetails(selectedTodo.id)} onOpenSession={(sessionId) => navigate(`/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sessionId)}`)} onStart={startEntry} onContinueWork={continueWork} onChangeStage={updateStage} /> : null}
      </div>
      {createError ? <p role="alert" className="shrink-0 border-t border-error/20 bg-error-muted px-5 py-3 text-[11px] text-error">{createError}</p> : null}
    </div>
  );
}

function ActiveTodoList({ groups, canonicalGroups, filtered, operationalStateByTodoId, focusedTodoId, selectedTodoId, itemRefs, onSelect }: {
  groups: Record<ProjectTodoLane, ProjectTodo[]>;
  canonicalGroups: Record<ProjectTodoLane, ProjectTodo[]>;
  filtered: boolean;
  operationalStateByTodoId: ReadonlyMap<string, ProjectTodoOperationalState>;
  focusedTodoId: string | null;
  selectedTodoId: string | null;
  itemRefs: React.MutableRefObject<Map<string, HTMLButtonElement>>;
  onSelect: (id: string, trigger: HTMLElement) => void;
}) {
  return <div className="mx-auto grid w-full max-w-[980px] gap-[26px]" data-testid="todo-active-list">{LANES.map((lane) => {
    const presentation = PROJECT_TODO_LANE_PRESENTATIONS[lane];
    const empty = filtered && canonicalGroups[lane].length > 0 ? `No matching Todos in ${presentation.title}.` : presentation.emptyTitle;
    return <section key={lane} aria-labelledby={`todo-list-${lane}`}><header className="flex min-h-[29px] items-center gap-2 border-b border-border-subtle px-[7px] pb-2 text-[11px] font-bold uppercase tracking-[0.08em] text-text-tertiary"><span className={`h-1.5 w-1.5 shrink-0 rounded-full ${lane === "ready" ? "bg-brand" : lane === "done" ? "bg-success" : "bg-text-muted"}`} aria-hidden="true" /><h2 id={`todo-list-${lane}`} className="text-inherit">{presentation.title}</h2><span className="font-mono text-[10.5px] font-medium tabular-nums text-text-muted">{groups[lane].length}</span></header><div>{groups[lane].length ? groups[lane].map((todo) => <TodoListRow key={todo.id} todo={todo} operationalState={operationalStateByTodoId.get(todo.id)} focused={focusedTodoId === todo.id} selected={selectedTodoId === todo.id} itemRefs={itemRefs} onSelect={onSelect} />) : <p className="flex min-h-12 items-center border-b border-border-subtle px-[9px] text-[11px] text-text-tertiary">{empty}</p>}</div></section>;
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
  const { Icon } = PROJECT_TODO_LANE_PRESENTATIONS[todo.status as ProjectTodoLane];
  return <button ref={(node) => { node ? itemRefs.current.set(todo.id, node) : itemRefs.current.delete(todo.id); }} type="button" data-testid={`todo-open-${todo.id}`} onClick={(event) => onSelect(todo.id, event.currentTarget)} className={`grid min-h-[66px] w-full grid-cols-[30px_minmax(0,1fr)_14px] items-center gap-3 border-b border-border-subtle px-2 py-2.5 text-left transition-[background-color,box-shadow] duration-[var(--motion-fast)] hover:bg-bg-hover focus-visible:outline-none focus-visible:[box-shadow:var(--focus)] [@media(max-width:720px)]:grid-cols-[27px_minmax(0,1fr)] ${focused || selected ? "bg-selection-field shadow-[inset_2px_0_0_var(--brand)]" : ""}`}><span className={`grid h-[27px] w-[27px] place-items-center rounded-[7px] border ${todoListOrbitClass(todo.status as ProjectTodoLane, operationalState)}`}><Icon size={12} aria-hidden="true" /></span><span className="min-w-0"><span className="block truncate text-[13.5px] font-semibold leading-[1.35] text-text-primary">{projectTodoDisplayLead(todo.content)}</span><span className="mt-1 flex min-w-0 items-center text-[11.5px] leading-[1.35] tracking-normal text-text-muted">{operationalState ? <OperationalLine state={operationalState} todoId={todo.id} /> : <span>Updated&nbsp;<RelativeTime timestamp={todo.updatedAt} style="short" /></span>}</span></span><ChevronRight size={13} className="text-text-muted [@media(max-width:720px)]:hidden" aria-hidden="true" /></button>;
}

function OperationalLine({ state, todoId }: { state: ProjectTodoOperationalState; todoId: string }) {
  const detail = state.detail !== state.label ? state.detail : undefined;
  return <span data-testid={`todo-operational-${todoId}`} className={`inline-flex min-w-0 items-center gap-1.5 font-semibold ${STATUS_TONE_CLASS[toneForOperational(state)]}`}><span className={`h-1.5 w-1.5 shrink-0 rounded-full bg-current ${state.kind === "running" ? "animate-activity-pulse" : ""}`} aria-hidden="true" /><span>{state.label}</span>{detail ? <span className="truncate text-text-tertiary">· {detail}</span> : null}</span>;
}

function TodoPreview({ todo, slug, operationalState, operationalReadiness, sessionInventoryReadiness, sessions, activityBySessionId, attentionBySessionId, onClose, onOpenDetails, onOpenSession, onStart, onContinueWork, onChangeStage }: {
  todo: ProjectTodo;
  slug: string;
  operationalState?: ProjectTodoOperationalState;
  operationalReadiness: TodoReadiness;
  sessionInventoryReadiness: TodoReadiness;
  sessions: ProjectSessionInventoryItem[];
  activityBySessionId: ReadonlyMap<string, SessionFamilyActivity>;
  attentionBySessionId: ReadonlyMap<string, ProjectTodoAttentionLabel>;
  onClose: () => void;
  onOpenDetails: () => void;
  onOpenSession: (sessionId: string) => void;
  onStart: (todo: ProjectTodo, entry: "discussion" | "work") => void;
  onContinueWork: (todo: ProjectTodo, sessionId: string) => void;
  onChangeStage: (todo: ProjectTodo, status: ProjectTodoLane) => Promise<void>;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const stageTriggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef(new Map<ProjectTodoLane, HTMLButtonElement>());
  const recoveryRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDone, setConfirmDone] = useState(false);
  const [pending, setPending] = useState(false);
  const [stageStatus, setStageStatus] = useState("");
  const [stageError, setStageError] = useState<{ cause: unknown; target: ProjectTodoLane; confirmed: boolean } | null>(null);
  const discussion = sessions.find(({ session }) => session.source.kind === "todo" && session.source.entry === "discussion")?.session;
  const work = sessions.find(({ session }) => session.source.kind === "todo" && session.source.entry === "work")?.session;
  const active = todo.status !== "rejected" && todo.archivedAt === undefined;
  const currentStage = todo.status as ProjectTodoLane;
  const sessionInventoryReady = sessionInventoryReadiness === "ready";
  const operationalReady = operationalReadiness === "ready";
  const canExecute = active && (todo.status === "ready" || todo.status === "in_progress");
  const canDiscuss = active && todo.status !== "done";
  const doneConfirmationReason = operationalState?.kind === "running"
    ? "running"
    : operationalState?.kind === "needs_you" ? "needs_you" : undefined;
  const selectableStageLanes = operationalReady || currentStage === "done"
    ? LANES
    : LANES.filter((lane) => lane !== "done");

  useEffect(() => {
    requestAnimationFrame(() => headingRef.current?.focus());
  }, []);
  useEffect(() => {
    if (operationalReady) return;
    const leavingDoneFlow = confirmDone || stageError?.target === "done";
    if (!leavingDoneFlow) return;
    setConfirmDone(false);
    setStageError(null);
    setStageStatus("Moving to Done is unavailable until operational state is authoritative.");
    requestAnimationFrame(() => stageTriggerRef.current?.focus());
  }, [confirmDone, operationalReady, stageError?.target]);

  const openStageMenu = (edge: "selected" | "first" | "last" = "selected") => {
    if (pending) return;
    setConfirmDone(false);
    setMenuOpen(true);
    requestAnimationFrame(() => {
      const target = edge === "first" ? selectableStageLanes[0] : edge === "last" ? selectableStageLanes.at(-1)! : currentStage;
      optionRefs.current.get(target)?.focus();
    });
  };
  const closeStageMenu = (restoreFocus = false) => {
    setMenuOpen(false);
    if (restoreFocus) requestAnimationFrame(() => stageTriggerRef.current?.focus());
  };
  const applyStage = async (target: ProjectTodoLane, { confirmed }: { confirmed: boolean }) => {
    if (pending) {
      closeStageMenu(true);
      return;
    }
    if (target === currentStage) {
      closeStageMenu(true);
      setConfirmDone(false);
      setStageError(null);
      setStageStatus(`Todo stage is already ${labelForStatus(target)}.`);
      return;
    }
    if (target === "done" && currentStage !== "done") {
      if (!operationalReady) {
        setMenuOpen(false);
        setConfirmDone(false);
        setStageError(null);
        setStageStatus("Moving to Done is unavailable until operational state is authoritative.");
        requestAnimationFrame(() => stageTriggerRef.current?.focus());
        return;
      }
      if (doneConfirmationReason !== undefined && !confirmed) {
        setMenuOpen(false);
        setConfirmDone(true);
        requestAnimationFrame(() => dialogRef.current?.querySelector<HTMLButtonElement>("[data-stage-confirm-cancel]")?.focus());
        return;
      }
    }
    setMenuOpen(false);
    setConfirmDone(false);
    setStageError(null);
    setPending(true);
    setStageStatus("Updating Todo stage.");
    headingRef.current?.focus();
    try {
      await onChangeStage(todo, target);
      setStageStatus(`Todo stage updated to ${labelForStatus(target)}.`);
      setPending(false);
      requestAnimationFrame(() => stageTriggerRef.current?.focus());
    } catch (cause) {
      setPending(false);
      setStageStatus("Todo stage update failed.");
      setStageError({ cause, target, confirmed });
      requestAnimationFrame(() => recoveryRef.current?.focus());
    }
  };
  const requestStage = (target: ProjectTodoLane) => {
    void applyStage(target, { confirmed: false });
  };
  const continueAfterMenuTab = (backward: boolean) => {
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]), a[href]") ?? [])]
      .filter((element) => element.closest('[role="menu"]') === null);
    const triggerIndex = focusable.indexOf(stageTriggerRef.current!);
    const target = backward
      ? focusable[triggerIndex - 1] ?? focusable.at(-1)
      : focusable[triggerIndex + 1] ?? focusable[0];
    closeStageMenu();
    requestAnimationFrame(() => target?.focus());
  };
  const onOptionKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, lane: ProjectTodoLane) => {
    const index = selectableStageLanes.indexOf(lane);
    const nextIndex = event.key === "ArrowDown" ? (index + 1) % selectableStageLanes.length
      : event.key === "ArrowUp" ? (index - 1 + selectableStageLanes.length) % selectableStageLanes.length
        : event.key === "Home" ? 0
          : event.key === "End" ? selectableStageLanes.length - 1 : -1;
    if (nextIndex >= 0) {
      event.preventDefault();
      optionRefs.current.get(selectableStageLanes[nextIndex]!)?.focus();
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      requestStage(lane);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeStageMenu(true);
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      continueAfterMenuTab(event.shiftKey);
    }
  };
  const trapFocus = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      if (menuOpen) closeStageMenu(true);
      else if (confirmDone) {
        setConfirmDone(false);
        requestAnimationFrame(() => stageTriggerRef.current?.focus());
      } else if (!pending) onClose();
      return;
    }
    if (event.key !== "Tab" || menuOpen) return;
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]), a[href]") ?? [])];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) return;
    if (document.activeElement === headingRef.current) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return <>
    <button type="button" tabIndex={-1} aria-label="Close Todo preview" disabled={pending} onClick={() => { if (!pending) onClose(); }} className="animate-todo-preview-scrim absolute inset-0 z-20 cursor-pointer border-0 bg-[linear-gradient(90deg,rgb(0_0_0/6%),rgb(0_0_0/16%))] p-0 disabled:cursor-progress [@media(max-width:720px)]:hidden" />
    <aside ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="todo-preview-heading" aria-busy={pending} onKeyDown={trapFocus} onMouseDown={(event) => { if (!(event.target as Element).closest("[data-preview-stage]")) setMenuOpen(false); }} className="animate-todo-preview-enter absolute inset-y-0 right-0 z-30 flex w-[min(420px,calc(100%-48px))] max-w-[420px] flex-col overflow-hidden border-l border-border-default bg-[linear-gradient(180deg,color-mix(in_srgb,var(--bg-overlay)_88%,var(--bg-surface))_0%,var(--bg-overlay)_120px)] shadow-[var(--elevation-drawer)] [@media(max-width:720px)]:hidden" data-testid="todo-preview">
      <header className="flex h-[52px] shrink-0 items-center gap-2.5 border-b border-border-default pl-4 pr-3"><span className="inline-flex min-w-0 flex-1 items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-text-tertiary"><span className="h-1.5 w-1.5 rounded-full bg-brand shadow-[0_0_0_3px_color-mix(in_srgb,var(--brand)_16%,transparent)]" aria-hidden="true" />Preview</span><button type="button" aria-label="Close preview" disabled={pending} onClick={onClose} className="grid h-[34px] w-[34px] place-items-center rounded-sm text-text-tertiary hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:[box-shadow:var(--focus)] disabled:cursor-progress disabled:opacity-50"><X size={15} /></button><h1 ref={headingRef} id="todo-preview-heading" tabIndex={-1} className="sr-only">Todo detail</h1></header>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden"><div className="min-h-0 flex-1 overflow-auto px-[18px] py-[22px]"><h2 className="text-[18px] font-semibold leading-[1.35] tracking-[-0.02em] text-text-primary">{projectTodoDisplayLead(todo.content)}</h2><p className="mt-[14px] line-clamp-5 text-[13px] leading-[1.65] text-text-secondary">{projectTodoPreviewExcerpt(todo.content)}</p>
        <div className="mt-3 flex flex-wrap items-center gap-[9px] text-[10.5px] text-text-tertiary">
          <div className="relative z-[2]" data-preview-stage onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setMenuOpen(false); }}>
            <button ref={stageTriggerRef} type="button" aria-label={`Change Todo stage, current ${labelForStatus(currentStage)}`} aria-haspopup="menu" aria-expanded={menuOpen} aria-controls={menuId} aria-busy={pending} disabled={pending} onClick={() => menuOpen ? closeStageMenu(true) : openStageMenu()} onKeyDown={(event) => {
              if (["Enter", " ", "ArrowDown", "ArrowUp"].includes(event.key)) {
                event.preventDefault();
                openStageMenu(event.key === "ArrowUp" ? "last" : "selected");
              }
            }} className={`inline-grid min-h-7 grid-cols-[auto_auto_12px] items-center gap-1 rounded-sm border border-border-strong bg-bg-muted px-[7px] text-left transition-[border-color,background-color,color] duration-[var(--motion-fast)] hover:border-brand/30 hover:bg-bg-hover focus-visible:outline-none focus-visible:[box-shadow:var(--focus)] disabled:cursor-progress disabled:opacity-60 ${stageTriggerTone(currentStage)}`}><span>Stage:</span><strong className="font-semibold">{pending ? "Updating…" : labelForStatus(currentStage)}</strong><ChevronDown size={11} className={`text-text-tertiary transition-transform ${menuOpen ? "rotate-180" : ""}`} aria-hidden="true" /></button>
            {menuOpen ? <div id={menuId} role="menu" aria-label="Todo stage" className="absolute left-0 top-[calc(100%+6px)] z-[8] grid w-[210px] gap-0.5 rounded-[var(--shape-popover)] border border-border-strong bg-bg-overlay p-1 shadow-[var(--elevation-popover)]">{LANES.map((lane) => {
              const { Icon } = PROJECT_TODO_LANE_PRESENTATIONS[lane];
              const current = lane === currentStage;
              const doneUnavailable = lane === "done" && currentStage !== "done" && !operationalReady;
              return <button key={lane} ref={(node) => { node ? optionRefs.current.set(lane, node) : optionRefs.current.delete(lane); }} type="button" role="menuitemradio" aria-checked={current} aria-describedby={doneUnavailable ? "todo-preview-operational-state" : undefined} disabled={pending || doneUnavailable} onClick={() => requestStage(lane)} onKeyDown={(event) => onOptionKeyDown(event, lane)} className={`grid min-h-[38px] w-full grid-cols-[27px_minmax(0,1fr)_14px] items-center gap-2 rounded-sm px-2 py-1 text-left text-[11.5px] text-text-secondary hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:[box-shadow:var(--focus)] disabled:cursor-not-allowed disabled:opacity-50 ${current ? "bg-selection-field text-text-primary shadow-[inset_2px_0_0_var(--brand)]" : ""}`}><span className={`grid h-[25px] w-[25px] place-items-center rounded-sm border ${todoListOrbitClass(lane)}`}><Icon size={12} aria-hidden="true" /></span><span>{labelForStatus(lane)}</span>{current ? <Check size={13} className="text-brand" aria-hidden="true" /> : null}</button>;
            })}</div> : null}
          </div>
          <span>Updated&nbsp;<RelativeTime timestamp={todo.updatedAt} style="short" /></span>
          <span className="sr-only" aria-live="polite">{stageStatus}</span>
        </div>
        {confirmDone && doneConfirmationReason !== undefined ? <TodoStageConfirmation reason={doneConfirmationReason} pending={pending} onCancel={() => { setConfirmDone(false); stageTriggerRef.current?.focus(); }} onConfirm={() => void applyStage("done", { confirmed: true })} /> : null}
        {stageError ? <TodoStageError error={stageError} pending={pending} recoveryRef={recoveryRef} onRetry={() => void applyStage(stageError.target, { confirmed: stageError.confirmed })} /> : null}
        {!operationalReady ? <PreviewOperationalStateNotice readiness={operationalReadiness} /> : null}
        {operationalState ? <PreviewOperationalState state={operationalState} /> : null}
        {operationalReady && sessions.length ? <PreviewLinkedWork slug={slug} sessions={sessions} activityBySessionId={activityBySessionId} attentionBySessionId={attentionBySessionId} /> : null}
        <p className="mt-5 text-[10.5px] leading-[1.55] text-text-tertiary">Content and context stay read-only here. Stage changes organize the Todo only. Open details for Markdown, references, Plan, Reject, Archive, and result.</p>
      </div>
      <footer className="grid shrink-0 gap-2 border-t border-border-default bg-bg-muted px-4 py-3">{canExecute ? <TodoPreviewAction variant="primary" disabled={pending || !sessionInventoryReady} onClick={() => work ? onContinueWork(todo, work.sessionId) : onStart(todo, "work")}>{sessionInventoryReady ? work ? "Continue Work" : "Start Work" : sessionInventoryReadiness === "loading" ? "Loading work…" : "Work unavailable"}</TodoPreviewAction> : canDiscuss ? <TodoPreviewAction variant="primary" disabled={pending || !sessionInventoryReady} onClick={() => discussion ? onOpenSession(discussion.sessionId) : onStart(todo, "discussion")}>{sessionInventoryReady ? discussion ? "Continue Discussion" : "Start discussion" : sessionInventoryReadiness === "loading" ? "Loading discussion…" : "Discussion unavailable"}</TodoPreviewAction> : null}<div className={`grid gap-1.5 ${canExecute && canDiscuss ? "grid-cols-[minmax(0,1fr)_auto]" : "grid-cols-1"}`}><TodoPreviewAction variant="secondary" onClick={onOpenDetails}>Open details</TodoPreviewAction>{canExecute && canDiscuss ? <TodoPreviewAction variant="quiet" disabled={pending || !sessionInventoryReady} onClick={() => discussion ? onOpenSession(discussion.sessionId) : onStart(todo, "discussion")}>{sessionInventoryReady ? discussion ? "Continue Discussion" : "Discussion" : sessionInventoryReadiness === "loading" ? "Loading discussion…" : "Discussion unavailable"}</TodoPreviewAction> : null}</div></footer>
      </div>
    </aside>
  </>;
}

function TodoStageConfirmation({ reason, pending, onCancel, onConfirm }: {
  reason: "running" | "needs_you";
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return <section aria-label="Confirm Todo stage change" className="mt-[14px] rounded-sm border border-warning/30 bg-attention-field px-3 py-[11px]"><strong className="text-[11.5px] font-semibold text-text-secondary">Linked work is still <span className="text-warning">{reason === "running" ? "running" : "waiting for you"}</span>.</strong><p className="mt-[5px] text-[10.5px] leading-[1.5] text-text-tertiary">Moving this Todo to Done changes only its stage. It will not stop or resolve the linked Session.</p><div className="mt-2.5 flex justify-end gap-[7px]"><button data-stage-confirm-cancel type="button" disabled={pending} onClick={onCancel} className="min-h-8 rounded-sm px-2.5 text-[11px] font-semibold text-text-secondary hover:bg-bg-hover focus-visible:outline-none focus-visible:[box-shadow:var(--focus)]">Cancel</button><button type="button" disabled={pending} onClick={onConfirm} className="min-h-8 rounded-sm border border-border-default bg-bg-elevated px-3 text-[11px] font-semibold text-text-secondary hover:border-border-strong hover:bg-bg-hover focus-visible:outline-none focus-visible:[box-shadow:var(--focus)]">Move to Done</button></div></section>;
}

function TodoStageError({ error, pending, recoveryRef, onRetry }: {
  error: { cause: unknown; target: ProjectTodoLane; confirmed: boolean };
  pending: boolean;
  recoveryRef: React.RefObject<HTMLButtonElement | null>;
  onRetry: () => void;
}) {
  const conflict = isRevisionConflict(error.cause);
  return <div role="alert" className="mt-[14px] rounded-sm border border-error/25 bg-error-field px-3 py-[10px] text-[10.5px] leading-[1.5] text-text-secondary"><strong className="block text-[11.5px] text-error">{conflict ? "This Todo changed elsewhere." : "Could not update the Todo stage."}</strong><span className="mt-1 block">{conflict ? "Refresh its latest data and retry without overwriting newer work." : messageFor(error.cause)}</span><button ref={recoveryRef} type="button" disabled={pending} onClick={onRetry} className="mt-2 min-h-8 rounded-sm border border-border-default bg-bg-elevated px-2.5 font-semibold text-text-primary hover:border-border-strong hover:bg-bg-hover focus-visible:outline-none focus-visible:[box-shadow:var(--focus)]">{conflict ? "Refresh and retry" : "Retry stage change"}</button></div>;
}

function PreviewOperationalStateNotice({ readiness }: { readiness: TodoReadiness }) {
  const unavailable = readiness === "unavailable";
  return <div id="todo-preview-operational-state" data-testid="todo-preview-operational-state" role={unavailable ? "alert" : "status"} className={`mt-[14px] rounded-sm border px-3 py-[10px] text-[10.5px] leading-[1.5] ${unavailable ? "border-error/25 bg-error-field text-text-secondary" : "border-border-default bg-bg-muted text-text-tertiary"}`}><strong className={`block text-[11.5px] ${unavailable ? "text-error" : "text-text-secondary"}`}>{unavailable ? "Operational state unavailable" : "Loading operational state"}</strong><span className="mt-1 block">Moving into Done stays unavailable until linked Running and Needs you state can be verified. Other Stage changes and Open details remain available.</span></div>;
}

function PreviewOperationalState({ state }: { state: ProjectTodoOperationalState }) {
  return <div data-testid="todo-preview-operational" className={`mt-[18px] flex items-start gap-2.5 rounded-[7px] border px-3 py-[11px] ${previewRuntimeSurface(state)}`}><span className={`mt-[5px] h-2 w-2 shrink-0 rounded-full ${previewRuntimeMark(state)}`} aria-hidden="true" /><span><span className="block text-[10px] font-semibold uppercase tracking-[0.06em] text-text-tertiary">Current activity</span><strong className="mt-[3px] block text-[11.5px] font-semibold leading-[1.45] text-text-primary">{state.label}</strong><span className="mt-[3px] block text-[11.5px] leading-[1.45] text-text-secondary">{previewRuntimeCopy(state)}</span></span></div>;
}

function PreviewLinkedWork({ slug, sessions, activityBySessionId, attentionBySessionId }: {
  slug: string;
  sessions: ProjectSessionInventoryItem[];
  activityBySessionId: ReadonlyMap<string, SessionFamilyActivity>;
  attentionBySessionId: ReadonlyMap<string, ProjectTodoAttentionLabel>;
}) {
  return <section className="mt-5"><h3 className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.05em] text-text-tertiary">Linked work</h3><div className="grid gap-2">{sessions.slice(0, 3).map((item) => {
    const { session } = item;
    const presentation = presentProjectTodoLinkedSession(item, { activity: activityBySessionId.get(session.sessionId), attention: attentionBySessionId.get(session.sessionId) });
    return <Link key={session.sessionId} to={`/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(session.sessionId)}`} aria-label={`${session.title || session.sessionId}, ${presentation.label}`} className="grid min-h-[52px] grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-[9px] rounded-[7px] border border-border-default bg-bg-muted px-[9px] py-[7px] text-inherit transition-[background-color,border-color] duration-[var(--motion-fast)] hover:border-border-strong hover:bg-bg-hover focus-visible:outline-none focus-visible:[box-shadow:var(--focus)]"><span className={`grid h-[27px] w-[27px] place-items-center rounded-[7px] border border-border-subtle ${STATUS_TONE_CLASS[toneForLinked(presentation.kind)]}`} aria-hidden="true"><span className={`h-2 w-2 rounded-full ${previewLinkedOrbit(presentation.kind)}`} /></span><span className="min-w-0"><strong className="block truncate text-[11.5px] font-semibold text-text-primary">{session.title || session.sessionId}</strong><small className="mt-[3px] block truncate text-[9.5px] text-text-tertiary">{presentation.context}</small></span><span className={`whitespace-nowrap text-[10.5px] font-semibold ${STATUS_TONE_CLASS[toneForLinked(presentation.kind)]}`}>{presentation.label}</span></Link>;
  })}</div></section>;
}

function TodoFlatList({ view, todos, filtered, slug, updateTodo, onSelect, onClear }: {
  view: Exclude<TodoSurface, "active">;
  todos: ProjectTodo[];
  filtered: boolean;
  slug: string;
  updateTodo: ReturnType<typeof useUpdateProjectTodo>;
  onSelect: (id: string, trigger: HTMLElement) => void;
  onClear: () => void;
}) {
  return <section className="mx-auto max-w-[980px]" aria-label={view === "rejected" ? "Rejected Todos" : "Archived Todos"}><h2 className="border-b border-border-default pb-3 text-[12px] font-semibold uppercase tracking-[0.05em] text-text-secondary">{view === "rejected" ? "Rejected" : "Archived"}</h2>{todos.length === 0 ? <div className="flex min-h-12 items-center justify-between gap-3 border-b border-border-subtle px-2 text-[11.5px] text-text-tertiary"><span>{todoFlatListEmptyMessage(view, filtered)}</span>{filtered ? <button type="button" onClick={onClear} className="min-h-8 rounded-sm px-2.5 font-semibold text-text-secondary hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:[box-shadow:var(--focus)] [@media(pointer:coarse)]:min-h-11">Clear filter</button> : null}</div> : <div>{todos.map((todo) => <TodoFlatRow key={todo.id} todo={todo} view={view} slug={slug} updateTodo={updateTodo} onSelect={onSelect} />)}</div>}</section>;
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
  return <div className="grid min-h-[66px] grid-cols-[30px_minmax(0,1fr)_auto] items-center gap-3 border-b border-border-subtle px-2 py-2.5 hover:bg-bg-hover"><span className={`grid h-[27px] w-[27px] place-items-center rounded-[7px] border border-border-subtle ${STATUS_TONE_CLASS[presentation.tone]}`}><Icon aria-hidden="true" size={13} /></span><button type="button" data-testid={`todo-${todo.id}`} aria-label={`${displayLead}, ${secondary}`} onClick={(event) => onSelect(todo.id, event.currentTarget)} className="min-w-0 text-left focus-visible:outline-none focus-visible:[box-shadow:var(--focus)]"><span className="line-clamp-2 text-[13.5px] font-semibold leading-[1.35] text-text-primary">{displayLead}</span><span className={`mt-1 block text-[11.5px] leading-[1.35] ${view === "rejected" ? "text-warning" : "text-text-tertiary"}`}>{secondary}</span></button><button type="button" disabled={updateTodo.isPending} onClick={() => updateTodo.mutate({ slug, todoId: todo.id, input: view === "rejected" ? { expectedRevision: todo.revision, status: "idea" } : { expectedRevision: todo.revision, archived: false } })} className="min-h-[34px] rounded-sm border border-border-default bg-bg-active px-2.5 text-[11px] font-semibold text-text-secondary hover:bg-bg-hover focus-visible:outline-none focus-visible:[box-shadow:var(--focus)] disabled:opacity-40 [@media(pointer:coarse)]:min-h-11">{view === "rejected" ? "Restore to Idea" : "Restore"}</button></div>;
}

function FirstUseTodoState() {
  const IdeaIcon = PROJECT_TODO_LANE_PRESENTATIONS.idea.Icon;
  return <div className="mx-auto flex min-h-24 max-w-[980px] items-center gap-3 border-y border-border-subtle px-3 py-4"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-border-strong bg-bg-surface text-brand"><IdeaIcon size={15} aria-hidden="true" /></span><span><strong className="block text-[13px] font-semibold text-text-primary">Start with a Todo</strong><span className="mt-1 block text-[11.5px] leading-[1.6] text-text-tertiary">Capture an idea, bug, refactor, or experiment, then shape it or start work.</span></span></div>;
}

function TodoFilterEmpty({ query, onClear }: { query: string; onClear: () => void }) {
  return <div className="mx-auto flex min-h-16 max-w-[980px] items-center justify-between gap-3 border-y border-border-subtle px-3 py-3"><span><strong className="block text-[12.5px] font-semibold text-text-secondary">No matching Todos</strong><span className="mt-1 block text-[11px] text-text-tertiary">No Todos match “{query.trim()}”. Try another phrase or stable ID.</span></span><button type="button" onClick={onClear} className="min-h-[34px] shrink-0 rounded-sm border border-border-default bg-bg-elevated px-3 text-[11px] font-semibold text-text-secondary hover:border-border-strong hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:[box-shadow:var(--focus)] [@media(pointer:coarse)]:min-h-11">Clear filter</button></div>;
}

function SegmentButton({ children, active, onClick }: { children: React.ReactNode; active: boolean; onClick: () => void }) {
  return <button type="button" aria-pressed={active} onClick={onClick} className={`h-[38px] min-w-0 cursor-pointer rounded-sm px-2.5 text-[11px] font-semibold focus-visible:outline-none focus-visible:[box-shadow:var(--focus)] min-[721px]:h-[30px] ${active ? "bg-bg-elevated text-text-primary shadow-[inset_0_-2px_0_var(--brand)]" : "text-text-secondary hover:text-text-primary"}`}>{children}</button>;
}

function TodoPreviewAction({ children, variant, disabled, onClick }: { children: React.ReactNode; variant: "primary" | "secondary" | "quiet"; disabled?: boolean; onClick: () => void }) {
  const visual = variant === "primary"
    ? "primary-action-button relative overflow-hidden border border-brand bg-brand px-[13px] text-brand-ink hover:-translate-y-px hover:border-brand-hover hover:bg-brand-hover active:translate-y-0 active:scale-[0.98]"
    : variant === "secondary"
      ? "border border-border-default bg-bg-elevated px-[13px] text-text-secondary hover:border-border-strong hover:bg-bg-hover hover:text-text-primary"
      : "border-0 bg-transparent px-2.5 text-text-secondary hover:bg-bg-hover hover:text-text-primary";
  return <button type="button" disabled={disabled} onClick={onClick} className={`inline-flex w-full items-center justify-center gap-1.5 rounded-sm text-[11.5px] font-semibold tracking-[-0.01em] transition-[background-color,border-color,color,box-shadow,transform] duration-[var(--motion-fast)] focus-visible:outline-none focus-visible:[box-shadow:var(--focus)] disabled:cursor-progress disabled:opacity-50 [@media(pointer:coarse)]:min-h-11 ${variant === "primary" ? "min-h-9" : "min-h-[34px]"} ${visual}`}>{children}</button>;
}

function todoListOrbitClass(lane: ProjectTodoLane, state?: ProjectTodoOperationalState): string {
  if (state?.kind === "needs_you") return "border-warning/30 bg-attention-field text-warning";
  if (state?.kind === "running") return "border-signal/30 bg-signal-field text-signal-foreground";
  if (state?.kind === "failed") return "border-error/30 bg-error-field text-error";
  if (state?.kind === "completed" || lane === "ready") return "border-brand/25 bg-brand-field text-brand";
  if (lane === "done") return "border-success/25 bg-success-field text-success";
  return "border-border-subtle bg-bg-muted text-text-tertiary";
}

function stageTriggerTone(lane: ProjectTodoLane): string {
  if (lane === "ready") return "text-text-tertiary [&_strong]:text-brand";
  if (lane === "done") return "text-text-tertiary [&_strong]:text-success";
  return "text-text-tertiary [&_strong]:text-text-secondary";
}

function toneForOperational(state: ProjectTodoOperationalState): StatusTone {
  return state.kind === "needs_you" ? "warning"
    : state.kind === "running" ? "signal"
      : state.kind === "completed" ? "brand"
        : state.kind === "failed" ? "error" : "neutral";
}

function toneForLinked(kind: ReturnType<typeof presentProjectTodoLinkedSession>["kind"]): StatusTone {
  return kind === "needs_you" || kind === "paused" ? "warning"
    : kind === "running" ? "signal"
      : kind === "completed" ? "success"
        : kind === "failed" ? "error" : "neutral";
}

function labelForStatus(status: ProjectTodoLane): string {
  return status === "idea" ? "Idea" : status === "ready" ? "Ready" : status === "in_progress" ? "In progress" : "Done";
}

function previewRuntimeSurface(state: ProjectTodoOperationalState): string {
  if (state.kind === "running") return "border-signal/25 bg-signal-field";
  if (state.kind === "completed") return "border-brand/25 bg-brand-field";
  if (state.kind === "failed") return "border-error/25 bg-error-field";
  if (state.kind === "enabled") return "border-border-default bg-bg-muted";
  if (state.kind === "needs_you") return "border-warning/25 bg-attention-field";
  return "border-border-default bg-bg-muted";
}

function previewRuntimeMark(state: ProjectTodoOperationalState): string {
  if (state.kind === "running") return "border-[1.5px] border-signal-foreground bg-transparent animate-activity-pulse";
  if (state.kind === "completed") return "bg-brand";
  if (state.kind === "failed") return "bg-error";
  if (state.kind === "enabled") return "bg-text-muted";
  if (state.kind === "needs_you") return "bg-warning";
  return "bg-text-muted";
}

function previewLinkedOrbit(kind: ReturnType<typeof presentProjectTodoLinkedSession>["kind"]): string {
  if (kind === "running") return "border-[1.5px] border-signal-foreground bg-transparent animate-activity-pulse";
  if (kind === "needs_you") return "bg-warning";
  if (kind === "failed") return "bg-error";
  if (kind === "completed") return "bg-success";
  if (kind === "enabled") return "bg-border-strong";
  return "bg-border-strong";
}

function previewRuntimeCopy(state: ProjectTodoOperationalState): string {
  const detail = state.detail !== state.label ? state.detail : undefined;
  if (state.kind === "needs_you") return detail === undefined ? "A linked Session is waiting before work can continue." : `Lead · ${detail}`;
  if (state.kind === "failed") return detail === undefined ? "The latest linked attempt failed and needs recovery." : `The latest linked attempt failed · ${detail}`;
  if (state.kind === "running") return detail === undefined ? "Execution is attached to this Todo." : `Lead · ${detail}`;
  if (state.kind === "enabled") return "A linked Automation has a future run scheduled.";
  if (state.kind === "pending") return "A linked Session is waiting, but no exact user action is currently identified.";
  return "Implementation is waiting for review.";
}

function compareSessionItemUpdated(left: ProjectSessionInventoryItem, right: ProjectSessionInventoryItem): number {
  return right.session.updatedAt - left.session.updatedAt || left.session.sessionId.localeCompare(right.session.sessionId);
}

function isRevisionConflict(cause: unknown): boolean {
  return cause instanceof ApiError && cause.status === 409;
}

function messageFor(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Action failed";
}
