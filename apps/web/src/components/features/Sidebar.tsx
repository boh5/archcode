import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { ChevronRight, Plus } from "lucide-react";
import { useCreateSession } from "../../api/mutations";
import { useGoals, useLoops, useProjects, useSessions, useSessionTree } from "../../api/queries";
import type {
  GoalState,
  GoalStatus,
  LoopState,
  LoopStatus,
  Project,
  Session,
  SessionTreeNode,
} from "../../api/types";
import { ProjectActionDropdown } from "./ProjectActionMenu";
import { EditProjectDialog } from "./EditProjectDialog";
import { CloseProjectDialog } from "./CloseProjectDialog";
import { CreateGoalDialog } from "./CreateGoalDialog";
import { CreateLoopDialog } from "./CreateLoopDialog";
import { AGENT_INITIALS, AGENT_ICON_COLORS, isValidAgentType } from "../../lib/agent-constants";
import type { AgentType } from "../../lib/agent-constants";
import { formatRelativeTime } from "../../lib/time-format";
import { getWebSessionStore, useSessionStore } from "../../store/session-store";

// Helpers

function isSessionActive(session: Session): boolean {
  return isTimestampActive(session.createdAt, session.updatedAt, session.lastUpdatedAt);
}

function isTimestampActive(createdAt: number, updatedAt?: number, lastUpdatedAt?: number): boolean {
  const updatedAtValue = updatedAt ?? lastUpdatedAt ?? createdAt;
  const hourAgo = Date.now() - 60 * 60 * 1000;
  return updatedAtValue > hourAgo;
}

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

type SidebarTab = "sessions" | "goals" | "loops";

const TABS: Array<{ id: SidebarTab; label: string }> = [
  { id: "sessions", label: "Sessions" },
  { id: "goals", label: "Goals" },
  { id: "loops", label: "Loops" },
];

function deriveTabFromPath(pathname: string): SidebarTab {
  if (pathname.includes("/sessions/")) return "sessions";
  if (pathname.includes("/goals")) return "goals";
  if (pathname.includes("/loops")) return "loops";
  return "sessions";
}

// Status dots

const STATUS_DOT_COLORS: Record<string, string> = {
  running: "bg-success shadow-[0_0_6px_var(--success)] animate-pulse",
  completed: "bg-text-muted",
  paused: "bg-warning",
  failed: "bg-error",
};

function SessionStatusDot({ status }: { status: "running" | "completed" | "paused" | "failed" }) {
  return <div className={`w-[7px] h-[7px] rounded-full shrink-0 ${STATUS_DOT_COLORS[status] ?? ""}`} />;
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

const LOOP_STATUS_DOT_COLORS: Record<LoopStatus, string> = {
  active: "bg-success shadow-[0_0_6px_var(--success)] animate-pulse",
  paused: "bg-warning",
  disabled: "bg-text-muted",
  error: "bg-error",
};

function LoopStatusDot({ status }: { status: LoopStatus }) {
  return <div className={`w-[7px] h-[7px] rounded-full shrink-0 ${LOOP_STATUS_DOT_COLORS[status] ?? ""}`} />;
}

// List items

function SessionItem({
  session,
  isActive,
  onClick,
}: {
  session: Session;
  isActive: boolean;
  onClick: () => void;
}) {
  const updatedAt = session.updatedAt ?? session.lastUpdatedAt ?? session.createdAt;
  const isRunning = isSessionActive(session);

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
      <SessionStatusDot status={isRunning ? "running" : "completed"} />
      <div className="flex-1 min-w-0">
        <div className="text-[12.5px] font-medium text-text-primary whitespace-nowrap overflow-hidden text-ellipsis">
          {session.title || "Untitled"}
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-text-muted mt-px">
          <span>
            {isRunning ? "active" : ""} · {formatRelativeTime(updatedAt)}
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

function LoopItem({
  loop,
  isActive,
  onClick,
}: {
  loop: LoopState;
  isActive: boolean;
  onClick: () => void;
}) {
  const title = loop.config?.title?.trim() || `Loop ${loop.loopId.slice(0, 8)}`;
  const schedule = loop.config?.schedule;
  const scheduleLabel = schedule
    ? schedule.kind === "manual"
      ? "manual"
      : schedule.kind === "interval"
        ? `interval ${schedule.everyMs}ms`
        : `cron ${schedule.expression}`
    : "";

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
      <LoopStatusDot status={loop.status} />
      <div className="flex-1 min-w-0">
        <div className="text-[12.5px] font-medium text-text-primary whitespace-nowrap overflow-hidden text-ellipsis">
          {title}
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-text-muted mt-px">
          <span className="font-mono">{loop.loopId.slice(0, 8)}</span>
          {scheduleLabel && <span className="truncate">{scheduleLabel}</span>}
          {loop.config?.runKind && <span className="capitalize">{loop.config.runKind}</span>}
        </div>
      </div>
    </div>
  );
}

function AgentNode({
  name,
  agentType,
  status,
  depth,
  isActive,
  onClick,
}: {
  name: string;
  agentType: AgentType;
  status: "running" | "idle" | "pending" | "completed";
  depth: number;
  isActive: boolean;
  onClick?: () => void;
}) {
  const paddingLeft = depth === 0 ? "pl-3.5" : depth === 1 ? "pl-[38px]" : depth === 2 ? "pl-[48px]" : "pl-[58px]";

  return (
    <div
      className={`flex items-center gap-1.5 py-[5px] ${paddingLeft} cursor-pointer transition-colors duration-150 text-xs relative ${
        isActive ? "bg-accent-subtle" : "hover:bg-bg-hover"
      }`}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (onClick && (e.key === "Enter" || e.key === " ")) onClick();
      }}
    >
      {isActive && (
        <div className="absolute left-0 top-1 bottom-1 w-0.5 rounded-r-sm bg-accent" />
      )}
      <div className={`w-[18px] h-[18px] rounded flex items-center justify-center text-[10px] shrink-0 ${AGENT_ICON_COLORS[agentType]}`}>
        {AGENT_INITIALS[agentType]}
      </div>
      <span className={`flex-1 text-xs whitespace-nowrap overflow-hidden text-ellipsis ${isActive ? "text-accent font-medium" : "text-text-secondary"}`}>
        {name}
      </span>
      <span className={`text-[10px] flex items-center gap-1 ${status === "running" ? "text-success" : "text-text-muted"}`}>
        {status === "running" && (
          <span className="w-[5px] h-[5px] rounded-full bg-success animate-pulse" />
        )}
        {status}
      </span>
    </div>
  );
}

// Shared sub-components

const SEARCH_INPUT_CLASS =
  "w-full rounded-sm border border-border-default bg-bg-base px-3 py-2 text-[13px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none transition-colors duration-150";

/** Dashboard button used at the project level and inside each tab panel. */
function DashboardLinkButton({
  to,
  label,
  isActive,
  placeholderLabel,
}: {
  to: string;
  label: string;
  isActive: boolean;
  placeholderLabel?: string;
}) {
  return (
    <Link
      to={to}
      className={`flex items-center gap-2 px-3.5 py-2 rounded-sm text-[12.5px] font-medium transition-colors duration-150 border ${
        isActive
          ? "bg-accent-subtle text-accent border-accent/40"
          : "text-text-secondary border-border-default hover:bg-bg-hover hover:text-text-primary"
      }`}
    >
      <span className="flex-1 truncate">{label}</span>
      {placeholderLabel && (
        <span className="rounded-sm border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-warning">
          {placeholderLabel}
        </span>
      )}
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
      className="rounded-sm border border-dashed border-warning/50 bg-warning/10 px-3.5 py-2"
      aria-label={`${label} placeholder`}
    >
      <div className="flex items-center gap-2 text-[12.5px] font-medium text-warning">
        <span className="flex-1 truncate">{label}</span>
        <span className="rounded-sm border border-warning/40 bg-bg-base px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-warning">
          Placeholder
        </span>
      </div>
      <p className="mt-1 text-[11px] leading-4 text-text-muted">
        {description}
      </p>
    </div>
  );
}

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

// Sidebar

export function Sidebar() {
  const navigate = useNavigate();
  const location = useLocation();
  const { slug = "", sessionId = "", goalId = "", loopId = "" } = useParams<{
    slug: string;
    sessionId: string;
    goalId: string;
    loopId: string;
  }>();
  const createSession = useCreateSession();

  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [closingProject, setClosingProject] = useState<Project | null>(null);
  const [createGoalOpen, setCreateGoalOpen] = useState(false);
  const [createLoopOpen, setCreateLoopOpen] = useState(false);
  const [agentTreeCollapsed, setAgentTreeCollapsed] = useState(false);

  const [sessionsSearch, setSessionsSearch] = useState("");
  const [goalsSearch, setGoalsSearch] = useState("");
  const [loopsSearch, setLoopsSearch] = useState("");
  const [selectedTab, setSelectedTab] = useState<SidebarTab>(deriveTabFromPath(location.pathname));

  const { data: projects } = useProjects();
  const activeProject = projects?.find(p => p.slug === slug) ?? null;
  const { data: sessions } = useSessions(slug);
  const { data: goals } = useGoals(slug);
  const { data: loops } = useLoops(slug);

  const routeTab: SidebarTab = deriveTabFromPath(location.pathname);
  const activeTab = selectedTab;
  const projectDashboardPath = `/projects/${slug}`;
  const isProjectDashboardActive = location.pathname === projectDashboardPath;

  useEffect(() => {
    setSelectedTab(routeTab);
  }, [routeTab]);

  const rootSessionId = useMemo(() => {
    if (!sessionId) return "";
    const currentSession = sessions?.find(s => s.sessionId === sessionId || s.id === sessionId);
    if (currentSession?.rootSessionId) return currentSession.rootSessionId;
    if (currentSession && !currentSession.parentSessionId) return sessionId;
    return sessionId;
  }, [sessionId, sessions]);

  const { data: sessionTree } = useSessionTree(slug, rootSessionId);
  const focusSessionId = useSessionStore(rootSessionId, (s) => s.focusSessionId, slug);

  // Handlers

  const handleNewSession = () => {
    createSession.mutate({ slug }, {
      onSuccess: (session) => {
        navigate(`/projects/${slug}/sessions/${session.sessionId ?? session.id}`);
      },
    });
  };

  const handleSessionClick = (clickedSessionId: string) => {
    navigate(`/projects/${slug}/sessions/${clickedSessionId}`);
  };

  const handleGoalClick = (clickedGoalId: string) => {
    navigate(`/projects/${slug}/goals/${clickedGoalId}`);
  };

  const handleLoopClick = (clickedLoopId: string) => {
    navigate(`/projects/${slug}/loops/${clickedLoopId}`);
  };

  const handleAgentTreeClick = (clickedSessionId: string) => {
    const store = getWebSessionStore(rootSessionId, slug);
    if (clickedSessionId === rootSessionId) {
      store.getState().setFocusSessionId(null);
    } else {
      store.getState().setFocusSessionId(clickedSessionId);
    }
  };

  // Filtered lists

  const filteredSessions = useMemo(() => {
    if (!sessions) return [];
    const rootSessions = sessions.filter(s => !s.parentSessionId);
    if (!sessionsSearch.trim()) return rootSessions;
    const q = sessionsSearch.toLowerCase();
    return rootSessions.filter((s) => {
      const title = toSearchable(s.title || "Untitled").toLowerCase();
      const id = toSearchable(s.sessionId ?? s.id).toLowerCase();
      return title.includes(q) || id.includes(q);
    });
  }, [sessions, sessionsSearch]);

  const { activeSessions, completedSessions } = useMemo(() => {
    const active: Session[] = [];
    const completed: Session[] = [];
    for (const session of filteredSessions) {
      if (isSessionActive(session)) {
        active.push(session);
      } else {
        completed.push(session);
      }
    }
    return { activeSessions: active, completedSessions: completed };
  }, [filteredSessions]);

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

  const filteredLoops = useMemo(() => {
    const loopsList = loops ?? [];
    if (!loopsSearch.trim()) return loopsList;
    const q = loopsSearch.toLowerCase();
    return loopsList.filter((l) => {
      const id = toSearchable(l.loopId).toLowerCase();
      const status = toSearchable(l.status).toLowerCase();
      const mode = toSearchable(l.config?.mode).toLowerCase();
      const runKind = toSearchable(l.config?.runKind).toLowerCase();
      const schedule = toSearchable(l.config?.schedule?.kind).toLowerCase();
      return id.includes(q) || status.includes(q) || mode.includes(q) || runKind.includes(q) || schedule.includes(q);
    });
  }, [loops, loopsSearch]);

  const agentTree = useMemo(() => {
    if (!sessionTree?.root) return null;

    const agents: Array<{
      name: string;
      type: AgentType;
      status: "running" | "idle" | "pending" | "completed";
      depth: number;
      isActive: boolean;
      sessionId: string;
    }> = [];

    function walkNode(node: SessionTreeNode, depth: number): void {
      const s = node.session;
      const agentType = isValidAgentType(s.agentName ?? "") ? (s.agentName as AgentType) : "orchestrator";
      const isRunning = isTimestampActive(s.createdAt, undefined, s.lastUpdatedAt);
      const isActive = focusSessionId === null
        ? s.sessionId === rootSessionId
        : s.sessionId === focusSessionId;

      agents.push({
        name: s.title || "Untitled",
        type: agentType,
        status: isRunning ? "running" : "completed",
        depth,
        isActive,
        sessionId: s.sessionId,
      });

      for (const child of node.children) {
        walkNode(child, depth + 1);
      }
    }

    walkNode(sessionTree.root, 0);
    return agents;
  }, [sessionTree, rootSessionId, focusSessionId]);

  // Render

  return (
    <div className="h-full bg-bg-surface border-r border-border-subtle flex flex-col overflow-hidden">
      <div className="px-3.5 pt-2.5 pb-2 border-b border-border-subtle shrink-0">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="font-semibold text-[13px] text-text-primary truncate">
              {activeProject?.name ?? slug}
            </div>
            {activeProject && (
              <div className="font-mono text-[11px] text-text-muted truncate mt-px">
                {activeProject.workspaceRoot}
              </div>
            )}
          </div>
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
        </div>

        <div className="mt-2">
          <DashboardLinkButton
            to={projectDashboardPath}
            label="Project Dashboard"
            isActive={isProjectDashboardActive}
            placeholderLabel="Placeholder"
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
              description="Placeholder: a dedicated sessions dashboard is not available yet. Use the session list below to open or create a session."
            />
            <div className="flex items-center gap-2">
              <input
                type="text"
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
                  key={session.id}
                  session={session}
                  isActive={session.id === sessionId || session.sessionId === sessionId}
                  onClick={() => handleSessionClick(session.sessionId ?? session.id)}
                />
              ))}
            </div>
          )}

          {completedSessions.length > 0 && (
            <div className="mb-1">
              <SubGroupHeader title="Completed" />
              {completedSessions.map((session) => (
                <SessionItem
                  key={session.id}
                  session={session}
                  isActive={session.id === sessionId || session.sessionId === sessionId}
                  onClick={() => handleSessionClick(session.sessionId ?? session.id)}
                />
              ))}
            </div>
          )}

          {filteredSessions.length === 0 && (
            <EmptyRow>
              {sessionsSearch ? "No matching sessions" : "No sessions yet"}
            </EmptyRow>
          )}

          {/* Agent tree lives inside the Sessions tab so it stays visible while a session is active. */}
          {agentTree && agentTree.length > 0 && (
            <div className="pt-1 border-t border-border-subtle mt-1">
              <div className="flex items-center justify-between px-3.5 py-1.5">
                <div className="flex items-center gap-1 min-w-0">
                  <button
                    type="button"
                    onClick={() => setAgentTreeCollapsed(!agentTreeCollapsed)}
                    className="flex items-center justify-center w-4 h-4 text-text-muted hover:text-text-tertiary transition-colors duration-150 shrink-0"
                    aria-label={agentTreeCollapsed ? "Expand Agent Tree" : "Collapse Agent Tree"}
                  >
                    <ChevronRight size={11} className={`transition-transform duration-150 ${agentTreeCollapsed ? "" : "rotate-90"}`} />
                  </button>
                  <span className="flex items-center gap-1.5 text-[11px] font-semibold text-text-muted uppercase tracking-wider cursor-pointer select-none hover:text-text-tertiary transition-colors duration-150">
                    <span>Agent Tree</span>
                    <span style={{ fontSize: 10, textTransform: "none", letterSpacing: 0, fontWeight: 400 }}>
                      {agentTree.length}
                    </span>
                  </span>
                </div>
              </div>
              {!agentTreeCollapsed && agentTree.map((agent, i) => (
                <AgentNode
                  key={`${agent.type}-${agent.depth}-${i}`}
                  name={agent.name}
                  agentType={agent.type}
                  status={agent.status}
                  depth={agent.depth}
                  isActive={agent.isActive}
                  onClick={() => handleAgentTreeClick(agent.sessionId)}
                />
              ))}
            </div>
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
          id="sidebar-panel-loops"
          role="tabpanel"
          aria-labelledby="sidebar-tab-loops"
          hidden={activeTab !== "loops"}
        >
          <div className="px-3 py-2 space-y-2">
            <DashboardLinkButton
              to={`/projects/${slug}/loops`}
              label="Loops Dashboard"
              isActive={location.pathname === `/projects/${slug}/loops`}
            />
            <div className="flex items-center gap-2">
              <input
                type="text"
                placeholder="Search loops..."
                value={loopsSearch}
                onChange={(e) => setLoopsSearch(e.target.value)}
                className={SEARCH_INPUT_CLASS}
              />
              <CreateButton
                onClick={() => setCreateLoopOpen(true)}
                title="New loop"
                label="New loop"
              />
            </div>
          </div>

          {filteredLoops.length === 0 ? (
            <EmptyRow>
              {loopsSearch ? "No matching loops" : "No loops yet"}
            </EmptyRow>
          ) : (
            filteredLoops.map((loop) => (
              <LoopItem
                key={loop.loopId}
                loop={loop}
                isActive={loop.loopId === loopId}
                onClick={() => handleLoopClick(loop.loopId)}
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

      <CreateLoopDialog
        open={createLoopOpen}
        onClose={() => setCreateLoopOpen(false)}
        slug={slug}
        onCreated={(newLoopId) => {
          setCreateLoopOpen(false);
          navigate(`/projects/${slug}/loops/${newLoopId}`);
        }}
      />
    </div>
  );
}
