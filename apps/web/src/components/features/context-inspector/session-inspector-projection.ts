import { useMemo } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import type { AgentTreeNode, DiffFile } from "../../../api/types";
import { useSession, useSessionTree } from "../../../api/queries";
import { useLiveSessionDiff } from "../../../hooks/use-live-session-diff";

export interface InspectorAgentEntry {
  sessionId: string;
  name: string;
  type: string;
  profile: string;
  depth: number;
  hasChildren: boolean;
  latestExecutionStatus: AgentTreeNode["latestExecutionStatus"];
  activeExecutionId: string | null;
  linkStatus: AgentTreeNode["linkStatus"];
}

export interface SessionInspectorProjection {
  agents: {
    items: readonly InspectorAgentEntry[];
    isLoading: boolean;
    error: unknown;
  };
  changes: {
    files: readonly DiffFile[] | undefined;
    isLoading: boolean;
    error: unknown;
  };
}

export function flattenInspectorAgents(node: AgentTreeNode | undefined): InspectorAgentEntry[] {
  if (!node) return [];
  return [
    {
      sessionId: node.session.sessionId,
      name: node.session.title || "Untitled",
      type: node.session.agentName,
      profile: node.session.profile,
      depth: node.depth,
      hasChildren: node.children.length > 0,
      latestExecutionStatus: node.latestExecutionStatus,
      activeExecutionId: node.activeExecutionId,
      linkStatus: node.linkStatus,
    },
    ...node.children.flatMap((child) => flattenInspectorAgents(child)),
  ];
}

/** One authoritative tree and diff projection shared by tab counts and panels. */
export function useSessionInspectorProjection(): SessionInspectorProjection {
  const { slug = "", sessionId = "" } = useParams<{ slug: string; sessionId: string }>();
  const [searchParams] = useSearchParams();
  const session = useSession(slug, sessionId);
  const tree = useSessionTree(slug, session.data?.rootSessionId ?? "");
  const fullDiffOpen = searchParams.get("view") === "diff";
  const changes = useLiveSessionDiff(slug, sessionId, {
    enabled: !fullDiffOpen,
    activityRootSessionId: session.data?.rootSessionId ?? "",
  });
  const agents = useMemo(() => flattenInspectorAgents(tree.data?.root), [tree.data]);

  return {
    agents: {
      items: agents,
      isLoading: session.isPending || tree.isLoading,
      error: session.error ?? tree.error,
    },
    changes: { files: changes.data, isLoading: changes.isLoading, error: changes.error },
  };
}
