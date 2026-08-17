import { useEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { ToolPart } from "@archcode/protocol";
import type { ToolRunItem } from "../../lib/tool-runs";
import { getToolSummary } from "../../lib/tool-format";
import { WORK_ACTIVITY_CHILD_LANE_CLASS } from "../primitives/ConversationRail";
import { ToolRunItemRow } from "./ToolRunItemRow";

function isSettled(part: ToolPart): part is Extract<ToolPart, { state: "completed" | "error" }> {
  return part.state === "completed" || part.state === "error";
}

function latestActiveTool(tools: readonly ToolPart[]): ToolPart | undefined {
  for (let index = tools.length - 1; index >= 0; index -= 1) {
    const tool = tools[index];
    if (tool?.state === "pending" || tool?.state === "running") return tool;
  }
  return undefined;
}

export interface ToolRunCardProps {
  readonly id: string;
  readonly items: readonly ToolRunItem[];
  readonly tools: readonly ToolPart[];
  readonly projectSlug: string;
  readonly sessionId: string;
}

export function ToolRunCard({
  id,
  items,
  tools,
  projectSlug,
  sessionId,
}: ToolRunCardProps) {
  const hasLiveOutput = tools.some((tool) =>
    tool.state === "running" && tool.liveOutput !== undefined
  );
  const [expanded, setExpanded] = useState(hasLiveOutput);
  const manuallyCollapsed = useRef(false);
  useEffect(() => {
    if (hasLiveOutput && !manuallyCollapsed.current) setExpanded(true);
  }, [hasLiveOutput]);

  const running = tools.some((tool) => tool.state === "pending" || tool.state === "running");
  const representative = running ? latestActiveTool(tools) : tools.at(-1);
  const failed = !running && tools.some((tool) => tool.state === "error");
  const interruptedCount = running
    ? 0
    : tools.filter((tool) => tool.state === "interrupted").length;
  const isUnknownResult = !running && tools.some((tool) =>
    isSettled(tool) && tool.result.details?.unknownResult === true
  );
  const visualKind = running
    ? "loading"
    : failed
      ? "failed"
      : interruptedCount > 0
        ? "stopped"
        : isUnknownResult
          ? "warning"
          : "completed";

  if (!representative) return null;

  const activeSummary = getToolSummary(
    representative.toolName,
    "input" in representative ? representative.input : undefined,
  );
  const toolNames = [...new Set(tools.map((tool) => tool.toolName))].join(", ");
  const statusLabel = running
    ? "Running"
    : failed
      ? interruptedCount > 0
        ? `Error, ${interruptedCount} Interrupted`
        : "Error"
      : interruptedCount > 0
        ? `${interruptedCount} Interrupted`
        : isUnknownResult
          ? "Unknown"
          : "Completed";
  const bodyId = `${id}-body`;
  const accessibleName = running
    ? [
        `${tools.length} tool calls`,
        representative.toolName,
        activeSummary.primary,
        statusLabel,
      ].filter(Boolean).join(", ")
    : [`${tools.length} tool calls`, toolNames, statusLabel].join(", ");

  return (
    <div className="w-full min-w-0 shrink-0" data-testid="tool-run-card">
      <button
        type="button"
        className={`tool-run-summary-control grid min-h-9 cursor-pointer select-none grid-cols-[12px_minmax(0,1fr)_auto] items-center gap-[7px] rounded border-0 bg-transparent px-2 text-left transition-colors duration-[var(--motion-fast)] hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand [@media(pointer:coarse)]:min-h-11 ${WORK_ACTIVITY_CHILD_LANE_CLASS}`}
        onClick={() => setExpanded((value) => {
          const next = !value;
          if (!next) manuallyCollapsed.current = true;
          return next;
        })}
        aria-expanded={expanded}
        aria-controls={bodyId}
        aria-label={accessibleName}
      >
        <ChevronRight
          size={10}
          className={`text-text-muted transition-transform duration-[var(--motion-fast)] ${expanded ? "rotate-90" : ""}`}
          aria-hidden="true"
        />
        {running ? (
          <span
            key={representative.id}
            className="animate-tool-run-swap flex min-w-0 items-center gap-2 overflow-hidden"
            data-testid="tool-run-representative"
            data-tool-id={representative.id}
          >
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-signal"
              data-tool-visual-kind={visualKind}
              aria-hidden="true"
            />
            <span
              className="min-w-0 max-w-[180px] truncate font-mono text-[13px] font-semibold text-text-secondary [@media(max-width:560px)]:max-w-[112px]"
              title={representative.toolName}
            >
              {representative.toolName}
            </span>
            <span className="truncate text-[13px] text-text-secondary">{activeSummary.primary}</span>
          </span>
        ) : (
          <span
            className={`min-w-0 truncate whitespace-nowrap font-mono text-[13px] font-semibold ${isUnknownResult ? "text-warning" : "text-text-secondary"}`}
            data-testid="tool-run-tool-names"
            title={toolNames}
          >
            {toolNames}
          </span>
        )}
        {!running && failed && <span className="shrink-0 text-[10px] font-semibold text-error">Error</span>}
        {!running && interruptedCount > 0 && (
          <span className="shrink-0 text-[10px] font-semibold text-warning">
            {interruptedCount === 1 ? "Interrupted" : `${interruptedCount} Interrupted`}
          </span>
        )}
        {!running && !failed && interruptedCount === 0 && isUnknownResult && <span className="shrink-0 text-[10px] font-semibold text-warning">Unknown</span>}
      </button>
      {expanded && (
        <div
          id={bodyId}
          className="mt-[3px] grid min-w-0 gap-0.5"
          data-testid="tool-run-list"
          role="list"
        >
          {items.map((item) => (
            <ToolRunItemRow
              key={item.part.id}
              item={item}
              projectSlug={projectSlug}
              sessionId={sessionId}
            />
          ))}
        </div>
      )}
    </div>
  );
}
