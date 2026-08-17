import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
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

function agentRoleMark(displayName: string): string {
  return displayName.replace(/[^\p{L}\p{N}]/gu, "").slice(0, 2).toLocaleUpperCase() || "AG";
}

function agentRoleTone(agentType: string | null): string {
  if (agentType === "lead" || agentType === "discussion") return "bg-brand-muted text-brand";
  if (agentType === "analyst") return "bg-info-muted text-info";
  if (agentType === "build") return "bg-success-muted text-success";
  if (agentType === "explore") return "bg-warning-muted text-warning";
  return "bg-bg-muted text-text-secondary";
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
    <section>
      <span className="block text-[10.5px] font-bold uppercase leading-[21px] tracking-[0.09em] text-text-tertiary">Agent tree</span>
      <nav data-testid="context-agent-tree" aria-label="Agents">
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
            className={`relative grid min-h-[42px] w-full grid-cols-[25px_minmax(0,1fr)_auto] items-center gap-2 rounded-[6px] border px-1.5 py-[5px] text-left transition-colors duration-[var(--motion-fast)] focus-visible:outline-none focus-visible:[box-shadow:inset_0_0_0_2px_var(--brand)] ${focused === agent.sessionId ? "border-border-default bg-bg-muted [box-shadow:inset_2px_0_0_var(--brand)]" : "border-transparent hover:bg-bg-hover"}`}
            style={{ marginLeft: agent.depth * 12, width: `calc(100% - ${agent.depth * 12}px)` }}
            onClick={() => navigate({ search: buildAgentFocusSearch(searchParams, sessionId, agent.sessionId) })}
          >
            {agent.depth > 0 && (
              <span
                aria-hidden="true"
                className="pointer-events-none absolute bottom-0 top-0 w-px bg-border-subtle"
                style={{ left: -1 }}
              />
            )}
            <span
              className={`grid h-[25px] w-[25px] place-items-center rounded-[7px] font-mono text-[9.5px] font-bold leading-none ${agentRoleTone(agent.type)}`}
              data-agent-role-icon={agent.type}
              title={`${displayName} agent`}
            >
              {agentRoleMark(displayName)}
            </span>
            <span className="min-w-0">
              <span className="flex min-w-0 items-baseline gap-1">
                <span className="truncate text-[11px] font-semibold leading-[1.5] text-text-primary">
                  {displayName}
                </span>
                <span className="shrink-0 font-mono text-[11px] leading-[1.5] text-text-tertiary">{agent.profile}</span>
              </span>
              <span className="mt-0.5 block truncate text-[11px] leading-[1.5] text-text-tertiary" title={agent.name}>
                {agent.name}
              </span>
            </span>
            <span
              className={`inline-flex max-w-[92px] items-start gap-1 whitespace-nowrap text-[10.5px] font-semibold ${STATUS_TONE_CLASS[statusTone]}`}
              data-agent-status={status.label}
              title={status.detail ? `${status.label} · ${status.detail}` : status.label}
            >
              <StatusGlyph kind={status.kind} tone={status.tone} size={13} />
              <span className="min-w-0">
                <span className="block">{status.label}</span>
                {status.detail && <span className="block truncate text-[10.5px] font-normal text-text-tertiary">{status.detail}</span>}
              </span>
            </span>
          </button>
        );
      })}
      </nav>
    </section>
  );
}
