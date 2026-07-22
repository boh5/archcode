import { Fragment, useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { sessionQueryOptions, useAgents, useSessionTree } from "../../../api/queries";
import type { SessionTreeNode } from "../../../api/types";
import type { SessionFamilyActivity, ToolChildSessionLink, ToolChildSessionLinkStatus } from "@archcode/protocol";
import { resolveAgentDisplayName } from "../../../lib/agent-constants";
import { useSessionFamilyActivity } from "../../../store/session-runtime-store";
import { useSessionStore } from "../../../store/session-store";
import { InspectorNotice } from "./InspectorPrimitives";
import { buildAgentFocusSearch } from "./session-canvas-navigation";
import { presentChildExecutionStatus } from "../../../lib/execution-status-presentation";

interface AgentEntry {
  sessionId: string;
  name: string;
  type: string;
  profile: string;
  skills: string[];
  depth: number;
  hasChildren: boolean;
}

interface AgentStatusPresentation {
  label: string;
  className: string;
  detail?: string;
}

export function resolveInspectorAgentStatus(
  rootActivity: SessionFamilyActivity | undefined,
  childStatus?: ToolChildSessionLinkStatus,
): AgentStatusPresentation {
  if (childStatus !== undefined) {
    const status = presentChildExecutionStatus(childStatus);
    const className = status.productStatus === "running" ? "text-success"
      : status.productStatus === "needs_you" ? "text-warning"
        : status.productStatus === "completed" ? "text-accent"
          : "text-text-tertiary";
    return { label: status.label, className, detail: status.detail };
  }
  if (rootActivity === "running") return { label: "Running", className: "text-success" };
  if (rootActivity === "stopping") return { label: "Stopping", className: "text-warning" };
  if (rootActivity === "idle") return { label: "Idle", className: "text-text-tertiary" };
  return { label: "Status unavailable", className: "text-text-muted" };
}

function flattenAgents(node: SessionTreeNode | undefined, depth = 0): AgentEntry[] {
  if (!node) return [];
  return [
    {
      sessionId: node.session.sessionId,
      name: node.session.title || "Untitled",
      type: node.session.agentName,
      profile: node.session.profile,
      skills: node.session.activeSkillNames,
      depth,
      hasChildren: node.children.length > 0,
    },
    ...node.children.flatMap((child) => flattenAgents(child, depth + 1)),
  ];
}

export function buildInspectorChildStatusMap(
  rootLinks: readonly ToolChildSessionLink[],
  nestedParents: readonly { sessionId: string; childSessionLinks: readonly ToolChildSessionLink[] }[],
): Map<string, ToolChildSessionLinkStatus> {
  const statusByChildSessionId = new Map<string, ToolChildSessionLinkStatus>();
  for (const link of rootLinks) statusByChildSessionId.set(link.childSessionId, link.status);
  for (const parent of nestedParents) {
    for (const link of parent.childSessionLinks) {
      if (link.parentSessionId === parent.sessionId) {
        statusByChildSessionId.set(link.childSessionId, link.status);
      }
    }
  }
  return statusByChildSessionId;
}

export function SessionAgentsInspector() {
  const { slug = "", sessionId = "" } = useParams<{ slug: string; sessionId: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const focused = searchParams.get("focus") ?? sessionId;
  const { data: tree, isLoading } = useSessionTree(slug, sessionId);
  const { data: agentDescriptors = [] } = useAgents();
  const rootActivity = useSessionFamilyActivity(slug, sessionId);
  const childSessionLinks = useSessionStore(sessionId, (state) => state.childSessionLinks, slug);
  const sessionAgents = useMemo(() => flattenAgents(tree?.root), [tree]);
  const nestedParentSessionIds = useMemo(
    () => sessionAgents
      .filter((agent) => agent.sessionId !== sessionId && agent.hasChildren)
      .map((agent) => agent.sessionId),
    [sessionAgents, sessionId],
  );
  const nestedParentQueries = useQueries({
    queries: nestedParentSessionIds.map((parentSessionId) => sessionQueryOptions(slug, parentSessionId)),
  });
  const nestedParentSessions = nestedParentQueries.flatMap((query) => query.data === undefined ? [] : [query.data]);
  const childStatusBySessionId = useMemo(
    () => buildInspectorChildStatusMap(childSessionLinks, nestedParentSessions),
    [childSessionLinks, nestedParentSessions],
  );

  if (isLoading) return <InspectorNotice>Loading agents…</InspectorNotice>;
  if (sessionAgents.length === 0) return <InspectorNotice>No agent sessions</InspectorNotice>;
  return (
    <nav className="space-y-1" data-testid="context-agent-tree" aria-label="Agents">
      {sessionAgents.map((agent) => {
        const displayName = resolveAgentDisplayName(agent.type, agentDescriptors);
        const status = resolveInspectorAgentStatus(
          agent.sessionId === sessionId ? rootActivity : undefined,
          agent.sessionId === sessionId ? undefined : childStatusBySessionId.get(agent.sessionId),
        );
        return (
          <Fragment key={agent.sessionId}>
          <button
            type="button"
            aria-current={focused === agent.sessionId ? "true" : undefined}
            className={`flex w-full items-center gap-2 rounded-sm py-1.5 pr-2 text-left transition-colors ${focused === agent.sessionId ? "bg-accent-subtle text-accent" : "text-text-secondary hover:bg-bg-hover"}`}
            style={{ paddingLeft: 8 + (agent.depth * 16) }}
            onClick={() => navigate({ search: buildAgentFocusSearch(searchParams, sessionId, agent.sessionId) })}
          >
            <span className="min-w-0 flex-1 truncate text-xs">{agent.name}</span>
            <span className="max-w-[100px] truncate font-mono text-[10px] text-text-muted">{agent.profile}</span>
            <span className="text-[10px] text-text-muted">{displayName}</span>
            <span
              className={`whitespace-nowrap text-[10px] ${status.className}`}
              data-agent-status={status.label}
              title={status.detail ? `${status.label} · ${status.detail}` : status.label}
            >
              {status.label}
              {status.detail && <span className="ml-1 text-text-muted">· {status.detail}</span>}
            </span>
          </button>
          {agent.skills.length > 0 && (
            <div
              className="truncate pb-1 pr-2 text-[10px] text-text-muted"
              style={{ paddingLeft: 8 + (agent.depth * 16) }}
            >
              Skills: {agent.skills.join(", ")}
            </div>
          )}
          </Fragment>
        );
      })}
    </nav>
  );
}
