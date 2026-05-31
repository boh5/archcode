import { getWebSessionStore } from "../../store/session-store";
import { AGENT_INITIALS, AGENT_ICON_COLORS, isValidAgentType, type AgentType, BADGE_CLASSES, BADGE_LABELS, type BadgeStatus } from "../../lib/agent-constants";
import { formatElapsed } from "../../lib/time-format";
import { getToolSummary, getToolIcon } from "../../lib/tool-format";
import { getToolCategory } from "@specra/protocol";

type ToolStatus = "success" | "error" | "default";

const TOOL_CHIP_STATUS_CLASSES: Record<ToolStatus, string> = {
  success: "text-success",
  error: "text-error",
  default: "text-text-tertiary",
};

export function ToolChip({ name, status, input }: { name: string; status: ToolStatus; input?: unknown }) {
  const summary = input !== undefined ? getToolSummary(name, input) : null;
  const category = getToolCategory(name);
  const icon = getToolIcon(category);

  const label = summary
    ? (summary.primary !== "—" ? `${name} · ${summary.primary}` : name)
    : name;

  return (
    <span
      className={`flex items-center gap-1 px-[7px] py-[2px] rounded-sm bg-bg-active text-[11px] font-mono ${TOOL_CHIP_STATUS_CLASSES[status]}`}
      title={name}
    >
      {status === "success" && <span aria-hidden="true">✓</span>}
      {status === "error" && <span aria-hidden="true">✗</span>}
      <span className="text-[10px]" aria-hidden="true">{icon}</span>
      <span className="truncate max-w-[140px]">{label}</span>
    </span>
  );
}

export interface DelegationCardProps {
  sessionId: string;
  focusStoreSessionId: string;
  agentType: string;
  agentName: string;
  status: BadgeStatus;
  depth: number;
  startedAt: number;
  summary: string;
  tools: Array<{ name: string; status: ToolStatus; input?: unknown }>;
  projectSlug: string;
}

export function DelegationCard({
  sessionId,
  focusStoreSessionId,
  agentType,
  agentName,
  status,
  depth,
  startedAt,
  summary,
  tools,
  projectSlug,
}: DelegationCardProps) {
  const resolvedType = isValidAgentType(agentType) ? agentType : "explorer" as AgentType;
  const colorClasses = AGENT_ICON_COLORS[resolvedType];
  const initials = AGENT_INITIALS[resolvedType];

  const handleViewConversation = () => {
    const store = getWebSessionStore(focusStoreSessionId, projectSlug);
    store.getState().setFocusSessionId(sessionId);
  };

  return (
    <div className="bg-bg-surface border border-border-default rounded-lg overflow-hidden my-2.5 shrink-0 min-h-0 transition-colors duration-150 hover:border-border-strong">
      <div
        className="flex items-center gap-2.5 px-3.5 py-2.5 bg-bg-elevated border-b border-border-subtle cursor-pointer select-none hover:bg-bg-hover"
        onClick={handleViewConversation}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") handleViewConversation();
        }}
      >
        <div
          className={`w-[22px] h-[22px] rounded flex items-center justify-center text-[10px] shrink-0 ${colorClasses}`}
        >
          {initials}
        </div>

        <span
          className={`px-2 py-[2px] rounded-[10px] text-[10.5px] font-semibold ${BADGE_CLASSES[status]}`}
        >
          {BADGE_LABELS[status]}
        </span>

        <span className="font-semibold text-[13px] flex-1 min-w-0 truncate">
          {agentName}
        </span>

        <span className="text-[11px] text-text-muted shrink-0">
          depth {depth}
        </span>

        <div className="flex items-center gap-3 text-[11px] text-text-muted shrink-0">
          {status === "running" && (
            <span className="flex items-center gap-1">
              <span className="w-[5px] h-[5px] rounded-full bg-success animate-pulse" />
              {formatElapsed(startedAt)}
            </span>
          )}
          {status === "completed" && (
            <span>done</span>
          )}
        </div>

        <span className="px-2.5 py-1 rounded-sm text-[11px] font-medium text-accent bg-accent-subtle cursor-pointer transition-colors duration-150 hover:bg-accent-muted shrink-0">
          View full conversation →
        </span>
      </div>

      {summary && (
        <div className="px-3.5 py-2.5 text-[12.5px] text-text-secondary leading-[1.55]">
          {summary}
        </div>
      )}

      {tools.length > 0 && (
        <div className="px-3.5 pb-2.5 pt-1.5 flex flex-wrap gap-1.5">
          {tools.map((tool, i) => (
            <ToolChip key={`${tool.name}-${i}`} name={tool.name} status={tool.status} input={tool.input} />
          ))}
        </div>
      )}
    </div>
  );
}
