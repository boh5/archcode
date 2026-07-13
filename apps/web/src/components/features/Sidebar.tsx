import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { ChevronRight, Focus, LayoutDashboard, PanelLeftClose, Plus } from "lucide-react";
import { useCreateSession } from "../../api/mutations";
import { useAutomations, useGoals, useProjects, useSessions } from "../../api/queries";
import type {
  GoalState,
  GoalStatus,
  Automation,
  Project,
  SessionSummary,
} from "../../api/types";
import type { SessionFamilyActivity } from "@archcode/protocol";
import { ProjectActionDropdown } from "./ProjectActionMenu";
import { EditProjectDialog } from "./EditProjectDialog";
import { CloseProjectDialog } from "./CloseProjectDialog";
import { CreateGoalDialog } from "./CreateGoalDialog";
import { AutomationDialog } from "./AutomationDialog";
import { formatRelativeTime } from "../../lib/time-format";
import { useWorkbenchLayout } from "../../context/workbench-layout";
import {
  runtimeFamilyKey,
  useSessionRuntimeFamilies,
  useSessionRuntimeInitialized,
} from "../../store/session-runtime-store";

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

type SidebarTab = "sessions" | "goals" | "automations";

const TABS: Array<{ id: SidebarTab; label: string }> = [
  { id: "sessions", label: "Sessions" },
  { id: "goals", label: "Goals" },
  { id: "automations", label: "Automations" },
];

function deriveTabFromPath(pathname: string): SidebarTab {
  if (pathname.includes("/sessions/")) return "sessions";
  if (pathname.includes("/goals")) return "goals";
  if (pathname.includes("/automations")) return "automations";
  return "sessions";
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

const GOAL_STATUS_DOT_COLORS: Record<GoalStatus, string> = {
  draft: "bg-text-muted",
  running: "bg-success shadow-[0_0_6px_var(--success)] animate-pulse",
  blocked: "bg-warning",
  reviewing: "bg-info",
  done: "bg-accent",
  not_done: "bg-error",
  failed: "bg-error",
  cancelled: "bg-text-muted",
};

function GoalStatusDot({ status }: { status: GoalStatus }) {
  return <div className={`w-[7px] h-[7px] rounded-full shrink-0 ${GOAL_STATUS_DOT_COLORS[status] ?? ""}`} />;
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
  isActive,
  onClick,
}: {
  session: SessionSummary;
  activity: SessionFamilyActivity | undefined;
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
        </div>
      </div>
    </div>
  );
}

function GoalItem({
  goal,
  isActive,
  onClick,
}: {
  goal: GoalState;
  isActive: boolean;
  onClick: () => void;
}) {
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
      <GoalStatusDot status={goal.status} />
      <div className="flex-1 min-w-0">
        <div className="text-[12.5px] font-medium text-text-primary whitespace-nowrap overflow-hidden text-ellipsis">
          {goal.title || "Untitled"}
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-text-muted mt-px">
          <span className="capitalize">{goal.status}</span>
          {goal.attempt > 1 && (
            <span className="text-warning">
              attempt {goal.attempt}
            </span>
          )}
        </div>
      </div>
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

function PlaceholderDashboardButton({
  label,
  description,
}: {
  label: string;
  description: string;
}) {
  return (
    <div
      className="rounded-sm border border-dashed border-warning/50 bg-warning/10 px-3 py-2"
      aria-label={`${label} placeholder`}
    >
      <div className="flex items-center gap-2 text-[12px] font-medium text-warning">
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="rounded-sm border border-warning/40 bg-bg-base px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-warning">
          Placeholder
        </span>
      </div>
      <p className="mt-1 text-[11px] leading-4 text-text-muted">{description}</p>
    </div>
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
  const { slug = "", sessionId = "", goalId = "", automationId = "" } = useParams<{
    slug: string;
    sessionId: string;
    goalId: string;
    automationId: string;
  }>();
  const createSession = useCreateSession();
  const { toggleSidebar, toggleFocusMode } = useWorkbenchLayout();

  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [closingProject, setClosingProject] = useState<Project | null>(null);
  const [createGoalOpen, setCreateGoalOpen] = useState(false);
  const [createAutomationOpen, setCreateAutomationOpen] = useState(false);

  const [sessionsSearch, setSessionsSearch] = useState("");
  const [goalsSearch, setGoalsSearch] = useState("");
  const [automationsSearch, setAutomationsSearch] = useState("");
  const [selectedTab, setSelectedTab] = useState<SidebarTab>(deriveTabFromPath(location.pathname));

  const { data: projects } = useProjects();
  const activeProject = projects?.find(p => p.slug === slug) ?? null;
  const { data: sessions } = useSessions(slug);
  const { data: goals } = useGoals(slug);
  const { data: automations } = useAutomations(slug);
  const runtimeInitialized = useSessionRuntimeInitialized(slug);
  const runtimeFamilies = useSessionRuntimeFamilies();

  const routeTab: SidebarTab = deriveTabFromPath(location.pathname);
  const activeTab = selectedTab;

  useEffect(() => {
    setSelectedTab(routeTab);
  }, [routeTab]);

  // Handlers

  const handleNewSession = () => {
    createSession.mutate({ slug }, {
      onSuccess: (session) => {
        navigate(`/projects/${slug}/sessions/${session.sessionId}`);
      },
    });
  };

  const handleSessionClick = (clickedSessionId: string) => {
    navigate(`/projects/${slug}/sessions/${clickedSessionId}`);
  };

  const handleGoalClick = (clickedGoalId: string) => {
    navigate(`/projects/${slug}/goals/${clickedGoalId}`);
  };

  const handleAutomationClick = (clickedAutomationId: string) => {
    navigate(`/projects/${slug}/automations/${clickedAutomationId}`);
  };

  // Filtered lists

  const filteredSessions = useMemo(() => {
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

  const activityForSession = (session: SessionSummary): SessionFamilyActivity | undefined => {
    if (!runtimeInitialized) return undefined;
    return runtimeFamilies[runtimeFamilyKey(slug, session.sessionId)]?.activity ?? "idle";
  };

  const { activeSessions, inactiveSessions } = useMemo(() => {
    const active: SessionSummary[] = [];
    const inactive: SessionSummary[] = [];
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

  const filteredGoals = useMemo(() => {
    const goalsList = goals ?? [];
    if (!goalsSearch.trim()) return goalsList;
    const q = goalsSearch.toLowerCase();
    return goalsList.filter((g) => {
      const title = toSearchable(g.title).toLowerCase();
      const id = toSearchable(g.id).toLowerCase();
      const status = toSearchable(g.status).toLowerCase();
      return title.includes(q) || id.includes(q) || status.includes(q);
    });
  }, [goals, goalsSearch]);

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
            <PlaceholderDashboardButton
              label="Sessions Dashboard"
              description="Reserved for a future sessions overview. Use the list below to open or create a session for now."
            />
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
          id="sidebar-panel-goals"
          role="tabpanel"
          aria-labelledby="sidebar-tab-goals"
          hidden={activeTab !== "goals"}
        >
          <div className="px-3 py-2 space-y-2">
            <DashboardLinkButton
              to={`/projects/${slug}/goals`}
              label="Goals Dashboard"
              isActive={location.pathname === `/projects/${slug}/goals`}
            />
            <div className="flex items-center gap-2">
              <input
                type="text"
                aria-label="Search goals"
                placeholder="Search goals..."
                value={goalsSearch}
                onChange={(e) => setGoalsSearch(e.target.value)}
                className={SEARCH_INPUT_CLASS}
              />
              <CreateButton
                onClick={() => setCreateGoalOpen(true)}
                title="New goal"
                label="New goal"
              />
            </div>
          </div>

          {filteredGoals.length === 0 ? (
            <EmptyRow>
              {goalsSearch ? "No matching goals" : "No goals yet"}
            </EmptyRow>
          ) : (
            filteredGoals.map((goal) => (
              <GoalItem
                key={goal.id}
                goal={goal}
                isActive={goal.id === goalId}
                onClick={() => handleGoalClick(goal.id)}
              />
            ))
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
                onClick={() => setCreateAutomationOpen(true)}
                title="New automation"
                label="New automation"
                disabled={!slug}
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

      <CreateGoalDialog
        open={createGoalOpen}
        onClose={() => setCreateGoalOpen(false)}
        slug={slug}
        onCreated={(newGoalId) => {
          setCreateGoalOpen(false);
          navigate(`/projects/${slug}/goals/${newGoalId}`);
        }}
      />

      <AutomationDialog
        open={createAutomationOpen}
        onClose={() => setCreateAutomationOpen(false)}
        slug={slug}
        onCreated={(newAutomationId) => {
          setCreateAutomationOpen(false);
          navigate(`/projects/${slug}/automations/${newAutomationId}`);
        }}
      />
    </div>
  );
}
