import type { ToolPart } from "@archcode/protocol";
import type { ToolRunItem } from "../../lib/tool-runs";
import { getToolSummary } from "../../lib/tool-format";
import { WORK_ACTIVITY_NESTED_LANE_CLASS } from "../primitives/ConversationRail";
import { ToolCard } from "./ToolCard";

function isSettled(part: ToolPart): part is Extract<ToolPart, { state: "completed" | "error" }> {
  return part.state === "completed" || part.state === "error";
}

export function toolRunItemNeedsDetails(part: ToolPart): boolean {
  if (!isSettled(part)) return false;
  return part.state === "error"
    || part.result.details?.error !== undefined
    || part.result.details?.unknownResult === true
    || part.result.output.recovery.kind === "artifact";
}

export function ToolRunItemRow({
  item,
  projectSlug,
  sessionId,
}: {
  readonly item: ToolRunItem;
  readonly projectSlug: string;
  readonly sessionId: string;
}) {
  const { part } = item;
  const summary = getToolSummary(
    part.toolName,
    "input" in part ? part.input : undefined,
  );
  const label = `${part.toolName}, ${summary.primary}`;

  if (toolRunItemNeedsDetails(part)) {
    return (
      <div
        aria-label={label}
        className="min-w-0"
        data-testid="tool-run-child"
        role="listitem"
      >
        <ToolCard
          part={part}
          projectSlug={projectSlug}
          sessionId={sessionId}
          grouped
        />
      </div>
    );
  }

  return (
    <div
      aria-label={label}
      className={`grid min-h-9 grid-cols-[minmax(0,160px)_minmax(0,1fr)_auto] items-center gap-3 border-b border-border-subtle px-2 py-1.5 last:border-b-0 max-[560px]:grid-cols-[minmax(0,112px)_minmax(0,1fr)_auto] ${WORK_ACTIVITY_NESTED_LANE_CLASS}`}
      data-testid="tool-run-child"
      role="listitem"
      title={label}
    >
      <code className="min-w-0 truncate font-mono text-[12px] font-semibold text-text-tertiary" title={part.toolName}>
        {part.toolName}
      </code>
      <span className="truncate text-[13px] font-medium text-text-secondary">
        {summary.primary}
      </span>
      {(part.state === "pending" || part.state === "running") && (
        <span className="text-[10px] font-semibold text-signal-foreground">
          {part.state === "pending" ? "Pending" : "Running"}
        </span>
      )}
    </div>
  );
}
