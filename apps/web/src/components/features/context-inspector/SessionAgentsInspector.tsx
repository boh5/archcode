import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  Bot,
} from "lucide-react";
import { sessionQueryOptions, useAgents } from "../../../api/queries";
import type { SessionFamilyActivity, ToolChildSessionLink, ToolChildSessionLinkStatus } from "@archcode/protocol";
import { resolveAgentDisplayName } from "../../../lib/agent-constants";
import { useSessionFamilyActivity } from "../../../store/session-runtime-store";
import { useSessionStore } from "../../../store/session-store";
import { InspectorNotice } from "./InspectorPrimitives";
import { buildAgentFocusSearch } from "./session-canvas-navigation";
import { childExecutionVisualKind, presentChildExecutionStatus } from "../../../lib/execution-status-presentation";
import { STATUS_TONE_CLASS, statusVisual, type StatusTone, type VisualStatusKind } from "../../../lib/status-visuals";
import { StatusGlyph } from "../../primitives/StatusGlyph";
import { sessionFamilyActivityLabel, sessionFamilyVisual } from "../../../lib/session-family-presentation";
import { useAttentionVisibleScopedHitl } from "../../../store/hitl-store";
import type { SessionInspectorProjection } from "./session-inspector-projection";

interface AgentStatusPresentation {
  label: string;
  kind: VisualStatusKind;
  tone?: StatusTone;
  detail?: string;
}

export function resolveInspectorAgentStatus(
  rootActivity: SessionFamilyActivity | undefined,
  childStatus?: ToolChildSessionLinkStatus,
  gate?: "Permission" | "Question",
): AgentStatusPresentation {
  if (gate !== undefined) return { label: gate, kind: "needs_you" };
  if (childStatus !== undefined) {
    if (childStatus === "waiting_for_human") return { label: "Paused", kind: "pending" };
    const status = presentChildExecutionStatus(childStatus);
    return { label: status.label, kind: childExecutionVisualKind(childStatus), detail: status.detail };
  }
  const visual = sessionFamilyVisual(rootActivity);
  const label = sessionFamilyActivityLabel(rootActivity);
  return { label, ...visual };
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

export function SessionAgentsInspector({ projection }: { projection: SessionInspectorProjection["agents"] }) {
  const { slug = "", sessionId = "" } = useParams<{ slug: string; sessionId: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const focused = searchParams.get("focus") ?? sessionId;
  const { data: agentDescriptors = [] } = useAgents();
  const rootActivity = useSessionFamilyActivity(slug, sessionId);
  const childSessionLinks = useSessionStore(sessionId, (state) => state.childSessionLinks, slug);
  const pendingHitl = useAttentionVisibleScopedHitl([slug]);
  const gateByOwner = useMemo(() => new Map(pendingHitl.map((entry) => [
    entry.ownerSessionId,
    entry.view.source.type === "ask_user" ? "Question" as const : "Permission" as const,
  ])), [pendingHitl]);
  const sessionAgents = projection.items;
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

  if (projection.isLoading) return <InspectorNotice>Loading agents…</InspectorNotice>;
  if (projection.error) return <InspectorNotice tone="error">Failed to load agents</InspectorNotice>;
  if (sessionAgents.length === 0) return <InspectorNotice>No agent sessions</InspectorNotice>;
  return (
    <nav className="space-y-0.5" data-testid="context-agent-tree" aria-label="Agents">
      {sessionAgents.map((agent) => {
        const displayName = resolveAgentDisplayName(agent.type, agentDescriptors);
        const status = resolveInspectorAgentStatus(
          agent.sessionId === sessionId ? rootActivity : undefined,
          agent.sessionId === sessionId ? undefined : childStatusBySessionId.get(agent.sessionId),
          gateByOwner.get(agent.sessionId),
        );
        const statusTone = status.tone ?? statusVisual(status.kind).tone;
        return (
          <button
            key={agent.sessionId}
            type="button"
            aria-current={focused === agent.sessionId ? "true" : undefined}
            className={`relative grid min-h-11 w-full grid-cols-[22px_minmax(0,1fr)_auto] items-start gap-x-2 rounded-[6px] py-2 pr-2 text-left transition-colors duration-[var(--motion-hover)] focus-visible:outline-none focus-visible:[box-shadow:inset_0_0_0_2px_var(--brand)] ${focused === agent.sessionId ? "bg-bg-hover after:absolute after:bottom-2 after:left-0 after:top-2 after:w-0.5 after:rounded-sm after:bg-brand" : "hover:bg-bg-hover"}`}
            style={{ paddingLeft: 8 + (agent.depth * 14) }}
            onClick={() => navigate({ search: buildAgentFocusSearch(searchParams, sessionId, agent.sessionId) })}
          >
            {agent.depth > 0 && (
              <span
                aria-hidden="true"
                className="pointer-events-none absolute bottom-0 top-0 w-px bg-border-subtle"
                style={{ left: 18 + ((agent.depth - 1) * 14) }}
              />
            )}
            <span
              className={`mt-px grid h-[22px] w-[22px] place-items-center rounded-[5px] border bg-bg-base ${focused === agent.sessionId ? "border-brand/25 text-brand" : "border-border-subtle text-text-tertiary"}`}
              data-agent-role-icon={agent.type}
              title={`${displayName} agent`}
            >
              <Bot aria-hidden="true" size={12} strokeWidth={1.75} />
            </span>
            <span className="min-w-0">
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="truncate text-[12.5px] font-[650] leading-4 tracking-[-0.015em] text-text-primary">
                  {displayName}
                </span>
                <span className="shrink-0 font-mono text-[11px] leading-4 text-text-tertiary">{agent.profile}</span>
              </span>
              <span className="mt-0.5 block truncate text-[11.5px] leading-[1.35] text-text-secondary" title={agent.name}>
                {agent.name}
              </span>
            </span>
            <span
              className={`mt-0.5 inline-flex max-w-[92px] items-start gap-1 whitespace-nowrap text-[11px] font-semibold ${STATUS_TONE_CLASS[statusTone]}`}
              data-agent-status={status.label}
              title={status.detail ? `${status.label} · ${status.detail}` : status.label}
            >
              <StatusGlyph kind={status.kind} tone={status.tone} size={11} />
              <span className="min-w-0">
                <span className="block">{status.label}</span>
                {status.detail && <span className="block truncate text-[11px] font-normal text-text-tertiary">{status.detail}</span>}
              </span>
            </span>
          </button>
        );
      })}
    </nav>
  );
}
