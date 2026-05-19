import { useNavigate } from "react-router-dom";

const AGENT_TYPES = [
  "orchestrator",
  "product",
  "spec",
  "critic",
  "foreman",
  "builder",
  "reviewer",
  "librarian",
  "explorer",
] as const;

type AgentType = (typeof AGENT_TYPES)[number];

const AGENT_ICON_COLORS: Record<AgentType, string> = {
  orchestrator: "bg-[#8b5cf630] text-[#8b5cf6]",
  product: "bg-[#6366f120] text-[#6366f1]",
  spec: "bg-[#3b82f620] text-[#3b82f6]",
  critic: "bg-[#f59e0b20] text-[#f59e0b]",
  foreman: "bg-[#10b98120] text-[#10b981]",
  builder: "bg-[#06b6d420] text-[#06b6d4]",
  reviewer: "bg-[#ec489920] text-[#ec4899]",
  librarian: "bg-[#8b5cf620] text-[#8b5cf6]",
  explorer: "bg-[#64748b20] text-[#64748b]",
};

const AGENT_INITIALS: Record<AgentType, string> = {
  orchestrator: "O",
  product: "P",
  spec: "S",
  critic: "C",
  foreman: "F",
  builder: "B",
  reviewer: "R",
  librarian: "L",
  explorer: "E",
};

function isValidAgentType(value: string): value is AgentType {
  return (AGENT_TYPES as readonly string[]).includes(value);
}

function formatElapsed(startedAt: number): string {
  const elapsed = Date.now() - startedAt;
  const seconds = Math.floor(elapsed / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (seconds < 60) return `${seconds}s`;
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${hours}h ${minutes % 60}m`;
}

type BadgeStatus = "running" | "completed" | "pending";

const BADGE_CLASSES: Record<BadgeStatus, string> = {
  running: "bg-success-muted text-success",
  completed: "bg-accent-muted text-accent",
  pending: "bg-bg-active text-text-muted",
};

const BADGE_LABELS: Record<BadgeStatus, string> = {
  running: "Running",
  completed: "Completed",
  pending: "Pending",
};

type ToolStatus = "success" | "error" | "default";

const TOOL_CHIP_STATUS_CLASSES: Record<ToolStatus, string> = {
  success: "text-success",
  error: "text-error",
  default: "text-text-tertiary",
};

function ToolChip({ name, status }: { name: string; status: ToolStatus }) {
  return (
    <span
      className={`flex items-center gap-1 px-[7px] py-[2px] rounded-sm bg-bg-active text-[11px] font-mono ${TOOL_CHIP_STATUS_CLASSES[status]}`}
    >
      {status === "success" && "✓"}
      {status === "error" && "✗"}
      {name}
    </span>
  );
}

export interface DelegationCardProps {
  /** Unique identifier for the sub-agent session */
  agentId: string;
  /** Agent type for color mapping (falls back to "explorer" if unknown) */
  agentType: string;
  /** Display name shown in the header */
  agentName: string;
  /** Current status of the delegation */
  status: BadgeStatus;
  /** Delegation depth (0 = top-level, 1 = first sub-agent, etc.) */
  depth: number;
  /** Timestamp (ms) when the delegation started, used for elapsed time */
  startedAt: number;
  /** Short summary of what the sub-agent is doing / has done */
  summary: string;
  /** Tool invocations to display as chips */
  tools: Array<{ name: string; status: ToolStatus }>;
  /** Current project slug (for building navigation link) */
  projectSlug: string;
  /** Current parent session ID (for building navigation link) */
  parentSessionId: string;
}

export function DelegationCard({
  agentId,
  agentType,
  agentName,
  status,
  depth,
  startedAt,
  summary,
  tools,
  projectSlug,
  parentSessionId,
}: DelegationCardProps) {
  const navigate = useNavigate();
  const resolvedType = isValidAgentType(agentType) ? agentType : "explorer" as AgentType;
  const colorClasses = AGENT_ICON_COLORS[resolvedType];
  const initials = AGENT_INITIALS[resolvedType];

  const handleViewConversation = () => {
    navigate(`/projects/${projectSlug}/sessions/${parentSessionId}?focusAgent=${agentId}`);
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
            <ToolChip key={`${tool.name}-${i}`} name={tool.name} status={tool.status} />
          ))}
        </div>
      )}
    </div>
  );
}