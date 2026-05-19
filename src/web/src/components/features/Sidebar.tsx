import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useCreateSession } from "../../api/mutations";
import { useSessions, useWorkflow } from "../../api/queries";
import type { Session, WorkflowState } from "../../api/types";

const AGENT_TYPES = [
  "orchestrator",
  "product",
  "spec",
  "critic",
  "foreman",
  "builder",
  "reviewer",
  "librarian",
  "explorer",
] as const;

type AgentType = (typeof AGENT_TYPES)[number];

const AGENT_INITIALS: Record<AgentType, string> = {
  orchestrator: "O",
  product: "P",
  spec: "S",
  critic: "C",
  foreman: "F",
  builder: "B",
  reviewer: "R",
  librarian: "L",
  explorer: "E",
};

const AGENT_ICON_COLORS: Record<AgentType, string> = {
  orchestrator: "bg-[#8b5cf630] text-[#8b5cf6]",
  product: "bg-[#6366f120] text-[#6366f1]",
  spec: "bg-[#3b82f620] text-[#3b82f6]",
  critic: "bg-[#f59e0b20] text-[#f59e0b]",
  foreman: "bg-[#10b98120] text-[#10b981]",
  builder: "bg-[#06b6d420] text-[#06b6d4]",
  reviewer: "bg-[#ec489920] text-[#ec4899]",
  librarian: "bg-[#8b5cf620] text-[#8b5cf6]",
  explorer: "bg-[#64748b20] text-[#64748b]",
};

function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return "just now";
  if (minutes < 60) return `${minutes}m`;
  if (hours < 24) return `${hours}h`;
  if (days === 1) return "yesterday";
  return `${days}d ago`;
}

function isSessionActive(session: Session): boolean {
  const updatedAt = session.updatedAt ?? session.lastUpdatedAt ?? session.createdAt;
  const hourAgo = Date.now() - 60 * 60 * 1000;
  return updatedAt > hourAgo;
}

function getPipelineTag(session: Session): string | null {
  const descs = session.subAgentDescriptions;
  if (!descs || descs.length === 0) return null;
  const firstDesc = descs[0];
  if (firstDesc && AGENT_TYPES.includes(firstDesc[0] as AgentType)) {
    return firstDesc[0];
  }
  return null;
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
  const pipelineTag = getPipelineTag(session);
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
          {pipelineTag && (
            <span className="text-[10px] px-[5px] py-px rounded-[3px] bg-accent-muted text-accent font-medium">
              {pipelineTag}
            </span>
          )}
          <span>
            {isRunning ? "active" : ""} · {formatRelativeTime(updatedAt)}
          </span>
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
}: {
  name: string;
  agentType: AgentType;
  status: "running" | "idle" | "pending" | "completed";
  depth: number;
  isActive: boolean;
}) {
  const paddingLeft = depth === 0 ? "pl-3.5" : depth === 1 ? "pl-[38px]" : depth === 2 ? "pl-[48px]" : "pl-[58px]";

  return (
    <div
      className={`flex items-center gap-1.5 py-[5px] ${paddingLeft} cursor-pointer transition-colors duration-150 text-xs ${
        isActive ? "bg-accent-subtle text-accent" : "hover:bg-bg-hover"
      }`}
    >
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

export function Sidebar() {
  const navigate = useNavigate();
  const { slug = "", sessionId = "" } = useParams<{
    slug: string;
    sessionId: string;
  }>();
  const [searchQuery, setSearchQuery] = useState("");
  const createSession = useCreateSession();

  const { data: sessions } = useSessions(slug);
  const { data: workflow } = useWorkflow(slug, sessionId);

  const handleNewSession = () => {
    createSession.mutate({ slug }, {
      onSuccess: (session) => {
        navigate(`/projects/${slug}/sessions/${session.sessionId ?? session.id}`);
      },
    });
  };

  const filteredSessions = useMemo(() => {
    if (!sessions) return [];
    if (!searchQuery.trim()) return sessions;
    const q = searchQuery.toLowerCase();
    return sessions.filter((s) =>
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
    if (!workflow) return null;

    const wf = workflow as WorkflowState;

    const agents: Array<{
      name: string;
      type: AgentType;
      status: "running" | "idle" | "pending" | "completed";
      depth: number;
      isActive: boolean;
    }> = [];

    agents.push({
      name: "Orchestrator",
      type: "orchestrator",
      status: wf.currentStep ? "idle" : "completed",
      depth: 0,
      isActive: true,
    });

    const stages = Object.entries(wf.sessionIds || {});
    const taskStages = Object.entries(wf.taskSessionIds || {});

    for (const [stageName, stageSessionId] of stages) {
      const agentType = stageName as AgentType;
      if (!AGENT_TYPES.includes(agentType)) continue;

      const isCurrentStep = wf.currentStep === stageName;
      const isCompleted = wf.status === "completed" || (!isCurrentStep && wf.currentStep && AGENT_TYPES.indexOf(agentType as AgentType) < AGENT_TYPES.indexOf(wf.currentStep as AgentType));

      agents.push({
        name: agentType.charAt(0).toUpperCase() + agentType.slice(1),
        type: agentType,
        status: isCurrentStep ? "running" : isCompleted ? "completed" : "pending",
        depth: 1,
        isActive: isCurrentStep,
      });
    }

    for (const [taskName, taskSessionId] of taskStages) {
      const agentType = taskName as AgentType;
      if (!AGENT_TYPES.includes(agentType)) continue;

      agents.push({
        name: agentType.charAt(0).toUpperCase() + agentType.slice(1),
        type: agentType,
        status: "pending",
        depth: 2,
        isActive: false,
      });
    }

    return agents;
  }, [workflow]);

  const handleSessionClick = (clickedSessionId: string) => {
    navigate(`/projects/${slug}/sessions/${clickedSessionId}`);
  };

  return (
    <div className="row-span-full bg-bg-surface border-r border-border-subtle flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-3.5 h-12 border-b border-border-subtle shrink-0">
        <div className="font-semibold text-[13px] text-text-primary flex items-center gap-1.5">
          {slug}
          <span className="text-text-secondary font-normal">/ sessions</span>
        </div>
        <button
          className="w-6 h-6 rounded-sm flex items-center justify-center text-text-muted hover:bg-bg-hover hover:text-text-secondary transition-colors duration-150 text-sm"
          title="New session"
          onClick={handleNewSession}
          disabled={createSession.isPending}
        >
          +
        </button>
      </div>

      <div className="px-3 py-2 shrink-0">
        <input
          type="text"
          placeholder="Search sessions..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full bg-bg-elevated border border-border-default rounded-sm px-2.5 py-1.5 text-[12.5px] text-text-primary outline-none transition-colors focus:border-accent placeholder:text-text-muted"
        />
      </div>

      <div className="flex-1 overflow-y-auto pb-4">
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
          <div className="mb-1">
            <div
              className="flex items-center justify-between px-3.5 py-1.5 text-[11px] font-semibold text-text-muted uppercase tracking-wider cursor-pointer select-none hover:text-text-tertiary"
              style={{ textTransform: "none", letterSpacing: 0 }}
            >
              {searchQuery ? "No matching sessions" : "No sessions yet"}
            </div>
          </div>
        )}

        {agentTree && agentTree.length > 0 && (
          <div className="pt-1 border-t border-border-subtle mt-1">
            <div className="flex items-center justify-between px-3.5 py-1.5 text-[11px] font-semibold text-text-muted uppercase tracking-wider">
              Agent Tree
            </div>
            {agentTree.map((agent, i) => (
              <AgentNode
                key={`${agent.type}-${agent.depth}-${i}`}
                name={agent.name}
                agentType={agent.type}
                status={agent.status}
                depth={agent.depth}
                isActive={agent.isActive}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}