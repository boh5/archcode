import { useMemo } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useAgents, useSessionTree } from "../../../api/queries";
import type { SessionTreeNode } from "../../../api/types";
import { resolveAgentAppearance, resolveAgentDisplayName } from "../../../lib/agent-constants";
import { InspectorNotice } from "./InspectorPrimitives";
import { buildAgentFocusSearch } from "./session-canvas-navigation";

interface AgentEntry {
  sessionId: string;
  name: string;
  type: string;
  depth: number;
}

function flattenAgents(node: SessionTreeNode | undefined, depth = 0): AgentEntry[] {
  if (!node) return [];
  return [
    {
      sessionId: node.session.sessionId,
      name: node.session.title || "Untitled",
      type: node.session.agentName,
      depth,
    },
    ...node.children.flatMap((child) => flattenAgents(child, depth + 1)),
  ];
}

export function SessionAgentsInspector() {
  const { slug = "", sessionId = "" } = useParams<{ slug: string; sessionId: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const focused = searchParams.get("focus") ?? sessionId;
  const { data: tree, isLoading } = useSessionTree(slug, sessionId);
  const { data: agentDescriptors = [] } = useAgents();
  const sessionAgents = useMemo(() => flattenAgents(tree?.root), [tree]);

  if (isLoading) return <InspectorNotice>Loading agents…</InspectorNotice>;
  if (sessionAgents.length === 0) return <InspectorNotice>No agent sessions</InspectorNotice>;
  return (
    <nav className="space-y-1" data-testid="context-agent-tree" aria-label="Agents">
      {sessionAgents.map((agent) => {
        const displayName = resolveAgentDisplayName(agent.type, agentDescriptors);
        const appearance = resolveAgentAppearance(agent.type, displayName);
        return (
          <button
            key={agent.sessionId}
            type="button"
            aria-current={focused === agent.sessionId ? "true" : undefined}
            className={`flex w-full items-center gap-2 rounded-sm py-1.5 pr-2 text-left transition-colors ${focused === agent.sessionId ? "bg-accent-subtle text-accent" : "text-text-secondary hover:bg-bg-hover"}`}
            style={{ paddingLeft: 8 + (agent.depth * 16) }}
            onClick={() => navigate({ search: buildAgentFocusSearch(searchParams, sessionId, agent.sessionId) })}
          >
            <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded text-[10px] ${appearance.iconClass}`}>
              {appearance.initial}
            </span>
            <span className="min-w-0 flex-1 truncate text-xs">{agent.name}</span>
            <span className="text-[10px] text-text-muted">{displayName}</span>
          </button>
        );
      })}
    </nav>
  );
}
