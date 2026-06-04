import { useLayoutEffect, useRef, useState } from "react";
import type { ToolPart, DiffFile } from "@specra/protocol";
import {
  getToolSummary,
  formatToolInputDetails,
  getToolDiffMetadata,
  getToolInvalidInputMessage,
} from "../../lib/tool-format";
import { DiffView } from "../diff/DiffView";

// ─── Status icon config ───

const STATUS_CONFIG: Record<
  ToolPart["state"],
  { icon: string; bgClass: string; textClass: string; animate?: string }
> = {
  pending: { icon: "⏳", bgClass: "bg-warning-muted", textClass: "text-warning" },
  running: { icon: "⟳", bgClass: "bg-info-muted", textClass: "text-info", animate: "animate-spin" },
  completed: { icon: "✓", bgClass: "bg-success-muted", textClass: "text-success" },
  error: { icon: "✗", bgClass: "bg-error-muted", textClass: "text-error" },
};

const STATUS_LABEL: Record<ToolPart["state"], string> = {
  pending: "pending",
  running: "running…",
  completed: "done",
  error: "error",
};

const NAME_CLASS: Record<ToolPart["state"], string> = {
  completed: "text-text-tertiary",
  running: "text-accent",
  pending: "text-text-secondary",
  error: "text-text-secondary",
};

// ─── ToolCard ───

export interface ToolCardProps {
  part: ToolPart;
}

export function ToolCard({ part }: ToolCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [isLong, setIsLong] = useState(false);
  const contentRef = useRef<HTMLPreElement>(null);

  const isUnknownResult = part.state === "error" && (part.meta as Record<string, unknown> | undefined)?.unknownResult === true;
  const config = isUnknownResult
    ? { icon: "⚠", bgClass: "bg-warning-muted", textClass: "text-warning" }
    : STATUS_CONFIG[part.state];
  const nameClass = isUnknownResult ? "text-warning" : NAME_CLASS[part.state];
  const summary = getToolSummary(part.toolName, "input" in part ? part.input : undefined);

  const outputText =
    part.state === "completed"
      ? (part as { output: string }).output
      : part.state === "error"
        ? (part as { errorMessage: string }).errorMessage
        : null;

  const diffMeta =
    part.state === "completed" || part.state === "error"
      ? getToolDiffMetadata((part as { meta?: Record<string, unknown> }).meta?.diffs)
      : undefined;
  const diffFiles: DiffFile[] | undefined = diffMeta?.files;

  const inputDetails =
    "input" in part ? formatToolInputDetails(part.toolName, part.input) : null;

  const invalidMessage =
    "input" in part ? getToolInvalidInputMessage(part.toolName, part.input) : null;

  const statusLabel = isUnknownResult ? "unknown" : STATUS_LABEL[part.state];

  // ─── Long-output detection ───

  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el || !outputText) {
      setIsLong(false);
      setExpanded(false);
      return;
    }
    const style = getComputedStyle(el);
    const parsedLh = parseFloat(style.lineHeight);
    const fontSize = parseFloat(style.fontSize);
    const lh =
      Number.isFinite(parsedLh) && parsedLh > 0
        ? parsedLh
        : Number.isFinite(fontSize) && fontSize > 0
          ? fontSize * 1.625
          : 0;
    if (lh <= 0) {
      setIsLong(false);
      setExpanded(false);
      return;
    }
    const paddingTop = parseFloat(style.paddingTop) || 0;
    const paddingBottom = parseFloat(style.paddingBottom) || 0;
    const threshold = Math.ceil(lh * 5 + paddingTop + paddingBottom);
    const nextIsLong = el.scrollHeight > threshold;
    setIsLong(nextIsLong);
    if (!nextIsLong) setExpanded(false);
  }, [outputText]);

  useLayoutEffect(() => {
    if (expanded || !isLong) return;
    const el = contentRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [expanded, isLong, outputText]);

  // ─── Render ───

  return (
    <div className="bg-bg-overlay border border-border-default rounded-md overflow-hidden my-1.5 shrink-0">
      {/* icon + summary + status */}
      <button
        type="button"
        disabled={!isLong}
        aria-expanded={isLong ? expanded : undefined}
        className={`flex items-center gap-2 px-2.5 py-1.5 select-none transition-colors duration-150 w-full text-left ${
          isLong ? "cursor-pointer hover:bg-bg-hover" : "cursor-default disabled:opacity-100"
        }`}
        onClick={() => {
          if (isLong) setExpanded((v) => !v);
        }}
      >
        <span
          className={`w-[18px] h-[18px] rounded flex items-center justify-center text-[10px] shrink-0 ${config.bgClass} ${config.textClass} ${config.animate ?? ""}`}
          aria-hidden="true"
        >
          {config.icon}
        </span>
        <span className={`text-xs font-medium font-mono ${nameClass}`}>
          <span aria-hidden="true">{summary.icon}</span> {part.toolName}
        </span>
        <span className="text-xs text-text-secondary truncate">{summary.primary}</span>
        {summary.secondary && (
          <span className="text-[11px] text-text-muted truncate hidden sm:inline">{summary.secondary}</span>
        )}
        <span className="ml-auto text-[11px] text-text-muted">{statusLabel}</span>
        {isLong && (
          <span
            className="text-text-muted text-[10px] transition-transform duration-150"
            style={{ transform: expanded ? "rotate(90deg)" : "rotate(0deg)" }}
          >
            ▶
          </span>
        )}
      </button>

      {inputDetails && (
        <div className="border-t border-border-subtle px-2.5 py-1.5">
          <div className="flex flex-col gap-0.5">
            {Object.entries(inputDetails).map(([key, value]) => (
              <div key={key} className="flex gap-1.5 text-[11px]">
                <span className="text-text-muted font-mono shrink-0">{key}:</span>
                <span className="text-text-secondary font-mono break-all">{value}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {invalidMessage && (
        <div className="border-t border-border-subtle px-2.5 py-1.5">
          <span className="text-[11px] text-warning">{invalidMessage}</span>
        </div>
      )}

      {isUnknownResult && (
        <div className="border-t border-border-subtle px-2.5 py-1.5">
          <span className="text-[11px] text-warning">⚠ Result unknown — execution was interrupted before completion</span>
        </div>
      )}

      {diffFiles && diffFiles.length > 0 && (
        <div className="border-t border-border-subtle">
          <DiffView files={diffFiles} defaultExpanded={false} />
        </div>
      )}

      {outputText && (
        <div className="border-t border-border-subtle px-2.5 py-2">
          <pre
            ref={contentRef}
            className={`font-mono text-[11.5px] leading-relaxed bg-bg-elevated p-1.5 rounded-sm border border-border-subtle whitespace-pre-wrap break-all overflow-x-auto ${
              isLong && !expanded ? "overflow-y-auto" : ""
            } ${
              isUnknownResult ? "text-warning" : part.state === "completed" ? "text-success" : part.state === "error" ? "text-error" : "text-text-secondary"
            }`}
            style={isLong && !expanded ? { maxHeight: "calc(8.125em + 0.75rem + 2px)" } : undefined}
          >
            {outputText}
          </pre>
        </div>
      )}
    </div>
  );
}