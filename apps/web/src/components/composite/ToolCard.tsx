import { useState } from "react";
import type {
  ToolAskUserPresentation,
  ToolDiffPresentation,
  ToolPart,
  ToolProcessDetails,
} from "@archcode/protocol";
import {
  Check,
  ChevronRight,
  Clock,
  LoaderCircle,
  TriangleAlert,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  formatToolInputDetails,
  getToolInvalidInputMessage,
  getToolSummary,
  summarizeToolDiffMetadata,
} from "../../lib/tool-format";
import { DiffView } from "../diff/DiffView";
import { ToolOutputViewer } from "./ToolOutputViewer";

const STATUS_CONFIG: Record<
  ToolPart["state"],
  { icon: LucideIcon; bgClass: string; textClass: string; animate?: string }
> = {
  pending: { icon: Clock, bgClass: "bg-warning-muted", textClass: "text-warning" },
  running: { icon: LoaderCircle, bgClass: "bg-info-muted", textClass: "text-info", animate: "animate-spin" },
  completed: { icon: Check, bgClass: "bg-success-muted", textClass: "text-success" },
  error: { icon: X, bgClass: "bg-error-muted", textClass: "text-error" },
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

export interface ToolCardProps {
  readonly part: ToolPart;
  readonly projectSlug: string;
  /** The current root/focus Session id used by the artifact authorization boundary. */
  readonly sessionId: string;
}

export function ToolCard({ part, projectSlug, sessionId }: ToolCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const settled = part.state === "completed" || part.state === "error" ? part.result : undefined;
  const details = settled?.details;
  const isUnknownResult = details?.unknownResult === true;
  const diffPresentation = details?.presentations?.find(
    (presentation): presentation is ToolDiffPresentation => presentation.kind === "diff",
  );
  const askPresentation = details?.presentations?.find(
    (presentation): presentation is ToolAskUserPresentation => presentation.kind === "ask_user",
  );
  const recovery = settled?.output.recovery;
  const artifactRecovery = recovery?.kind === "artifact" ? recovery : undefined;

  const config = isUnknownResult
    ? { icon: TriangleAlert, bgClass: "bg-warning-muted", textClass: "text-warning" }
    : STATUS_CONFIG[part.state];
  const nameClass = isUnknownResult ? "text-warning" : NAME_CLASS[part.state];
  const summary = getToolSummary(part.toolName, "input" in part ? part.input : undefined);
  const inputDetails = "input" in part ? formatToolInputDetails(part.toolName, part.input) : null;
  const invalidMessage = "input" in part ? getToolInvalidInputMessage(part.toolName, part.input) : null;
  const diffSummary = diffPresentation
    ? summarizeToolDiffMetadata({ files: diffPresentation.files, truncated: diffPresentation.truncated })
    : undefined;
  const hasDetails = inputDetails !== null
    || invalidMessage !== null
    || settled !== undefined
    || diffPresentation !== undefined
    || askPresentation !== undefined;
  const StatusIcon = config.icon;
  const ToolIcon = summary.icon;

  return (
    <div className="bg-bg-overlay border border-border-default rounded-md overflow-hidden shrink-0">
      <button
        type="button"
        disabled={!hasDetails}
        aria-expanded={hasDetails ? expanded : undefined}
        className={`flex items-center gap-2 px-2.5 py-1.5 select-none transition-colors duration-150 w-full text-left ${
          hasDetails ? "cursor-pointer hover:bg-bg-hover" : "cursor-default disabled:opacity-100"
        }`}
        onClick={() => { if (hasDetails) setExpanded((value) => !value); }}
      >
        <span className={`w-[18px] h-[18px] rounded flex items-center justify-center shrink-0 ${config.bgClass} ${config.textClass} ${config.animate ?? ""}`} aria-hidden="true">
          <StatusIcon size={10} />
        </span>
        <span className={`text-xs font-medium font-mono shrink-0 whitespace-nowrap ${nameClass}`}>
          {ToolIcon ? <ToolIcon size={12} className="inline-block align-text-bottom mr-0.5" /> : null}{part.toolName}
        </span>
        <span className="text-xs text-text-secondary truncate">{summary.primary}</span>
        {summary.secondary && <span className="text-[11px] text-text-muted truncate hidden sm:inline">{summary.secondary}</span>}
        {diffSummary && (
          <span className="text-[11px] text-text-muted whitespace-nowrap">
            {diffSummary.fileCount} {diffSummary.fileCount === 1 ? "file" : "files"}
            {diffSummary.additions !== undefined && diffSummary.deletions !== undefined
              ? ` · +${diffSummary.additions} −${diffSummary.deletions}`
              : null}
          </span>
        )}
        <span className="ml-auto text-[11px] text-text-muted">{isUnknownResult ? "unknown" : STATUS_LABEL[part.state]}</span>
        {hasDetails && <ChevronRight size={10} className={`text-text-muted transition-transform duration-150 ${expanded ? "rotate-90" : ""}`} aria-hidden="true" />}
      </button>

      {expanded && inputDetails && askPresentation === undefined && (
        <KeyValueRows entries={inputDetails} />
      )}

      {expanded && invalidMessage && (
        <div className="border-t border-border-subtle px-2.5 py-1.5 text-[11px] text-warning">{invalidMessage}</div>
      )}

      {expanded && isUnknownResult && (
        <div className="border-t border-border-subtle px-2.5 py-1.5 text-[11px] text-warning inline-flex items-center gap-1 w-full">
          <TriangleAlert size={11} aria-hidden="true" /> Result unknown — execution was interrupted before completion
        </div>
      )}

      {expanded && diffPresentation && diffPresentation.files.length > 0 && (
        <div className="border-t border-border-subtle"><DiffView files={diffPresentation.files} defaultExpanded={false} /></div>
      )}

      {expanded && askPresentation && <AskUserResult presentation={askPresentation} />}

      {expanded && details?.error && (
        <KeyValueRows entries={{
          error: details.error.kind,
          code: details.error.code,
          name: details.error.name,
          ...(details.error.hint ? { hint: details.error.hint } : {}),
        }} />
      )}

      {expanded && details?.process && <ProcessDetails details={details.process} />}

      {expanded && settled && askPresentation === undefined && (
        <ToolOutputSummary partState={settled.isError ? "error" : "completed"} output={settled.output} />
      )}

      {expanded && artifactRecovery && (
        <div className="border-t border-border-subtle px-2.5 py-2">
          <button
            type="button"
            data-testid="tool-output-open"
            className="rounded-sm bg-accent-subtle px-2 py-1 text-[11px] font-medium text-accent hover:bg-accent-muted"
            onClick={() => setViewerOpen((value) => !value)}
          >
            {viewerOpen ? "关闭输出" : "查看输出"}
          </button>
          <span className="ml-2 text-[10.5px] text-text-muted">expires {new Date(artifactRecovery.expiresAt).toLocaleString()}</span>
        </div>
      )}

      {expanded && viewerOpen && artifactRecovery && (
        <ToolOutputViewer projectSlug={projectSlug} sessionId={sessionId} outputRef={artifactRecovery.outputRef} />
      )}
    </div>
  );
}

function KeyValueRows({ entries }: { entries: Record<string, string> }) {
  return (
    <div className="border-t border-border-subtle px-2.5 py-1.5">
      <div className="flex flex-col gap-0.5">
        {Object.entries(entries).map(([key, value]) => (
          <div key={key} className="flex gap-1.5 text-[11px]">
            <span className="text-text-muted font-mono shrink-0">{key}:</span>
            <span className="text-text-secondary font-mono break-all">{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function AskUserResult({ presentation }: { presentation: ToolAskUserPresentation }) {
  return (
    <div className="border-t border-border-subtle px-2.5 py-2" data-testid="ask-user-result">
      <div className="flex flex-col gap-2">
        {presentation.answers.map((exchange, index) => (
          <div key={`${exchange.question}-${index}`} className="rounded-sm border border-border-subtle bg-bg-elevated px-2.5 py-2">
            <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1 text-[12px] leading-relaxed">
              <span className="text-text-muted">Question</span>
              <span className="text-text-primary break-words">{exchange.question}</span>
              <span className="text-text-muted">Answer</span>
              <span className="text-success break-words">{exchange.answers.join(", ")}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ProcessDetails({ details }: { details: ToolProcessDetails }) {
  const rows = {
    exit: details.exitCode === null ? "—" : String(details.exitCode),
    signal: details.signal ?? "—",
    duration: `${details.durationMs} ms`,
    timedOut: String(details.timedOut),
    aborted: String(details.aborted),
  };
  return <KeyValueRows entries={rows} />;
}

function ToolOutputSummary({ partState, output }: {
  partState: "completed" | "error";
  output: Extract<ToolPart, { state: "completed" | "error" }>["result"]["output"];
}) {
  return (
    <div className="border-t border-border-subtle px-2.5 py-2">
      <div className="mb-1.5 flex flex-wrap gap-1.5 text-[10.5px] text-text-muted">
        <span>{output.completeness}</span>
        <span>observed {formatCount(output.observed)}</span>
        <span>canonical {formatCount(output.canonical)}</span>
        <span>stored {formatCount(output.stored)}</span>
        {(output.omitted.bytes > 0 || output.omitted.lines > 0) && <span>omitted {formatCount(output.omitted)}</span>}
      </div>
      {output.preview.length > 0 && (
        <pre className={`font-mono text-[11.5px] leading-relaxed bg-bg-elevated p-1.5 rounded-sm border border-border-subtle whitespace-pre-wrap break-all overflow-x-auto ${
          partState === "completed" ? "text-success" : "text-error"
        }`}>{output.preview}</pre>
      )}
    </div>
  );
}

function formatCount(count: { readonly bytes: number; readonly lines: number }): string {
  return `${count.bytes.toLocaleString()} B / ${count.lines.toLocaleString()} lines`;
}
