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

const STATUS_DOT_COLORS: Record<SessionFamilyActivity | "unknown", string> = {
  running: "bg-success shadow-[0_0_6px_var(--success)] animate-pulse",
  stopping: "bg-warning animate-pulse",
  idle: "bg-text-muted",
  unknown: "border border-text-muted",
};

function SessionStatusDot({ activity }: { activity: SessionFamilyActivity | undefined }) {
  return <div className={`w-[7px] h-[7px] rounded-full shrink-0 ${STATUS_DOT_COLORS[activity ?? "unknown"]}`} />;
}

const AUTOMATION_STATUS_DOT_COLORS: Record<Automation["status"], string> = {
  active: "bg-success shadow-[0_0_6px_var(--success)] animate-pulse",
  paused: "bg-warning",
  disabled: "bg-text-muted",
};

function AutomationStatusDot({ status }: { status: Automation["status"] }) {
  return <div className={`w-[7px] h-[7px] rounded-full shrink-0 ${AUTOMATION_STATUS_DOT_COLORS[status] ?? ""}`} />;
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
    <div
      className={`flex items-center gap-2 px-3.5 py-[7px] cursor-pointer transition-colors duration-150 relative ${
        isActive ? "bg-accent-subtle" : "hover:bg-bg-hover"
      }`}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onClick();
      }}
    >
      {isActive && (
        <div className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-r-sm bg-accent" />
      )}
      <SessionStatusDot activity={activity} />
      <div className="flex-1 min-w-0">
        <div className="text-[12.5px] font-medium text-text-primary whitespace-nowrap overflow-hidden text-ellipsis">
          {session.title || "Untitled"}
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-text-muted mt-px">
          <span>
            {activity ?? "status unavailable"} · {formatRelativeTime(updatedAt)}
          </span>
          {session.goal && <span className="rounded-sm bg-accent-muted px-1 py-px text-[10px] font-medium text-accent">Goal · {session.goal.status}</span>}
        </div>
      </div>
      {attentionCount > 0 && <span className="grid min-h-4 min-w-4 place-items-center rounded-full bg-warning px-1 text-[9px] font-bold text-bg-base" aria-label={`${attentionCount} requests need attention`}>{attentionCount > 99 ? "99+" : attentionCount}</span>}
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

  return (
    <div
      className={`flex items-center gap-2 px-3.5 py-[7px] cursor-pointer transition-colors duration-150 relative ${
        isActive ? "bg-accent-subtle" : "hover:bg-bg-hover"
      }`}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onClick();
      }}
    >
      {isActive && (
        <div className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-r-sm bg-accent" />
      )}
      <AutomationStatusDot status={automation.status} />
      <div className="flex-1 min-w-0">
        <div className="text-[12.5px] font-medium text-text-primary whitespace-nowrap overflow-hidden text-ellipsis">
          {automation.name}
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-text-muted mt-px">
          <span className="font-mono">{automation.id.slice(0, 8)}</span>
          {scheduleLabel && <span className="truncate">{scheduleLabel}</span>}
          <span className="capitalize">{automation.action.kind.replaceAll("_", " ")}</span>
        </div>
      </div>
    </div>
  );
}

// Shared sub-components

const SEARCH_INPUT_CLASS =
  "w-full rounded-sm border border-border-default bg-bg-base px-3 py-2 text-[13px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none transition-colors duration-150";

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
      className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-sm border border-accent/50 bg-accent-subtle px-2.5 text-[12px] font-semibold text-accent shadow-[0_0_0_1px_rgba(255,255,255,0.02)] transition-colors duration-150 hover:border-accent hover:bg-accent/15 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-45"
    >
      <Plus size={13} />
      <span className="whitespace-nowrap">{label}</span>
    </button>
  );
}

function SubGroupHeader({ title, count }: { title: string; count?: number }) {
  return (
    <div className="flex items-center justify-between px-3.5 py-1.5 text-[11px] font-semibold text-text-muted uppercase tracking-wider cursor-pointer select-none hover:text-text-tertiary">
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
  return <div className="px-3.5 py-2 text-[11px] text-text-muted">{children}</div>;
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
      className={`group flex h-8 items-center gap-2 rounded-sm border px-2.5 text-[12px] font-medium transition-colors ${isActive
        ? "border-accent/40 bg-accent-subtle text-accent"
        : "border-border-subtle bg-bg-base text-text-secondary hover:border-border-default hover:bg-bg-hover hover:text-text-primary"
      }`}
    >
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
      <div className="shrink-0 border-b border-border-subtle px-3.5 pb-2 pt-2.5 max-[799px]:pr-12">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="font-semibold text-[13px] text-text-primary truncate">
              {activeProject?.name ?? "Project unavailable"}
            </div>
            {activeProject && (
              <div className="font-mono text-[11px] text-text-muted truncate mt-px">
                {activeProject.workspaceRoot}
              </div>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
          {activeProject && (
            <ProjectActionDropdown
              project={activeProject}
              onEdit={setEditingProject}
              onClose={setClosingProject}
              trigger={
                <button
                  className="w-6 h-6 rounded-sm flex items-center justify-center text-text-muted hover:bg-bg-hover hover:text-text-secondary transition-colors duration-150 text-sm shrink-0"
                  title="Project actions"
                >
                  ⋯
                </button>
              }
            />
          )}
            <button
              type="button"
              className="flex h-6 w-6 items-center justify-center rounded-sm text-text-muted hover:bg-bg-hover hover:text-text-primary focus-visible:outline-2 focus-visible:outline-accent max-[799px]:hidden"
              aria-label="Collapse project sidebar"
              aria-controls="project-sidebar"
              aria-expanded="true"
              onClick={onCollapse ?? toggleSidebar}
            >
              <PanelLeftClose size={13} />
            </button>
            <button
              type="button"
              className="flex h-6 w-6 items-center justify-center rounded-sm text-text-muted hover:bg-bg-hover hover:text-text-primary focus-visible:outline-2 focus-visible:outline-accent"
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
              className={`flex-1 px-3 py-2 text-[12px] font-medium transition-colors duration-150 cursor-pointer border-b-2 ${
                isActive
                  ? "text-text-primary border-accent"
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
