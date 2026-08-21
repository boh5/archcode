import type {
  SessionExecutionRecord,
  SessionSummary,
  SessionTreeDiagnostic,
  ToolChildSessionLinkStatus,
} from "./types";

/** Canonical execution and direct-parent link facts for one Agent Session. */
export interface AgentTreeNode {
  readonly session: SessionSummary;
  readonly depth: number;
  readonly latestExecutionStatus: SessionExecutionRecord["status"] | null;
  readonly activeExecutionId: string | null;
  readonly linkStatus: ToolChildSessionLinkStatus | null;
  readonly children: AgentTreeNode[];
}

/** Presentation-safe Agent family projection shared by HTTP and model tools. */
export interface AgentTreeProjection {
  readonly root: AgentTreeNode;
  readonly diagnostics: SessionTreeDiagnostic[];
}

/** Compact node returned by list_agents. */
export interface ListedAgentNode {
  readonly session_id: string;
  readonly parent_session_id: string | null;
  readonly agent_type: string;
  readonly profile: string;
  readonly title: string | null;
  readonly depth: number;
  readonly latest_execution_status: SessionExecutionRecord["status"] | null;
  readonly active_execution_id: string | null;
  readonly link_status: ToolChildSessionLinkStatus | null;
}
