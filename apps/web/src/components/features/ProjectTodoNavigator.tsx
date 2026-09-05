import { useState, type ReactNode, type Ref } from "react";
import {
  Activity,
  CalendarClock,
  Ellipsis,
  ListTodo,
  Plus,
  X,
} from "lucide-react";
import { Link } from "react-router-dom";
import type { Project } from "../../api/types";
import type {
  ProjectNavigationDependencyState,
  ProjectTodoNavigationProjection,
  ProjectTodoNavigationRow,
} from "../../routes/project-todo-navigation";
import type { VisualStatusKind } from "../../lib/status-visuals";
import { PrimaryActionButton } from "../primitives/PrimaryActionButton";
import { CloseProjectDialog } from "./CloseProjectDialog";
import { EditProjectDialog } from "./EditProjectDialog";
import { ProjectActionDropdown } from "./ProjectActionMenu";

export function ProjectTodoNavigator({
  project,
  projection,
  newTodoTriggerRef,
  retrying,
  onClose,
  onNewTodo,
  onProjectClosed,
  onRetry,
}: {
  project: Project;
  projection: ProjectTodoNavigationProjection;
  newTodoTriggerRef: Ref<HTMLButtonElement>;
  retrying: boolean;
  onClose?: () => void;
  onNewTodo: () => void;
  onProjectClosed: (project: Project) => void;
  onRetry: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [closing, setClosing] = useState(false);
  const root = `/projects/${encodeURIComponent(project.slug)}`;

  return (
    <aside
      data-project-todo-navigator
      aria-label={`${project.name} Todo navigator`}
      className="flex h-full w-[276px] shrink-0 flex-col overflow-hidden border-r border-border-default bg-bg-surface text-text-primary"
    >
      <div className="flex h-16 shrink-0 items-center gap-2 border-b border-border-subtle px-3">
        <ProjectActionDropdown
          project={project}
          onEdit={() => setEditing(true)}
          onClose={() => setClosing(true)}
          trigger={(
            <button
              type="button"
              aria-label={`Project actions for ${project.name}`}
              className="group flex min-w-0 flex-1 items-center gap-2 rounded-[var(--shape-control)] px-0.5 py-1.5 text-left transition-colors duration-[var(--motion-fast)] hover:bg-bg-hover focus-visible:outline-none focus-visible:[box-shadow:var(--focus)]"
            >
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[var(--shape-control)] border border-border-subtle bg-bg-muted text-[11px] font-bold lowercase text-brand">
                {project.slug.slice(0, 2)}
              </span>
              <span className="min-w-0 flex-1">
                <strong className="block truncate text-[14px] font-semibold leading-4 tracking-[-0.02em]">{project.name}</strong>
                <span className="mt-1 block truncate font-mono text-[10px] leading-3 text-text-tertiary">{project.workspaceRoot}</span>
              </span>
              <Ellipsis size={15} className="shrink-0 text-text-tertiary opacity-0 transition-opacity duration-[var(--motion-fast)] group-hover:opacity-100 group-focus-visible:opacity-100" aria-hidden="true" />
            </button>
          )}
        />
        {onClose ? (
          <button
            type="button"
            aria-label="Close navigation"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-[var(--shape-control)] text-text-tertiary transition-colors duration-[var(--motion-fast)] hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:[box-shadow:var(--focus)]"
            onClick={onClose}
          >
            <X size={16} aria-hidden="true" />
          </button>
        ) : null}
      </div>

      <div className="shrink-0 px-3 py-3">
        <PrimaryActionButton
          ref={newTodoTriggerRef}
          className="!h-[34px] w-full rounded-[var(--shape-card)] text-[11.5px] shadow-[0_5px_14px_rgb(69_60_170_/_24%)] [@media(pointer:coarse)]:!h-11"
          onClick={onNewTodo}
        >
          <Plus size={14} aria-hidden="true" /> New todo
        </PrimaryActionButton>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-4" aria-label="Todo workspace">
        <NavigationSection label="Views">
          <NavigatorLink
            to={`${root}/todos`}
            label="All todos"
            count={projection.allTodos.count}
            current={projection.allTodos.current}
            state={projection.allTodos.state}
            icon={<ListTodo size={14} aria-hidden="true" />}
            retrying={retrying}
            onRetry={onRetry}
          />
        </NavigationSection>

        <TodoGroup
          label="Needs you"
          attention
          count={projection.needsYou.count}
          rows={projection.needsYou.rows}
          root={root}
          state={projection.needsYou.state}
          retrying={retrying}
          onRetry={onRetry}
        />
        {projection.running.state === "ready" && projection.running.rows.length > 0 ? (
          <TodoGroup label="Running" running count={projection.running.count} rows={projection.running.rows} root={root} state="ready" />
        ) : null}
        <TodoGroup label="In progress" count={projection.inProgress.count} rows={projection.inProgress.rows} root={root} state={projection.inProgress.state} retrying={retrying} onRetry={onRetry} />
        <TodoGroup label="Ready" count={projection.ready.count} rows={projection.ready.rows} root={root} state={projection.ready.state} retrying={retrying} onRetry={onRetry} />

        <NavigationSection label="Operations">
          <NavigatorLink
            to={`${root}/sessions`}
            label="Runs"
            count={projection.runs.count}
            current={projection.runs.current}
            state={projection.runs.state}
            icon={<Activity size={14} aria-hidden="true" />}
            retrying={retrying}
            onRetry={onRetry}
          />
          <NavigatorLink
            to={`${root}/automations`}
            label="Schedules"
            count={projection.schedules.count}
            current={projection.schedules.current}
            state={projection.schedules.state}
            icon={<CalendarClock size={14} aria-hidden="true" />}
            retrying={retrying}
            onRetry={onRetry}
          />
        </NavigationSection>
      </nav>

      <EditProjectDialog open={editing} onClose={() => setEditing(false)} project={project} />
      <CloseProjectDialog
        open={closing}
        onClose={() => setClosing(false)}
        project={project}
        onClosed={onProjectClosed}
      />
    </aside>
  );
}

function NavigationSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="mb-4" aria-label={label}>
      <h2 className="mb-1.5 px-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-text-muted">{label}</h2>
      <div className="grid gap-0.5">{children}</div>
    </section>
  );
}

function TodoGroup({
  label,
  attention = false,
  running = false,
  count,
  rows,
  root,
  state,
  retrying = false,
  onRetry,
}: {
  label: string;
  attention?: boolean;
  running?: boolean;
  count?: number;
  rows: readonly ProjectTodoNavigationRow[];
  root: string;
  state: ProjectNavigationDependencyState;
  retrying?: boolean;
  onRetry?: () => void;
}) {
  return (
    <section className="mb-4" aria-labelledby={`project-nav-${label.toLowerCase().replace(/\s+/gu, "-")}`}>
      <div className="mb-1 flex h-5 items-center justify-between px-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-text-muted">
        <h2 id={`project-nav-${label.toLowerCase().replace(/\s+/gu, "-")}`}>{label}</h2>
        {count === undefined ? null : <span className="font-mono tabular-nums">{count}</span>}
      </div>
      {state === "loading" ? <p role="status" className="px-2 py-1.5 text-[10.5px] text-text-tertiary">Syncing…</p> : null}
      {state === "error" ? (
        <div className="flex items-center justify-between gap-2 px-2 py-1.5 text-[10.5px] text-error">
          <span>Unavailable</span>
          {onRetry ? <button type="button" disabled={retrying} className="font-semibold underline disabled:opacity-50" onClick={onRetry}>{retrying ? "Retrying…" : "Retry"}</button> : null}
        </div>
      ) : null}
      {state === "ready" ? <div className="grid gap-0.5">{rows.map((row) => {
        const visualKind = running ? "running" : row.operationalState?.kind ?? (attention ? "needs_you" : label === "Ready" ? "enabled" : "idle");
        const announcedState = running ? "Working" : row.operationalState?.label;
        const destination = running && row.targetSessionId !== undefined
          ? `${root}/sessions/${encodeURIComponent(row.targetSessionId)}`
          : `${root}/todos/${encodeURIComponent(row.todo.id)}${attention ? "/work" : ""}`;
        return <Link
          key={`${label}:${row.todo.id}`}
          to={destination}
          aria-current={row.current ? "page" : undefined}
          className={`group flex h-[38px] min-w-0 items-center gap-2 rounded-[7px] border-l-2 px-2 text-[12px] transition-[background-color,color,border-color] duration-[var(--motion-fast)] focus-visible:outline-none focus-visible:[box-shadow:var(--focus)] ${row.current ? "border-brand bg-selection-field text-text-primary shadow-[inset_0_0_0_1px_var(--border-default)]" : "border-transparent text-text-secondary hover:bg-bg-hover hover:text-text-primary"}`}
        >
          <TodoNavigatorStatusMarker kind={visualKind} />
          <span className="min-w-0 flex-1 truncate">{row.label}</span>
          {announcedState ? <span className="sr-only" data-testid="todo-navigator-row-status">{announcedState}</span> : null}
          {attention && row.attentionCount !== undefined ? <span className="min-w-[18px] text-right font-mono text-[10.5px] tabular-nums text-warning" aria-label={`${row.attentionCount} ${row.attentionCount === 1 ? "action" : "actions"} need you`}>{row.attentionCount}</span> : null}
        </Link>
      })}</div> : null}
    </section>
  );
}

function TodoNavigatorStatusMarker({ kind }: { kind: VisualStatusKind }) {
  const presentation = navigatorStatusMarker(kind);
  return (
    <span
      aria-hidden="true"
      className={`h-[7px] w-[7px] shrink-0 rounded-full ${presentation.className}`}
      data-navigator-status={presentation.name}
    />
  );
}

function navigatorStatusMarker(kind: VisualStatusKind): { readonly name: string; readonly className: string } {
  if (kind === "running" || kind === "loading") {
    return { name: "live", className: "animate-activity-pulse bg-signal" };
  }
  if (kind === "needs_you" || kind === "warning" || kind === "blocked" || kind === "budget_limited") {
    return { name: "attention", className: "bg-warning shadow-[0_0_0_3px_color-mix(in_srgb,var(--warning)_10%,transparent)]" };
  }
  if (kind === "completed") return { name: "review", className: "bg-brand" };
  if (kind === "failed") return { name: "error", className: "bg-error" };
  if (kind === "enabled") return { name: "ready", className: "border border-brand bg-transparent" };
  return { name: "neutral", className: "bg-text-muted" };
}

function NavigatorLink({
  to,
  label,
  count,
  current,
  state,
  icon,
  retrying,
  onRetry,
}: {
  to: string;
  label: string;
  count?: number;
  current: boolean;
  state: ProjectNavigationDependencyState;
  icon: ReactNode;
  retrying: boolean;
  onRetry: () => void;
}) {
  const rowTone = current
    ? "border-brand bg-selection-field text-text-primary shadow-[inset_0_0_0_1px_var(--border-default)]"
    : "border-transparent text-text-secondary hover:bg-bg-hover hover:text-text-primary";
  return (
    <div className={`flex h-[38px] min-w-0 items-center rounded-[7px] border-l-2 pr-1 text-[12px] transition-[background-color,color,border-color] duration-[var(--motion-fast)] [@media(pointer:coarse)]:h-11 ${rowTone}`}>
      <Link
        to={to}
        aria-current={current ? "page" : undefined}
        className="flex min-w-0 flex-1 self-stretch items-center gap-2 rounded-[6px] pl-2 focus-visible:outline-none focus-visible:[box-shadow:var(--focus)]"
      >
        <span className="shrink-0 text-text-tertiary">{icon}</span>
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </Link>
      {state === "ready" && count !== undefined ? <span className="px-1 font-mono text-[10px] tabular-nums text-text-tertiary">{count}</span> : null}
      {state === "loading" ? <span role="status" aria-label={`${label} loading`} className="px-1 text-[10px] text-text-tertiary">Loading…</span> : null}
      {state === "error" ? <>
        <span role="alert" className="px-1 text-[10px] text-error">Unavailable</span>
        <button type="button" aria-label={`Retry ${label}`} disabled={retrying} className="rounded-sm px-1.5 py-1 text-[10px] font-semibold text-error underline underline-offset-2 focus-visible:outline-none focus-visible:[box-shadow:var(--focus)] disabled:opacity-50" onClick={onRetry}>{retrying ? "Retrying…" : "Retry"}</button>
      </> : null}
    </div>
  );
}
