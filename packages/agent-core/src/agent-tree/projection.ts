import type {
  AgentTreeNode,
  AgentTreeProjection,
  SessionExecutionRecord,
  SessionTreeNode,
  SessionTreeResponse,
  ToolChildSessionLink,
} from "@archcode/protocol";

export interface AgentTreeDurableFile {
  readonly executions: readonly SessionExecutionRecord[];
  readonly childSessionLinks: readonly ToolChildSessionLink[];
}

export interface AgentTreeDurableSnapshot {
  readonly rootSessionId: string;
  readonly revision: string;
  readonly tree: SessionTreeResponse;
  readonly files: ReadonlyMap<string, AgentTreeDurableFile>;
}

export type AgentTreeProjectionErrorReason =
  | "missing_durable_session"
  | "multiple_nonterminal_executions"
  | "nonterminal_execution_not_latest"
  | "active_execution_mismatch"
  | "unknown_active_session"
  | "link_status_conflict";

export class AgentTreeProjectionError extends Error {
  constructor(
    public readonly reason: AgentTreeProjectionErrorReason,
    public readonly sessionId: string,
    message: string,
  ) {
    super(message);
    this.name = "AgentTreeProjectionError";
  }
}

/** Pure durable/live projection. It never performs recovery or persistence. */
export function projectAgentTree(
  snapshot: AgentTreeDurableSnapshot,
  activeExecutionIds: ReadonlyMap<string, string>,
): AgentTreeProjection {
  for (const sessionId of activeExecutionIds.keys()) {
    if (!snapshot.files.has(sessionId)) {
      throw new AgentTreeProjectionError(
        "unknown_active_session",
        sessionId,
        `Active Execution snapshot contains Session "${sessionId}" outside root "${snapshot.rootSessionId}"`,
      );
    }
  }

  return {
    root: projectNode(snapshot.tree.root, 0, snapshot, activeExecutionIds),
    diagnostics: snapshot.tree.diagnostics,
  };
}

function projectNode(
  node: SessionTreeNode,
  depth: number,
  snapshot: AgentTreeDurableSnapshot,
  activeExecutionIds: ReadonlyMap<string, string>,
): AgentTreeNode {
  const sessionId = node.session.sessionId;
  const file = snapshot.files.get(sessionId);
  if (file === undefined) {
    throw new AgentTreeProjectionError(
      "missing_durable_session",
      sessionId,
      `Agent Tree durable snapshot is missing Session "${sessionId}"`,
    );
  }

  const nonterminal = file.executions.filter(
    (execution) => execution.status === "running" || execution.status === "suspended",
  );
  if (nonterminal.length > 1) {
    throw new AgentTreeProjectionError(
      "multiple_nonterminal_executions",
      sessionId,
      `Session "${sessionId}" has multiple nonterminal Executions`,
    );
  }

  const latest = file.executions.at(-1);
  if (nonterminal.length === 1 && nonterminal[0]?.id !== latest?.id) {
    throw new AgentTreeProjectionError(
      "nonterminal_execution_not_latest",
      sessionId,
      `Session "${sessionId}" has a nonterminal Execution that is not latest`,
    );
  }
  const activeExecutionId = activeExecutionIds.get(sessionId) ?? null;
  const latestIsActive = latest?.status === "running";
  if (
    (latestIsActive && activeExecutionId !== latest.id)
    || (!latestIsActive && activeExecutionId !== null)
  ) {
    throw new AgentTreeProjectionError(
      "active_execution_mismatch",
      sessionId,
      `Session "${sessionId}" durable and active Execution identities do not match`,
    );
  }

  return {
    session: node.session,
    depth,
    latestExecutionStatus: latest?.status ?? null,
    activeExecutionId,
    linkStatus: resolveLinkStatus(node, latest?.id, snapshot),
    children: node.children.map((child) => projectNode(child, depth + 1, snapshot, activeExecutionIds)),
  };
}

function resolveLinkStatus(
  node: SessionTreeNode,
  latestExecutionId: string | undefined,
  snapshot: AgentTreeDurableSnapshot,
): AgentTreeNode["linkStatus"] {
  const parentSessionId = node.session.parentSessionId;
  if (parentSessionId === undefined || latestExecutionId === undefined) return null;

  const parent = snapshot.files.get(parentSessionId);
  if (parent === undefined) {
    throw new AgentTreeProjectionError(
      "missing_durable_session",
      parentSessionId,
      `Agent Tree durable snapshot is missing parent Session "${parentSessionId}"`,
    );
  }

  const statuses = new Set(
    parent.childSessionLinks
      .filter((link) => (
        link.childSessionId === node.session.sessionId
        && link.childExecutionId === latestExecutionId
      ))
      .map((link) => link.status),
  );
  if (statuses.size > 1) {
    throw new AgentTreeProjectionError(
      "link_status_conflict",
      node.session.sessionId,
      `Session "${node.session.sessionId}" has inconsistent parent Link statuses for Execution "${latestExecutionId}"`,
    );
  }
  return statuses.values().next().value ?? null;
}
