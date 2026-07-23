import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { ChevronRight, Focus, LayoutDashboard, PanelLeftClose, Plus } from "lucide-react";
import { useCreateSession, usePostMessage } from "../../api/mutations";
import { useAutomations, useProjects, useSessions } from "../../api/queries";
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
import { formatRelativeTime } from "../../lib/time-format";
import { useWorkbenchLayout } from "../../context/workbench-layout";
import {
  runtimeFamilyKey,
  useSessionRuntimeFamilies,
  useSessionRuntimeInitialized,
} from "../../store/session-runtime-store";
import { selectSessionFamilyHitl, useAttentionVisibleScopedHitl } from "../../store/hitl-store";
import { StatusGlyph } from "../primitives/StatusGlyph";
import { GoalStatusMark } from "./GoalStatusMark";
import { presentSessionGoalStatus } from "../../lib/session-goal-presentation";
import { automationVisualKind } from "../../lib/automation-status-presentation";
import { sessionFamilyVisual } from "../../lib/session-family-presentation";

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

// Status dots

function SessionStatusGlyph({ activity }: { activity: SessionFamilyActivity | undefined }) {
  const visual = sessionFamilyVisual(activity);
  const label = activity === undefined ? "Status unavailable" : activity === "stopping" ? "Stopping" : activity === "running" ? "Running" : "Idle";
  return <StatusGlyph kind={visual.kind} tone={visual.tone} label={label} size={10} />;
}

function AutomationStatusGlyph({ status }: { status: Automation["status"] }) {
  return <StatusGlyph kind={automationVisualKind(status)} label={`Automation ${status}`} size={10} />;
}

// List items

function SessionItem({
  session,
  activity,
  attentionCount,
  isActive,
  onClick,
}: {
  session: SessionSummaryWithGoal;
  activity: SessionFamilyActivity | undefined;
  attentionCount: number;
  isActive: boolean;
  onClick: () => void;
}) {
  const updatedAt = session.updatedAt;

  return (
    <button
      type="button"
      className={`relative flex w-full items-center gap-2 px-4 py-2 text-left transition-colors duration-[var(--motion-hover)] ${
        isActive ? "bg-brand-subtle" : "hover:bg-bg-hover"
      }`}
      onClick={onClick}
    >
      {isActive && (
        <div className="absolute left-0 top-2 bottom-2 w-0.5 rounded-r-sm bg-brand" />
      )}
      <SessionStatusGlyph activity={activity} />
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium text-text-primary whitespace-nowrap overflow-hidden text-ellipsis">
          {session.title || "Untitled"}
        </div>
        <div className="mt-px flex items-center gap-2 text-[11px] text-text-tertiary">
          <span>
            {activity ?? "status unavailable"} · {formatRelativeTime(updatedAt)}
          </span>
          {session.goal && (
            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-text-secondary">
              <GoalStatusMark identity={session.goal.instanceId} status={session.goal.status} size={11} label={`Goal ${presentSessionGoalStatus(session.goal.status).label}`} />
              {presentSessionGoalStatus(session.goal.status).label}
            </span>
          )}
        </div>
      </div>
      {attentionCount > 0 && <span className="grid min-h-4 min-w-4 place-items-center rounded-full bg-warning px-1 text-[10px] font-semibold leading-[14px] text-bg-base" aria-label={`${attentionCount} requests need attention`}>{attentionCount > 99 ? "99+" : attentionCount}</span>}
    </button>
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

  return (
    <button
      type="button"
      className={`relative flex w-full items-center gap-2 px-4 py-2 text-left transition-colors duration-[var(--motion-hover)] ${
        isActive ? "bg-brand-subtle" : "hover:bg-bg-hover"
      }`}
      onClick={onClick}
    >
      {isActive && (
        <div className="absolute left-0 top-2 bottom-2 w-0.5 rounded-r-sm bg-brand" />
      )}
      <AutomationStatusGlyph status={automation.status} />
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium text-text-primary whitespace-nowrap overflow-hidden text-ellipsis">
          {automation.name}
        </div>
        <div className="mt-px flex items-center gap-2 text-[11px] text-text-tertiary">
          <span className="font-mono">{automation.id.slice(0, 8)}</span>
          {scheduleLabel && <span className="truncate">{scheduleLabel}</span>}
          <span className="capitalize">{automation.action.kind.replaceAll("_", " ")}</span>
        </div>
      </div>
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
    <div className="flex items-center justify-between px-4 py-2 text-[11px] font-semibold text-text-muted uppercase tracking-wider cursor-pointer select-none hover:text-text-tertiary">
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
}: {
  to: string;
  label: string;
  isActive: boolean;
}) {
  return (
    <Link
      to={to}
      aria-current={isActive ? "page" : undefined}
      className={`group relative flex h-8 items-center gap-2 rounded-sm px-3 text-[12px] font-medium transition-colors ${isActive
        ? "bg-brand-subtle text-brand"
        : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
      }`}
    >
      {isActive && <span className="absolute inset-y-1 left-0 w-0.5 rounded-r-sm bg-brand" aria-hidden="true" />}
      <LayoutDashboard size={13} className="shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <ChevronRight size={12} className="shrink-0 text-text-muted transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
    </Link>
  );
}

// Sidebar

export function Sidebar({
  onCollapse,
  onEnterFocusMode,
}: {
  onCollapse?: () => void;
  onEnterFocusMode?: () => void;
} = {}) {
  const navigate = useNavigate();
  const location = useLocation();
  const { slug = "", sessionId = "", automationId = "" } = useParams<{
    slug: string;
    sessionId: string;
    automationId: string;
  }>();
  const createSession = useCreateSession();
  const postMessage = usePostMessage();
  const { toggleSidebar, toggleFocusMode } = useWorkbenchLayout();

  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [closingProject, setClosingProject] = useState<Project | null>(null);

  const [sessionsSearch, setSessionsSearch] = useState("");
  const [automationsSearch, setAutomationsSearch] = useState("");
  const [selectedTab, setSelectedTab] = useState<SidebarTab>(deriveSidebarTabFromPath(location.pathname) ?? "sessions");

  const { data: projects } = useProjects();
  const activeProject = projects?.find(p => p.slug === slug) ?? null;
  const { data: sessions } = useSessions(slug);
  const { data: automations } = useAutomations(slug);
  const runtimeInitialized = useSessionRuntimeInitialized(slug);
  const runtimeFamilies = useSessionRuntimeFamilies();
  const attentionVisibleHitl = useAttentionVisibleScopedHitl([slug]);

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

  const activityForSession = (session: SessionSummaryWithGoal): SessionFamilyActivity | undefined => {
    if (!runtimeInitialized) return undefined;
    return runtimeFamilies[runtimeFamilyKey(slug, session.sessionId)]?.activity ?? "idle";
  };

  const { activeSessions, inactiveSessions } = useMemo(() => {
    const active: SessionSummaryWithGoal[] = [];
    const inactive: SessionSummaryWithGoal[] = [];
    for (const session of filteredSessions) {
      const activity = runtimeInitialized
        ? runtimeFamilies[runtimeFamilyKey(slug, session.sessionId)]?.activity ?? "idle"
        : undefined;
      if (activity === "running" || activity === "stopping") {
        active.push(session);
      } else {
        inactive.push(session);
      }
    }
    return { activeSessions: active, inactiveSessions: inactive };
  }, [filteredSessions, runtimeFamilies, runtimeInitialized, slug]);

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
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-sm text-text-tertiary transition-colors duration-[var(--motion-hover)] hover:bg-bg-hover hover:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                  title="Project actions"
                >
                  ⋯
                </button>
              }
            />
          )}
            <button
              type="button"
              className="flex h-7 w-7 items-center justify-center rounded-sm text-text-tertiary hover:bg-bg-hover hover:text-text-primary focus-visible:outline-2 focus-visible:outline-brand max-[760px]:hidden"
              aria-label="Collapse project sidebar"
              aria-controls="project-sidebar"
              aria-expanded="true"
              onClick={onCollapse ?? toggleSidebar}
            >
              <PanelLeftClose size={13} />
            </button>
            <button
              type="button"
              className="flex h-7 w-7 items-center justify-center rounded-sm text-text-tertiary hover:bg-bg-hover hover:text-text-primary focus-visible:outline-2 focus-visible:outline-brand"
              aria-label="Enter focus mode"
              onClick={onEnterFocusMode ?? toggleFocusMode}
            >
              <Focus size={13} />
            </button>
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

          {activeSessions.length > 0 && (
            <div className="mb-1">
              <SubGroupHeader title="Active" count={activeSessions.length} />
              {activeSessions.map((session) => (
                <SessionItem
                  key={session.sessionId}
                  session={session}
                  activity={activityForSession(session)}
                  attentionCount={selectSessionFamilyHitl(attentionVisibleHitl, slug, session.sessionId).length}
                  isActive={session.sessionId === sessionId}
                  onClick={() => handleSessionClick(session.sessionId)}
                />
              ))}
            </div>
          )}

          {inactiveSessions.length > 0 && (
            <div className="mb-1">
              <SubGroupHeader title="Sessions" />
              {inactiveSessions.map((session) => (
                <SessionItem
                  key={session.sessionId}
                  session={session}
                  activity={activityForSession(session)}
                  attentionCount={selectSessionFamilyHitl(attentionVisibleHitl, slug, session.sessionId).length}
                  isActive={session.sessionId === sessionId}
                  onClick={() => handleSessionClick(session.sessionId)}
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
