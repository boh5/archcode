/**
 * Sidebar — Column 2 of the 4-column layout.
 *
 * Renders project name header, search filter, session list grouped
 * by status (Active / Completed), and an agent tree for the active session.
 *
 * Design spec: design/web-ui.html → .sidebar, .sidebar-header,
 *   .sidebar-search, .session-item, .agent-tree
 */

import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
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



function SessionStatusDot({ status }: { status: "running" | "completed" | "paused" | "failed" }) {
  return <div className={`session-status-dot ${status}`} />;
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
      className={`session-item${isActive ? " active" : ""}`}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onClick();
      }}
    >
      <SessionStatusDot status={isRunning ? "running" : "completed"} />
      <div className="session-info">
        <div className="session-name">{session.title || "Untitled"}</div>
        <div className="session-meta">
          {pipelineTag && (
            <span className="session-pipeline-tag">{pipelineTag}</span>
          )}
          <span className="session-time">
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
  const depthClass = depth > 0 ? ` depth-${Math.min(depth, 3)}` : "";
  const activeClass = isActive ? " active" : "";

  return (
    <div className={`agent-node${depthClass}${activeClass}`}>
      <div className={`agent-node-icon ${agentType}`}>
        {AGENT_INITIALS[agentType]}
      </div>
      <span className="agent-node-name">{name}</span>
      <span className={`agent-node-status${status === "running" ? " running" : ""}`}>
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

  const { data: sessions } = useSessions(slug);
  const { data: workflow } = useWorkflow(slug, sessionId);


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
    <div className="sidebar">
      <div className="sidebar-header">
        <div className="sidebar-header-title">
          {slug}
          <span className="project-name">/ sessions</span>
        </div>
      </div>

      <div className="sidebar-search">
        <input
          type="text"
          placeholder="Search sessions..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>

      <div className="sidebar-sections">
        {activeSessions.length > 0 && (
          <div className="sidebar-section">
            <div className="sidebar-section-header">
              Active
              <span
                style={{
                  fontSize: 10,
                  textTransform: "none",
                  letterSpacing: 0,
                  fontWeight: 400,
                }}
              >
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
          <div className="sidebar-section">
            <div className="sidebar-section-header">Completed</div>
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
          <div className="sidebar-section">
            <div
              className="sidebar-section-header"
              style={{ textTransform: "none", letterSpacing: 0 }}
            >
              {searchQuery ? "No matching sessions" : "No sessions yet"}
            </div>
          </div>
        )}

        {agentTree && agentTree.length > 0 && (
          <div className="agent-tree">
            <div className="agent-tree-header">Agent Tree</div>
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