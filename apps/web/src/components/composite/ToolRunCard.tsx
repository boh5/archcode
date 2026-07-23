import { useState } from "react";
import { ChevronRight } from "lucide-react";
import type { ToolPart } from "@archcode/protocol";
import type { ToolRunItem } from "../../lib/tool-runs";
import { getToolSummary } from "../../lib/tool-format";
import {
  STATUS_SUBTLE_CLASS,
  STATUS_TONE_CLASS,
  statusVisual,
  type VisualStatusKind,
} from "../../lib/status-visuals";
import { StatusGlyph } from "../primitives/StatusGlyph";
import { useStatusTransition } from "../primitives/useStatusTransition";
import { ToolCard } from "./ToolCard";

function toolVisualKind(state: ToolPart["state"], unknownResult: boolean): VisualStatusKind {
  if (unknownResult) return "warning";
  if (state === "pending") return "pending";
  if (state === "running") return "loading";
  if (state === "completed") return "completed";
  return "failed";
}

function isSettled(part: ToolPart): part is Extract<ToolPart, { state: "completed" | "error" }> {
  return part.state === "completed" || part.state === "error";
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
  const [expanded, setExpanded] = useState(false);
  const running = tools.some((tool) => tool.state === "pending" || tool.state === "running");
  const representative = tools.at(-1);
  const failed = !running && tools.some((tool) => tool.state === "error");
  const isUnknownResult = !running && tools.some((tool) =>
    isSettled(tool) && tool.result.details?.unknownResult === true
  );
  const visualKind = running
    ? "loading"
    : failed
      ? "failed"
      : isUnknownResult
        ? "warning"
        : representative
          ? toolVisualKind(representative.state, false)
          : "unknown";
  const statusTransition = useStatusTransition(id, visualKind);

  if (!representative) return null;

  const tone = statusVisual(visualKind).tone;
  const activeSummary = getToolSummary(
    representative.toolName,
    "input" in representative ? representative.input : undefined,
  );
  const ToolIcon = activeSummary.icon;
  const toolNames = tools.map((tool) => tool.toolName).join(", ");
  const statusLabel = running
    ? "Running"
    : failed
      ? "Error"
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
    <div className="max-w-[740px] shrink-0" data-testid="tool-run-card">
      <button
        type="button"
        className="grid min-h-10 w-full select-none grid-cols-[18px_minmax(0,1fr)_auto_12px] items-center gap-2 rounded-md border border-border-subtle bg-bg-elevated px-2.5 py-1.5 text-left transition-colors duration-[var(--motion-hover)] hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-controls={bodyId}
        aria-label={accessibleName}
      >
        <span
          className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-sm ${STATUS_SUBTLE_CLASS[tone]}`}
          data-tool-visual-kind={visualKind}
        >
          <StatusGlyph kind={visualKind} size={11} transition={statusTransition} />
        </span>
        {running ? (
          <span
            key={representative.id}
            className="animate-tool-run-swap flex min-w-0 items-baseline gap-2 overflow-hidden"
            data-testid="tool-run-representative"
            data-tool-id={representative.id}
          >
            <span className="shrink-0 whitespace-nowrap font-mono text-[12px] font-medium text-text-secondary">
              {ToolIcon ? <ToolIcon size={12} className="mr-1 inline-block align-text-bottom" /> : null}
              {representative.toolName}
            </span>
            <span className="truncate text-[10px] text-text-secondary">{activeSummary.primary}</span>
            {activeSummary.secondary && (
              <span className="truncate text-[9px] text-text-tertiary max-[560px]:hidden">
                {activeSummary.secondary}
              </span>
            )}
          </span>
        ) : (
          <span
            className={`min-w-0 truncate whitespace-nowrap font-mono text-[12px] font-medium ${isUnknownResult ? "text-warning" : "text-text-secondary"}`}
            data-testid="tool-run-tool-names"
            title={toolNames}
          >
            {toolNames}
          </span>
        )}
        <span className="flex shrink-0 items-center gap-2">
          <span className="rounded-sm bg-bg-active px-1.5 py-0.5 font-mono text-[9px] tabular-nums text-text-tertiary">
            {tools.length}
          </span>
          <span className={`text-[9px] font-semibold ${running ? "text-signal-foreground" : STATUS_TONE_CLASS[tone]}`}>
            {statusLabel}
          </span>
        </span>
        <ChevronRight
          size={10}
          className={`text-text-muted transition-transform duration-[var(--motion-icon)] ${expanded ? "rotate-90" : ""}`}
          aria-hidden="true"
        />
      </button>
      {expanded && (
        <div
          id={bodyId}
          className="ml-4 flex flex-col border-l border-border-default pl-2 pt-1 [&_[data-tool-card]]:rounded-none [&_[data-tool-card]]:border-x-0 [&_[data-tool-card]]:border-b-0 [&_[data-tool-card]:last-child]:border-b"
          data-testid="tool-run-list"
        >
          {items.map((item) => (
            <ToolCard key={item.part.id} part={item.part} projectSlug={projectSlug} sessionId={sessionId} />
          ))}
        </div>
      )}
    </div>
  );
}
