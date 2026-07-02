import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ChevronRight, Plus } from "lucide-react";
import { useCreateSession } from "../../api/mutations";
import { useGoals, useProjects, useSessions, useSessionTree } from "../../api/queries";
import type { GoalState, GoalStatus, Project, Session, SessionTreeNode } from "../../api/types";
import { ProjectActionDropdown } from "./ProjectActionMenu";
import { EditProjectDialog } from "./EditProjectDialog";
import { CloseProjectDialog } from "./CloseProjectDialog";
import { CreateGoalDialog } from "./CreateGoalDialog";
import { AGENT_INITIALS, AGENT_ICON_COLORS, isValidAgentType } from "../../lib/agent-constants";
import type { AgentType } from "../../lib/agent-constants";
import { formatRelativeTime } from "../../lib/time-format";
import { getWebSessionStore, useSessionStore } from "../../store/session-store";

function isSessionActive(session: Session): boolean {
  const updatedAt = session.updatedAt ?? session.lastUpdatedAt ?? session.createdAt;
  const hourAgo = Date.now() - 60 * 60 * 1000;
  return updatedAt > hourAgo;
}

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
  locked: "bg-info",
  running: "bg-success shadow-[0_0_6px_var(--success)] animate-pulse",
  verifying: "bg-warning",
  reviewed: "bg-accent",
  completed: "bg-accent",
  failed: "bg-error",
  escalated: "bg-error",
  paused: "bg-warning",
};

function GoalStatusDot({ status }: { status: GoalStatus }) {
  return <div className={`w-[7px] h-[7px] rounded-full shrink-0 ${GOAL_STATUS_DOT_COLORS[status] ?? ""}`} />;
}

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
          {goal.retryCount > 0 && (
            <span className="text-warning">
              retry {goal.retryCount}/{goal.retryPolicy.maxRetries}
            </span>
          )}
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

function SectionHeader({
  title,
  count,
  collapsed,
  onToggle,
  onTitleClick,
  onAction,
  actionTitle,
  actionDisabled,
}: {
  title: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  onTitleClick?: () => void;
  onAction?: () => void;
  actionTitle?: string;
  actionDisabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between px-3.5 py-1.5">
      <div className="flex items-center gap-1 min-w-0">
        <button
          type="button"
          onClick={onToggle}
          className="flex items-center justify-center w-4 h-4 text-text-muted hover:text-text-tertiary transition-colors duration-150 shrink-0"
          aria-label={collapsed ? `Expand ${title}` : `Collapse ${title}`}
        >
          <ChevronRight size={11} className={`transition-transform duration-150 ${collapsed ? "" : "rotate-90"}`} />
        </button>
        <button
          type="button"
          onClick={onTitleClick ?? onToggle}
          className="flex items-center gap-1.5 text-[11px] font-semibold text-text-muted uppercase tracking-wider cursor-pointer select-none hover:text-text-tertiary transition-colors duration-150"
        >
          <span>{title}</span>
          <span style={{ fontSize: 10, textTransform: "none", letterSpacing: 0, fontWeight: 400 }}>
            {count}
          </span>
        </button>
      </div>
      {onAction && (
        <button
          type="button"
          onClick={onAction}
          disabled={actionDisabled}
          title={actionTitle}
          aria-label={actionTitle}
          className="w-5 h-5 rounded-sm flex items-center justify-center text-text-muted hover:bg-bg-hover hover:text-text-secondary transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
        >
          <Plus size={12} />
        </button>
      )}
    </div>
  );
}

export function Sidebar() {
  const navigate = useNavigate();
  const { slug = "", sessionId = "", goalId = "" } = useParams<{
    slug: string;
    sessionId: string;
    goalId: string;
  }>();
  const [searchQuery, setSearchQuery] = useState("");
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [closingProject, setClosingProject] = useState<Project | null>(null);
  const [createGoalOpen, setCreateGoalOpen] = useState(false);
  const [goalsCollapsed, setGoalsCollapsed] = useState(false);
  const [sessionsCollapsed, setSessionsCollapsed] = useState(false);
  const [agentTreeCollapsed, setAgentTreeCollapsed] = useState(false);
  const createSession = useCreateSession();

  const { data: projects } = useProjects();
  const activeProject = projects?.find(p => p.slug === slug) ?? null;
  const { data: sessions } = useSessions(slug);
  const { data: goals } = useGoals(slug);

  const rootSessionId = useMemo(() => {
    if (!sessionId) return "";
    const currentSession = sessions?.find(s => s.sessionId === sessionId || s.id === sessionId);
    if (currentSession?.rootSessionId) return currentSession.rootSessionId;
    if (currentSession && !currentSession.parentSessionId) return sessionId;
    return sessionId;
  }, [sessionId, sessions]);

  const { data: sessionTree } = useSessionTree(slug, rootSessionId);

  const focusSessionId = useSessionStore(rootSessionId, (s) => s.focusSessionId, slug);

  const handleNewSession = () => {
    createSession.mutate({ slug }, {
      onSuccess: (session) => {
        navigate(`/projects/${slug}/sessions/${session.sessionId ?? session.id}`);
      },
    });
  };

  const handleGoalClick = (clickedGoalId: string) => {
    navigate(`/projects/${slug}/goals/${clickedGoalId}`);
  };

  const handleGoalsTitleClick = () => {
    navigate(`/projects/${slug}/goals`);
  };

  const filteredSessions = useMemo(() => {
    if (!sessions) return [];
    const rootSessions = sessions.filter(s => !s.parentSessionId);
    if (!searchQuery.trim()) return rootSessions;
    const q = searchQuery.toLowerCase();
    return rootSessions.filter((s) =>
      (s.title || "Untitled").toLowerCase().includes(q),
    );
  }, [sessions, searchQuery]);

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
      const isRunning = isSessionActive({ ...s, id: s.sessionId } as Session);
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

  const handleSessionClick = (clickedSessionId: string) => {
    navigate(`/projects/${slug}/sessions/${clickedSessionId}`);
  };

  const handleAgentTreeClick = (clickedSessionId: string) => {
    const store = getWebSessionStore(rootSessionId, slug);
    if (clickedSessionId === rootSessionId) {
      store.getState().setFocusSessionId(null);
    } else {
      store.getState().setFocusSessionId(clickedSessionId);
    }
  };

  const goalsList = goals ?? [];

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
      </div>

      <div className="flex-1 overflow-y-auto pb-4">
        <div className="mb-1">
          <SectionHeader
            title="Goals"
            count={goalsList.length}
            collapsed={goalsCollapsed}
            onToggle={() => setGoalsCollapsed(!goalsCollapsed)}
            onTitleClick={handleGoalsTitleClick}
            onAction={() => setCreateGoalOpen(true)}
            actionTitle="New goal"
          />
          {!goalsCollapsed && (
            <>
              {goalsList.length === 0 ? (
                <div className="px-3.5 py-2 text-[11px] text-text-muted">
                  No goals yet
                </div>
              ) : (
                goalsList.map((goal) => (
                  <GoalItem
                    key={goal.id}
                    goal={goal}
                    isActive={goal.id === goalId}
                    onClick={() => handleGoalClick(goal.id)}
                  />
                ))
              )}
            </>
          )}
        </div>

        <div className="mb-1">
          <SectionHeader
            title="Sessions"
            count={filteredSessions.length}
            collapsed={sessionsCollapsed}
            onToggle={() => setSessionsCollapsed(!sessionsCollapsed)}
            onAction={handleNewSession}
            actionTitle="New session"
            actionDisabled={createSession.isPending}
          />
          {!sessionsCollapsed && (
            <>
              <div className="px-3 py-1.5">
                <input
                  type="text"
                  placeholder="Search sessions..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full bg-bg-elevated border border-border-default rounded-sm px-2.5 py-1.5 text-[12.5px] text-text-primary outline-none transition-colors focus:border-accent placeholder:text-text-muted"
                />
              </div>

              {activeSessions.length > 0 && (
                <div className="mb-1">
                  <div className="flex items-center justify-between px-3.5 py-1.5 text-[11px] font-semibold text-text-muted uppercase tracking-wider cursor-pointer select-none hover:text-text-tertiary">
                    Active
                    <span style={{ fontSize: 10, textTransform: "none", letterSpacing: 0, fontWeight: 400 }}>
                      {activeSessions.length}
                    </span>
                  </div>
                  {activeSessions.map((session) => (
                    <SessionItem
                      key={session.id}
                      session={session}
                      isActive={session.id === sessionId || session.sessionId === sessionId}
                      onClick={() =>
                        handleSessionClick(session.sessionId ?? session.id)
                      }
                    />
                  ))}
                </div>
              )}

              {completedSessions.length > 0 && (
                <div className="mb-1">
                  <div className="flex items-center justify-between px-3.5 py-1.5 text-[11px] font-semibold text-text-muted uppercase tracking-wider cursor-pointer select-none hover:text-text-tertiary">
                    Completed
                  </div>
                  {completedSessions.map((session) => (
                    <SessionItem
                      key={session.id}
                      session={session}
                      isActive={session.id === sessionId || session.sessionId === sessionId}
                      onClick={() =>
                        handleSessionClick(session.sessionId ?? session.id)
                      }
                    />
                  ))}
                </div>
              )}

              {filteredSessions.length === 0 && (
                <div className="px-3.5 py-2 text-[11px] text-text-muted">
                  {searchQuery ? "No matching sessions" : "No sessions yet"}
                </div>
              )}
            </>
          )}
        </div>

        {agentTree && agentTree.length > 0 && (
          <div className="pt-1 border-t border-border-subtle mt-1">
            <SectionHeader
              title="Agent Tree"
              count={agentTree.length}
              collapsed={agentTreeCollapsed}
              onToggle={() => setAgentTreeCollapsed(!agentTreeCollapsed)}
            />
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
    </div>
  );
}
