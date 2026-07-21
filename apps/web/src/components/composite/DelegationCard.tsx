import { getWebSessionStore } from "../../store/session-store";
import { BADGE_CLASSES, BADGE_LABELS, resolveAgentAppearance, type BadgeStatus } from "../../lib/agent-constants";
import { formatElapsed } from "../../lib/time-format";
import { Check, X } from "lucide-react";
import { getToolSummary, getToolIcon } from "../../lib/tool-format";
import { getToolCategory } from "@archcode/protocol";
import type { DelegationCardViewModel, DelegationToolStatus } from "../../lib/delegation-card-model";

const TOOL_CHIP_STATUS_CLASSES: Record<DelegationToolStatus, string> = {
  success: "text-success",
  error: "text-error",
  default: "text-text-tertiary",
};

export function ToolChip({ name, status, input }: { name: string; status: DelegationToolStatus; input?: unknown }) {
  const summary = input !== undefined ? getToolSummary(name, input) : null;
  const category = getToolCategory(name);
  const Icon = getToolIcon(category);

  const label = summary
    ? (summary.primary !== "—" ? `${name} · ${summary.primary}` : name)
    : name;

  return (
    <span
      className={`flex items-center gap-1 px-[7px] py-[2px] rounded-sm bg-bg-active text-[11px] font-mono ${TOOL_CHIP_STATUS_CLASSES[status]}`}
      title={name}
    >
      {status === "success" && <Check size={11} aria-hidden="true" />}
      {status === "error" && <X size={11} aria-hidden="true" />}
      <Icon size={10} aria-hidden="true" />
      <span className="truncate max-w-[140px]">{label}</span>
    </span>
  );
}

export function DelegationCard({
  sessionId,
  focusStoreSessionId,
  agentType,
  agentDisplayName,
  profile,
  skills,
  taskTitle,
  executionStatus,
  depth,
  startedAt,
  taskSummary,
  tools,
  projectSlug,
  canNavigate = true,
}: DelegationCardViewModel) {
  const appearance = resolveAgentAppearance(agentType, agentDisplayName);

  const handleViewConversation = () => {
    if (!canNavigate) return;
    const store = getWebSessionStore(focusStoreSessionId, projectSlug);
    store.getState().setFocusSessionId(sessionId);
  };

  return (
    <div className="bg-bg-surface border border-border-default rounded-lg overflow-hidden my-2.5 shrink-0 min-h-0 transition-colors duration-150 hover:border-border-strong">
      <div
        className={`flex items-center gap-2.5 px-3.5 py-2.5 bg-bg-elevated border-b border-border-subtle select-none ${canNavigate ? "cursor-pointer hover:bg-bg-hover" : "cursor-not-allowed opacity-70"}`}
        onClick={handleViewConversation}
        role="button"
        tabIndex={canNavigate ? 0 : undefined}
        aria-disabled={!canNavigate}
        onKeyDown={(e) => {
          if (canNavigate && (e.key === "Enter" || e.key === " ")) handleViewConversation();
        }}
      >
        <div
          className={`w-[22px] h-[22px] rounded flex items-center justify-center text-[10px] shrink-0 ${appearance.iconClass}`}
        >
          {appearance.initial}
        </div>

        <span
          className={`px-2 py-[2px] rounded-[10px] text-[10.5px] font-semibold ${BADGE_CLASSES[executionStatus]}`}
          aria-label={`Execution status: ${BADGE_LABELS[executionStatus]}`}
        >
          Execution: {BADGE_LABELS[executionStatus]}
        </span>

        <div className="flex items-baseline gap-1.5 flex-1 min-w-0">
          <span className="font-semibold text-[13px] shrink-0">
            {agentDisplayName}
          </span>
          {taskTitle && (
            <span className="text-[12px] text-text-secondary truncate" title={taskTitle}>
              {taskTitle}
            </span>
          )}
        </div>

        <span className="rounded-sm bg-bg-active px-1.5 py-0.5 font-mono text-[10px] text-text-tertiary" title="Delegated model profile">
          {profile}
        </span>

        <span className="text-[11px] text-text-muted shrink-0">
          depth {depth}
        </span>

        <div className="flex items-center gap-3 text-[11px] text-text-muted shrink-0">
          {executionStatus === "running" && (
            <span className="flex items-center gap-1">
              <span className="w-[5px] h-[5px] rounded-full bg-success animate-pulse" />
              {formatElapsed(startedAt)}
            </span>
          )}
        </div>

        {canNavigate ? (
          <span className="px-2.5 py-1 rounded-sm text-[11px] font-medium text-accent bg-accent-subtle cursor-pointer transition-colors duration-150 hover:bg-accent-muted shrink-0">
            View full conversation →
          </span>
        ) : (
          <span className="px-2.5 py-1 rounded-sm text-[11px] font-medium text-text-muted bg-bg-active shrink-0" title="Session ID not yet available — sub-agent is still starting">
            Waiting…
          </span>
        )}
      </div>

      {taskSummary && (
        <div className="px-3.5 py-2.5 text-[12.5px] text-text-secondary leading-[1.55] whitespace-pre-wrap">
          {taskSummary}
        </div>
      )}

      {skills.length > 0 && (
        <div className="flex flex-wrap gap-1 border-t border-border-subtle px-3.5 py-2">
          <span className="mr-1 text-[10px] font-medium uppercase tracking-wide text-text-muted">Skills</span>
          {skills.map((skill) => <span key={skill} className="rounded-sm bg-bg-active px-1.5 py-0.5 font-mono text-[10px] text-text-secondary">{skill}</span>)}
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
