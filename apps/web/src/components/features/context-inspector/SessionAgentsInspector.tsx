import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  Bot,
  Hammer,
  Library,
  ScanSearch,
  Telescope,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { sessionQueryOptions, useAgents, useSessionTree } from "../../../api/queries";
import type { SessionTreeNode } from "../../../api/types";
import type { SessionFamilyActivity, ToolChildSessionLink, ToolChildSessionLinkStatus } from "@archcode/protocol";
import { resolveAgentDisplayName } from "../../../lib/agent-constants";
import { useSessionFamilyActivity } from "../../../store/session-runtime-store";
import { useSessionStore } from "../../../store/session-store";
import { InspectorNotice } from "./InspectorPrimitives";
import { buildAgentFocusSearch } from "./session-canvas-navigation";
import { childExecutionVisualKind, presentChildExecutionStatus } from "../../../lib/execution-status-presentation";
import { STATUS_TONE_CLASS, statusVisual, type StatusTone, type VisualStatusKind } from "../../../lib/status-visuals";
import { StatusGlyph } from "../../primitives/StatusGlyph";
import { sessionFamilyVisual } from "../../../lib/session-family-presentation";

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
  kind: VisualStatusKind;
  tone?: StatusTone;
  detail?: string;
}

const AGENT_ROLE_ICON: Readonly<Record<string, LucideIcon>> = {
  lead: Workflow,
  analyst: ScanSearch,
  build: Hammer,
  explore: Telescope,
  librarian: Library,
};

export function resolveInspectorAgentStatus(
  rootActivity: SessionFamilyActivity | undefined,
  childStatus?: ToolChildSessionLinkStatus,
): AgentStatusPresentation {
  if (childStatus !== undefined) {
    const status = presentChildExecutionStatus(childStatus);
    return { label: status.label, kind: childExecutionVisualKind(childStatus), detail: status.detail };
  }
  const visual = sessionFamilyVisual(rootActivity);
  const label = rootActivity === "running" ? "Running" : rootActivity === "stopping" ? "Stopping" : rootActivity === "idle" ? "Idle" : "Status unavailable";
  return { label, ...visual };
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
    <nav className="space-y-0.5" data-testid="context-agent-tree" aria-label="Agents">
      {sessionAgents.map((agent) => {
        const displayName = resolveAgentDisplayName(agent.type, agentDescriptors);
        const RoleIcon = AGENT_ROLE_ICON[agent.type] ?? Bot;
        const status = resolveInspectorAgentStatus(
          agent.sessionId === sessionId ? rootActivity : undefined,
          agent.sessionId === sessionId ? undefined : childStatusBySessionId.get(agent.sessionId),
        );
        const statusTone = status.tone ?? statusVisual(status.kind).tone;
        const connectorLeft = 8 + ((agent.depth - 1) * 14);
        return (
          <button
            key={agent.sessionId}
            type="button"
            aria-current={focused === agent.sessionId ? "true" : undefined}
            className={`relative grid w-full grid-cols-[28px_minmax(0,1fr)_auto] items-start gap-x-2 rounded-sm py-2 pr-2 text-left transition-colors duration-[var(--motion-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand ${focused === agent.sessionId ? "bg-brand-subtle" : "hover:bg-bg-hover"}`}
            style={{ paddingLeft: 8 + (agent.depth * 14) }}
            onClick={() => navigate({ search: buildAgentFocusSearch(searchParams, sessionId, agent.sessionId) })}
          >
            {agent.depth > 0 && (
              <>
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute bottom-0 top-0 w-px bg-border-subtle"
                  style={{ left: connectorLeft }}
                />
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute top-5 h-px w-[14px] bg-border-subtle"
                  style={{ left: connectorLeft }}
                />
              </>
            )}
            <span
              className={`grid h-7 w-7 place-items-center rounded-sm border ${focused === agent.sessionId ? "border-brand/30 bg-bg-elevated text-brand" : "border-border-subtle bg-bg-base text-text-tertiary"}`}
              data-agent-role-icon={agent.type}
              title={`${displayName} agent`}
            >
              <RoleIcon aria-hidden="true" size={13} strokeWidth={1.75} />
            </span>
            <span className="min-w-0">
              <span className="flex min-w-0 items-baseline gap-2">
                <span className={`truncate text-[12px] font-semibold leading-4 ${focused === agent.sessionId ? "text-brand" : "text-text-primary"}`}>
                  {displayName}
                </span>
                <span className="shrink-0 font-mono text-[10px] leading-4 text-text-tertiary">{agent.profile}</span>
              </span>
              <span className="mt-0.5 block truncate text-[11px] leading-4 text-text-secondary" title={agent.name}>
                {agent.name}
              </span>
              {agent.skills.length > 0 && (
                <span className="mt-0.5 block truncate text-[10px] leading-4 text-text-tertiary" title={`Skills: ${agent.skills.join(", ")}`}>
                  Skills: {agent.skills.join(", ")}
                </span>
              )}
            </span>
            <span
              className={`inline-flex max-w-[92px] items-start gap-1 whitespace-nowrap pt-0.5 text-[10px] font-medium ${STATUS_TONE_CLASS[statusTone]}`}
              data-agent-status={status.label}
              title={status.detail ? `${status.label} · ${status.detail}` : status.label}
            >
              <StatusGlyph kind={status.kind} tone={status.tone} size={11} />
              <span className="min-w-0">
                <span className="block">{status.label}</span>
                {status.detail && <span className="block truncate text-[9px] font-normal text-text-tertiary">{status.detail}</span>}
              </span>
            </span>
          </button>
        );
      })}
    </nav>
  );
}
