import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import {
  ChevronRight,
  LayoutDashboard,
  ListTodo,
  MoreHorizontal,
  Plus,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { useCreateSession, usePostMessage } from "../../api/mutations";
import { useAutomations, useProjects, useProjectTodos, useSessions } from "../../api/queries";
import type {
  Automation,
  Project,
  SessionSummary,
  SessionSummaryWithGoal,
} from "../../api/types";
import type { SessionFamilyActivity } from "@archcode/protocol";
import { ProjectActionDropdown } from "./ProjectActionMenu";
import { EditProjectDialog } from "./EditProjectDialog";
import { CloseProjectDialog } from "./CloseProjectDialog";
import { DeleteSessionDialog } from "./DeleteSessionDialog";
import {
  runtimeFamilyKey,
  useSessionRuntimeFamilies,
  useSessionRuntimeInitialized,
} from "../../store/session-runtime-store";
import {
  selectSessionFamilyHitl,
  type ScopedHitlView,
  useAttentionVisibleScopedHitl,
} from "../../store/hitl-store";
import { StatusGlyph } from "../primitives/StatusGlyph";
import { GoalStatusMark } from "./GoalStatusMark";
import { presentSessionGoalStatus } from "../../lib/session-goal-presentation";
import { automationVisualKind } from "../../lib/automation-status-presentation";
import { sessionFamilyActivityLabel, sessionFamilyVisual } from "../../lib/session-family-presentation";
import {
  RelativeTimeValue,
  useRelativeTimePresentation,
} from "../primitives/TemporalText";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRoot,
  DropdownMenuTrigger,
} from "../ui/DropdownMenu";

// Helpers

/** Robust lowercase string conversion that never throws on nullish/unknown values. */
function toSearchable(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return String(value);
  } catch {
    return "";
  }
}

// Tab model

type SidebarTab = "sessions" | "automations";

const TABS: Array<{ id: SidebarTab; label: string }> = [
  { id: "sessions", label: "Sessions" },
  { id: "automations", label: "Automations" },
];

export function deriveSidebarTabFromPath(pathname: string): SidebarTab | null {
  if (pathname.includes("/sessions/")) return "sessions";
  if (pathname.includes("/automations")) return "automations";
  return null;
}

// Session list projection

type SessionListGroup = "needs-you" | "running" | "recent";

interface SessionAttention {
  readonly count: number;
  readonly label: "Permission" | "Question" | "Requests";
}

interface SidebarSessionRow {
  readonly session: SessionSummaryWithGoal;
  readonly activity: SessionFamilyActivity | undefined;
  readonly attention?: SessionAttention;
}

function sessionAttention(entries: readonly ScopedHitlView[]): SessionAttention | undefined {
  const primary = entries[0];
  if (!primary) return undefined;
  const sourceTypes = new Set(entries.map((entry) => entry.view.source.type));
  return {
    count: entries.length,
    label: sourceTypes.size > 1
      ? "Requests"
      : primary.view.source.type === "tool_permission"
        ? "Permission"
        : "Question",
  };
}

function attentionLabel(attention: SessionAttention): string {
  return attention.label === "Requests"
    ? `${attention.count} requests`
    : attention.label;
}

function sessionListGroup(
  activity: SessionFamilyActivity | undefined,
  attention: SessionAttention | undefined,
): SessionListGroup {
  if (attention) return "needs-you";
  if (activity !== undefined && activity !== "idle") return "running";
  return "recent";
}

function sessionStateLabel(
  activity: SessionFamilyActivity | undefined,
  attention: SessionAttention | undefined,
): string {
  if (attention) return "Needs attention";
  return sessionFamilyActivityLabel(activity);
}

// Status glyphs

function SessionStatusGlyph({
  activity,
  attention,
}: {
  activity: SessionFamilyActivity | undefined;
  attention?: SessionAttention;
}) {
  if (attention) return <StatusGlyph kind="needs_you" tone="warning" label="Needs attention" size={12} />;
  const visual = sessionFamilyVisual(activity);
  return <StatusGlyph kind={visual.kind} tone={visual.tone} label={sessionStateLabel(activity, undefined)} size={12} />;
}

function AutomationStatusGlyph({ status }: { status: Automation["status"] }) {
  return <StatusGlyph kind={automationVisualKind(status)} label={`Automation ${status}`} size={10} />;
}

// List items

function SessionItem({
  session,
  activity,
  attention,
  isActive,
  onClick,
  onDelete,
}: {
  session: SessionSummaryWithGoal;
  activity: SessionFamilyActivity | undefined;
  attention?: SessionAttention;
  isActive: boolean;
  onClick: () => void;
  onDelete: () => void;
}) {
  const updatedAt = session.updatedAt;
  const goalLabel = session.goal ? presentSessionGoalStatus(session.goal.status).label : undefined;
  const stateLabel = sessionStateLabel(activity, attention);
  const visibleAttentionLabel = attention ? attentionLabel(attention) : undefined;
  const relativeUpdatedAt = useRelativeTimePresentation(updatedAt);
  const accessibleName = [
    session.title || "Untitled",
    stateLabel,
    attention
      ? attention.label === "Requests"
        ? `${attention.count} requests waiting`
        : `${attention.label} waiting${attention.count > 1 ? `, ${attention.count} requests` : ""}`
      : undefined,
    goalLabel ? `Goal ${goalLabel}` : undefined,
    relativeUpdatedAt.full,
  ].filter((part): part is string => part !== undefined).join(" · ");

  return (
    <div
      className={`group relative flex h-9 min-h-9 w-full items-center transition-colors duration-[var(--motion-hover)] [@media(pointer:coarse)]:min-h-11 ${
        isActive ? "bg-selection-field" : "hover:bg-bg-hover"
      }`}
    >
      {isActive && (
        <div className="absolute inset-y-1 left-0 w-0.5 rounded-r-sm bg-brand" aria-hidden="true" />
      )}
      <button
        type="button"
        aria-current={isActive ? "page" : undefined}
        aria-label={accessibleName}
        className="flex h-9 min-h-9 min-w-0 flex-1 items-center gap-2 py-0 pl-4 pr-10 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand [@media(pointer:coarse)]:min-h-11"
        data-testid={`sidebar-session-${session.sessionId}`}
        onClick={onClick}
      >
        <SessionStatusGlyph activity={activity} attention={attention} />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-text-primary" data-testid={`sidebar-session-title-${session.sessionId}`}>
          {session.title || "Untitled"}
        </span>
        <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-text-tertiary transition-opacity group-hover:opacity-0 group-focus-within:opacity-0 [@media(pointer:coarse)]:hidden">
          {session.goal && (
            <span title={`Goal ${goalLabel}`} data-testid={`sidebar-session-goal-${session.sessionId}`}>
              <GoalStatusMark identity={session.goal.instanceId} status={session.goal.status} size={11} label={`Goal ${goalLabel}`} />
            </span>
          )}
          {attention && (
            <span
              className="inline-flex items-center gap-1 font-medium text-warning"
              data-testid={`sidebar-session-attention-${session.sessionId}`}
              title={attention.label === "Requests"
                ? `${attention.count} mixed requests need attention`
                : `${attention.count} ${attention.label.toLowerCase()} request${attention.count === 1 ? "" : "s"} need attention`}
            >
              <StatusGlyph kind="needs_you" tone="warning" size={11} />
              <span>{visibleAttentionLabel}</span>
            </span>
          )}
          <RelativeTimeValue timestamp={updatedAt} text={relativeUpdatedAt.short} />
        </span>
      </button>
      <DropdownMenuRoot>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Actions for ${session.title || "Untitled Session"}`}
            className="absolute right-2 flex h-7 w-7 items-center justify-center rounded-sm text-text-tertiary opacity-0 transition-[color,background-color,opacity] duration-[var(--motion-hover)] hover:bg-bg-active hover:text-text-primary focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand group-hover:opacity-100 group-focus-within:opacity-100 [@media(pointer:coarse)]:h-9 [@media(pointer:coarse)]:w-9 [@media(pointer:coarse)]:opacity-100"
          >
            <MoreHorizontal size={14} aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[168px]">
          <DropdownMenuItem
            className="text-error focus:bg-error-muted focus:text-error data-[highlighted]:bg-error-muted"
            onSelect={onDelete}
          >
            <Trash2 size={13} aria-hidden="true" />
            Delete Session
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenuRoot>
    </div>
  );
}

function AutomationItem({
  automation,
  isActive,
  onClick,
}: {
  automation: Automation;
  isActive: boolean;
  onClick: () => void;
}) {
  const scheduleLabel = automation.trigger.kind === "once" ? "once" : automation.trigger.kind === "interval" ? `interval ${automation.trigger.everyMs}ms` : `cron ${automation.trigger.expression}`;
  const actionLabel = automation.action.kind.replaceAll("_", " ");
  const accessibleName = `${automation.name} · ${automation.status} · ${scheduleLabel} · ${actionLabel} · ${automation.id}`;

  return (
    <button
      type="button"
      aria-current={isActive ? "page" : undefined}
      aria-label={accessibleName}
      title={accessibleName}
      className={`relative flex h-8 min-h-8 w-full items-center gap-2 px-4 text-left transition-colors duration-[var(--motion-hover)] [@media(pointer:coarse)]:min-h-11 ${
        isActive ? "bg-brand-subtle" : "hover:bg-bg-hover"
      }`}
      data-testid={`sidebar-automation-${automation.id}`}
      onClick={onClick}
    >
      {isActive && (
        <div className="absolute left-0 top-2 bottom-2 w-0.5 rounded-r-sm bg-brand" />
      )}
      <AutomationStatusGlyph status={automation.status} />
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-text-primary">
        {automation.name}
      </span>
      <span className="max-w-[42%] shrink-0 truncate font-mono text-[11px] text-text-tertiary">
        {scheduleLabel}
      </span>
    </button>
  );
}

// Shared sub-components

const SEARCH_INPUT_CLASS =
  "w-full rounded-md border border-border-control bg-bg-elevated px-3 py-2 text-[13px] text-text-primary placeholder:text-text-muted transition-colors duration-[var(--motion-hover)] focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand-subtle";

function CreateButton({
  onClick,
  title,
  label,
  disabled,
}: {
  onClick: () => void;
  title: string;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className="inline-flex h-8 shrink-0 items-center justify-center gap-2 rounded-md border border-brand bg-brand px-3 text-[12px] font-semibold text-brand-ink transition-colors duration-[var(--motion-hover)] hover:border-brand-hover hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-45"
    >
      <Plus size={13} />
      <span className="whitespace-nowrap">{label}</span>
    </button>
  );
}

function SubGroupHeader({ title, count }: { title: string; count?: number }) {
  return (
    <div className="flex items-center justify-between px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">
      <span>{title}</span>
      {count !== undefined && (
        <span style={{ fontSize: 10, textTransform: "none", letterSpacing: 0, fontWeight: 400 }}>
          {count}
        </span>
      )}
    </div>
  );
}

function EmptyRow({ children }: { children: React.ReactNode }) {
  return <div className="px-4 py-2 text-[11px] text-text-tertiary">{children}</div>;
}

function DashboardLinkButton({
  to,
  label,
  isActive,
  icon: Icon = LayoutDashboard,
  count,
}: {
  to: string;
  label: string;
  isActive: boolean;
  icon?: LucideIcon;
  count?: number;
}) {
  return (
    <Link
      to={to}
      aria-current={isActive ? "page" : undefined}
      aria-label={count === undefined ? undefined : `${label}, ${count} open`}
      className={`group relative flex h-8 items-center gap-2 rounded-sm px-3 text-[12px] font-medium transition-colors ${isActive
        ? "bg-brand-subtle text-brand"
        : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
      }`}
    >
      {isActive && <span className="absolute inset-y-1 left-0 w-0.5 rounded-r-sm bg-brand" aria-hidden="true" />}
      <Icon size={13} className="shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined && (
        <span
          data-testid="sidebar-todo-count"
          className="shrink-0 text-[11px] font-semibold tabular-nums text-text-tertiary"
          aria-hidden="true"
        >
          {count}
        </span>
      )}
      <ChevronRight size={12} className="shrink-0 text-text-muted transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
    </Link>
  );
}

// Sidebar

export function Sidebar() {
  const navigate = useNavigate();
  const location = useLocation();
  const { slug = "", sessionId = "", automationId = "" } = useParams<{
    slug: string;
    sessionId: string;
    automationId: string;
  }>();
  const createSession = useCreateSession();
  const postMessage = usePostMessage();
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [closingProject, setClosingProject] = useState<Project | null>(null);
  const [deletingSession, setDeletingSession] = useState<SessionSummaryWithGoal | null>(null);

  const [sessionsSearch, setSessionsSearch] = useState("");
  const [automationsSearch, setAutomationsSearch] = useState("");
  const [selectedTab, setSelectedTab] = useState<SidebarTab>(deriveSidebarTabFromPath(location.pathname) ?? "sessions");

  const { data: projects } = useProjects();
  const activeProject = projects?.find(p => p.slug === slug) ?? null;
  const { data: sessions } = useSessions(slug);
  const { data: automations } = useAutomations(slug);
  const { data: projectTodos } = useProjectTodos(slug);
  const runtimeInitialized = useSessionRuntimeInitialized(slug);
  const runtimeFamilies = useSessionRuntimeFamilies();
  const attentionVisibleHitl = useAttentionVisibleScopedHitl([slug]);
  const openTodoCount = projectTodos?.filter((todo) => (
    todo.archivedAt === undefined
    && todo.status !== "done"
    && todo.status !== "rejected"
  )).length;

  const routeTab = deriveSidebarTabFromPath(location.pathname);
  const activeTab = selectedTab;

  useEffect(() => {
    if (routeTab !== null) setSelectedTab(routeTab);
  }, [routeTab]);

  // Handlers

  const handleNewSession = () => {
    createSession.mutate({ slug }, {
      onSuccess: (session) => {
        navigate(`/projects/${slug}/sessions/${session.sessionId}`);
      },
    });
  };

  const handleNewSkillSession = (skill: "automation-create") => {
    createSession.mutate({ slug }, {
      onSuccess: (session) => {
        navigate(`/projects/${slug}/sessions/${session.sessionId}`);
        postMessage.mutate({
          slug,
          sessionId: session.sessionId,
          content: `/skill use ${skill}`,
          attachmentIds: [],
          requestedModelSelection: session.nextModelSelection.requested,
        });
      },
    });
  };

  const handleSessionClick = (clickedSessionId: string) => {
    navigate(`/projects/${slug}/sessions/${clickedSessionId}`);
  };

  const handleAutomationClick = (clickedAutomationId: string) => {
    navigate(`/projects/${slug}/automations/${clickedAutomationId}`);
  };

  // Filtered lists

  const filteredSessions = useMemo<SessionSummaryWithGoal[]>(() => {
    if (!sessions) return [];
    const rootSessions = sessions.filter(s => !s.parentSessionId);
    if (!sessionsSearch.trim()) return rootSessions;
    const q = sessionsSearch.toLowerCase();
    return rootSessions.filter((s) => {
      const title = toSearchable(s.title || "Untitled").toLowerCase();
      const id = toSearchable(s.sessionId).toLowerCase();
      return title.includes(q) || id.includes(q);
    });
  }, [sessions, sessionsSearch]);

  const sessionGroups = useMemo(() => {
    const groups: Record<SessionListGroup, SidebarSessionRow[]> = {
      "needs-you": [],
      running: [],
      recent: [],
    };
    for (const session of filteredSessions) {
      const activity = runtimeInitialized
        ? runtimeFamilies[runtimeFamilyKey(slug, session.sessionId)]?.activity ?? "idle"
        : undefined;
      const attention = sessionAttention(selectSessionFamilyHitl(attentionVisibleHitl, slug, session.sessionId));
      const group = sessionListGroup(activity, attention);
      groups[group].push({ session, activity, attention });
    }
    return groups;
  }, [attentionVisibleHitl, filteredSessions, runtimeFamilies, runtimeInitialized, slug]);

  const filteredAutomations = useMemo(() => {
    const list = automations ?? [];
    if (!automationsSearch.trim()) return list;
    const q = automationsSearch.toLowerCase();
    return list.filter((automation) => {
      return [automation.id, automation.name, automation.status, automation.trigger.kind, automation.action.kind]
        .some((value) => toSearchable(value).toLowerCase().includes(q));
    });
  }, [automations, automationsSearch]);

  // Render

  return (
    <div id="project-sidebar" className="h-full bg-bg-surface flex flex-col overflow-hidden">
      <div className="shrink-0 border-b border-border-subtle px-4 pb-2 pt-3 max-[760px]:pr-12">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="font-semibold text-[13px] text-text-primary truncate">
              {activeProject?.name ?? "Project unavailable"}
            </div>
            {activeProject && (
              <div className="mt-px truncate font-mono text-[11px] text-text-tertiary">
                {activeProject.workspaceRoot}
              </div>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
          {activeProject && (
            <ProjectActionDropdown
              project={activeProject}
              onEdit={setEditingProject}
              onClose={setClosingProject}
              trigger={
                <button
                  aria-label="Project actions"
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-sm text-text-tertiary transition-colors duration-[var(--motion-hover)] hover:bg-bg-hover hover:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"
                  title="Project actions"
                >
                  ⋯
                </button>
              }
            />
          )}
          </div>
        </div>
        <div className="mt-2">
          <DashboardLinkButton
            to={`/projects/${slug}`}
            label="Project Dashboard"
            isActive={location.pathname === `/projects/${slug}`}
          />
          <div className="h-1" />
          <DashboardLinkButton
            to={`/projects/${slug}/todos`}
            label="Todos"
            isActive={location.pathname === `/projects/${slug}/todos`}
            icon={ListTodo}
            count={openTodoCount}
          />
        </div>
      </div>

      <div
        className="flex items-center gap-1 px-2 border-b border-border-subtle shrink-0 bg-bg-surface"
        role="tablist"
        aria-label="Sidebar sections"
      >
        {TABS.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              id={`sidebar-tab-${tab.id}`}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-controls={`sidebar-panel-${tab.id}`}
              className={`flex-1 px-3 py-2 text-[12px] font-medium transition-colors duration-[var(--motion-hover)] cursor-pointer border-b-2 ${
                isActive
                  ? "text-text-primary border-brand"
                  : "text-text-tertiary border-transparent hover:text-text-secondary"
              }`}
              onClick={() => setSelectedTab(tab.id)}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      <div className="flex-1 overflow-y-auto pb-4">
        <section
          id="sidebar-panel-sessions"
          role="tabpanel"
          aria-labelledby="sidebar-tab-sessions"
          hidden={activeTab !== "sessions"}
        >
          <div className="px-3 py-2 space-y-2">
            <div className="flex items-center gap-2">
              <input
                type="text"
                aria-label="Search sessions"
                placeholder="Search sessions..."
                value={sessionsSearch}
                onChange={(e) => setSessionsSearch(e.target.value)}
                className={SEARCH_INPUT_CLASS}
              />
              <CreateButton
                onClick={handleNewSession}
                title="New session"
                label="New session"
                disabled={createSession.isPending}
              />
            </div>
          </div>

          {sessionGroups["needs-you"].length > 0 && (
            <div className="mb-1" data-testid="sidebar-session-group-needs-you">
              <SubGroupHeader title="Needs you" count={sessionGroups["needs-you"].length} />
              {sessionGroups["needs-you"].map(({ session, activity, attention }) => (
                <SessionItem
                  key={session.sessionId}
                  session={session}
                  activity={activity}
                  attention={attention}
                  isActive={session.sessionId === sessionId}
                  onClick={() => handleSessionClick(session.sessionId)}
                  onDelete={() => setDeletingSession(session)}
                />
              ))}
            </div>
          )}

          {sessionGroups.running.length > 0 && (
            <div className="mb-1" data-testid="sidebar-session-group-running">
              <SubGroupHeader title="Running" count={sessionGroups.running.length} />
              {sessionGroups.running.map(({ session, activity, attention }) => (
                <SessionItem
                  key={session.sessionId}
                  session={session}
                  activity={activity}
                  attention={attention}
                  isActive={session.sessionId === sessionId}
                  onClick={() => handleSessionClick(session.sessionId)}
                  onDelete={() => setDeletingSession(session)}
                />
              ))}
            </div>
          )}

          {sessionGroups.recent.length > 0 && (
            <div className="mb-1" data-testid="sidebar-session-group-recent">
              <SubGroupHeader title="Recent" count={sessionGroups.recent.length} />
              {sessionGroups.recent.map(({ session, activity, attention }) => (
                <SessionItem
                  key={session.sessionId}
                  session={session}
                  activity={activity}
                  attention={attention}
                  isActive={session.sessionId === sessionId}
                  onClick={() => handleSessionClick(session.sessionId)}
                  onDelete={() => setDeletingSession(session)}
                />
              ))}
            </div>
          )}

          {filteredSessions.length === 0 && (
            <EmptyRow>
              {sessionsSearch ? "No matching sessions" : "No sessions yet"}
            </EmptyRow>
          )}

        </section>

        <section
          id="sidebar-panel-automations"
          role="tabpanel"
          aria-labelledby="sidebar-tab-automations"
          hidden={activeTab !== "automations"}
        >
          <div className="px-3 py-2 space-y-2">
            <DashboardLinkButton
              to={`/projects/${slug}/automations`}
              label="Automations"
              isActive={location.pathname === `/projects/${slug}/automations`}
            />
            <div className="flex items-center gap-2">
              <input
                type="text"
                aria-label="Search automations"
                placeholder="Search automations..."
                value={automationsSearch}
                onChange={(e) => setAutomationsSearch(e.target.value)}
                className={SEARCH_INPUT_CLASS}
              />
              <CreateButton
                onClick={() => handleNewSkillSession("automation-create")}
                title="New automation"
                label="New automation"
                disabled={!slug || createSession.isPending}
              />
            </div>
          </div>

          {filteredAutomations.length === 0 ? (
            <EmptyRow>
              {automationsSearch ? "No matching automations" : "No automations yet"}
            </EmptyRow>
          ) : (
            filteredAutomations.map((automation) => (
              <AutomationItem
                key={automation.id}
                automation={automation}
                isActive={automation.id === automationId}
                onClick={() => handleAutomationClick(automation.id)}
              />
            ))
          )}
        </section>
      </div>

      {editingProject && (
        <EditProjectDialog
          open
          onClose={() => setEditingProject(null)}
          project={editingProject}
        />
      )}

      {deletingSession && activeProject && (
        <DeleteSessionDialog
          automations={automations ?? []}
          onClose={() => setDeletingSession(null)}
          onDeleted={(deleted) => {
            setDeletingSession(null);
            if (sessionId === deleted.rootSessionId) {
              navigate(`/projects/${slug}`, { replace: true });
            }
          }}
          open
          project={activeProject}
          session={deletingSession}
        />
      )}

      {closingProject && (
        <CloseProjectDialog
          open
          onClose={() => setClosingProject(null)}
          project={closingProject}
          onClosed={() => {
            setClosingProject(null);
            const remaining = projects?.filter(p => p.slug !== slug) ?? [];
            if (remaining.length > 0) {
              navigate(`/projects/${remaining[0].slug}`);
            } else {
              navigate("/");
            }
          }}
        />
      )}

    </div>
  );
}
