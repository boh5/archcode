import { useMemo } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import type { DiffFile, SessionTreeNode } from "../../../api/types";
import { useSessionTree } from "../../../api/queries";
import { useLiveSessionDiff } from "../../../hooks/use-live-session-diff";

export interface InspectorAgentEntry {
  sessionId: string;
  name: string;
  type: string;
  profile: string;
  depth: number;
  hasChildren: boolean;
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

export function flattenInspectorAgents(node: SessionTreeNode | undefined, depth = 0): InspectorAgentEntry[] {
  if (!node) return [];
  return [
    {
      sessionId: node.session.sessionId,
      name: node.session.title || "Untitled",
      type: node.session.agentName,
      profile: node.session.profile,
      depth,
      hasChildren: node.children.length > 0,
    },
    ...node.children.flatMap((child) => flattenInspectorAgents(child, depth + 1)),
  ];
}

/** One authoritative tree and diff projection shared by tab counts and panels. */
export function useSessionInspectorProjection(): SessionInspectorProjection {
  const { slug = "", sessionId = "" } = useParams<{ slug: string; sessionId: string }>();
  const [searchParams] = useSearchParams();
  const tree = useSessionTree(slug, sessionId);
  const fullDiffOpen = searchParams.get("view") === "diff";
  const changes = useLiveSessionDiff(slug, sessionId, !fullDiffOpen);
  const agents = useMemo(() => flattenInspectorAgents(tree.data?.root), [tree.data]);

  return {
    agents: { items: agents, isLoading: tree.isLoading, error: tree.error },
    changes: { files: changes.data, isLoading: changes.isLoading, error: changes.error },
  };
}
