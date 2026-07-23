import { useState } from "react";
import type {
  ToolAskUserPresentation,
  ToolDiffPresentation,
  ToolPart,
  ToolProcessDetails,
} from "@archcode/protocol";
import { ChevronRight } from "lucide-react";
import {
  formatToolInputDetails,
  getToolInvalidInputMessage,
  getToolSummary,
  summarizeToolDiffMetadata,
} from "../../lib/tool-format";
import { DiffView } from "../diff/DiffView";
import { StatusGlyph } from "../primitives/StatusGlyph";
import { useStatusTransition } from "../primitives/useStatusTransition";
import { ToolOutputViewer } from "./ToolOutputViewer";
import {
  STATUS_SUBTLE_CLASS,
  STATUS_TONE_CLASS,
  statusVisual,
  type VisualStatusKind,
} from "../../lib/status-visuals";

const STATUS_LABEL: Record<ToolPart["state"], string> = {
  pending: "Pending",
  running: "Running",
  completed: "Completed",
  error: "Error",
};

function toolVisualKind(state: ToolPart["state"], unknownResult: boolean): VisualStatusKind {
  if (unknownResult) return "warning";
  if (state === "pending") return "pending";
  if (state === "running") return "loading";
  if (state === "completed") return "completed";
  return "failed";
}

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

  const visualKind = toolVisualKind(part.state, isUnknownResult);
  const statusTransition = useStatusTransition(part.id, visualKind);
  const tone = statusVisual(visualKind).tone;
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
  const ToolIcon = summary.icon;

  return (
    <div className="shrink-0 overflow-hidden rounded-md border border-border-subtle bg-bg-elevated" data-tool-card="">
      <button
        type="button"
        disabled={!hasDetails}
        aria-expanded={hasDetails ? expanded : undefined}
        className={`grid min-h-10 w-full select-none grid-cols-[18px_minmax(0,1fr)_auto_12px] items-center gap-2 px-2.5 py-1.5 text-left transition-colors duration-[var(--motion-hover)] ${
          hasDetails ? "cursor-pointer hover:bg-bg-hover" : "cursor-default disabled:opacity-100"
        }`}
        onClick={() => { if (hasDetails) setExpanded((value) => !value); }}
      >
        <span
          className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-sm ${STATUS_SUBTLE_CLASS[tone]}`}
          data-tool-visual-kind={visualKind}
        >
          <StatusGlyph kind={visualKind} size={11} transition={statusTransition} />
        </span>
        <span className="flex min-w-0 items-baseline gap-2 overflow-hidden">
          <span className={`shrink-0 whitespace-nowrap font-mono text-[12px] font-medium ${isUnknownResult ? "text-warning" : "text-text-secondary"}`}>
            {ToolIcon ? <ToolIcon size={12} className="mr-1 inline-block align-text-bottom" /> : null}{part.toolName}
          </span>
          <span className="truncate text-[10px] text-text-secondary">{summary.primary}</span>
          {summary.secondary && <span className="truncate text-[9px] text-text-tertiary max-[560px]:hidden">{summary.secondary}</span>}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {diffSummary && (
            <span className="whitespace-nowrap font-mono text-[9px] tabular-nums text-text-tertiary max-[560px]:hidden">
              {diffSummary.fileCount} {diffSummary.fileCount === 1 ? "file" : "files"}
              {diffSummary.additions !== undefined && diffSummary.deletions !== undefined
                ? ` · +${diffSummary.additions} −${diffSummary.deletions}`
                : null}
            </span>
          )}
          <span className={`text-[9px] font-semibold ${part.state === "running" ? "text-signal-foreground" : STATUS_TONE_CLASS[tone]}`}>
            {isUnknownResult ? "Unknown" : STATUS_LABEL[part.state]}
          </span>
        </span>
        {hasDetails && <ChevronRight size={10} className={`text-text-muted transition-transform duration-[var(--motion-icon)] ${expanded ? "rotate-90" : ""}`} aria-hidden="true" />}
      </button>

      {expanded && inputDetails && askPresentation === undefined && (
        <KeyValueRows entries={inputDetails} />
      )}

      {expanded && invalidMessage && (
        <div className="border-t border-border-subtle px-3 py-2 text-[11px] text-warning">{invalidMessage}</div>
      )}

      {expanded && isUnknownResult && (
        <div className="inline-flex w-full items-center gap-1 border-t border-border-subtle px-3 py-2 text-[11px] text-warning">
          <StatusGlyph kind="warning" size={11} /> Result unknown — execution was interrupted before completion
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
        <div className="border-t border-border-subtle px-3 py-2">
          <button
            type="button"
            data-testid="tool-output-open"
            className="h-8 rounded-sm bg-brand-subtle px-3 text-[12px] font-medium text-brand transition-colors duration-[var(--motion-hover)] hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
            onClick={() => setViewerOpen((value) => !value)}
          >
            {viewerOpen ? "关闭输出" : "查看输出"}
          </button>
          <span className="ml-2 text-[11px] text-text-tertiary">expires {new Date(artifactRecovery.expiresAt).toLocaleString()}</span>
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
    <div className="border-t border-border-subtle px-3 py-2">
      <div className="flex flex-col gap-1">
        {Object.entries(entries).map(([key, value]) => (
          <div key={key} className="flex gap-2 text-[11px]">
            <span className="shrink-0 font-mono text-text-tertiary">{key}:</span>
            <span className="text-text-secondary font-mono break-all">{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function AskUserResult({ presentation }: { presentation: ToolAskUserPresentation }) {
  return (
    <div className="border-t border-border-subtle px-3 py-2" data-testid="ask-user-result">
      <div className="flex flex-col gap-2">
        {presentation.answers.map((exchange, index) => (
          <div key={`${exchange.question}-${index}`} className="rounded-sm border border-border-subtle bg-bg-elevated px-3 py-2">
            <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1 text-[12px] leading-4">
              <span className="text-text-tertiary">Question</span>
              <span className="text-text-primary break-words">{exchange.question}</span>
              <span className="text-text-tertiary">Answer</span>
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
    <div className="border-t border-border-subtle px-3 py-2">
      <div className="mb-2 flex flex-wrap gap-2 text-[11px] text-text-tertiary">
        <span>{output.completeness}</span>
        <span>observed {formatCount(output.observed)}</span>
        <span>canonical {formatCount(output.canonical)}</span>
        <span>stored {formatCount(output.stored)}</span>
        {(output.omitted.bytes > 0 || output.omitted.lines > 0) && <span>omitted {formatCount(output.omitted)}</span>}
      </div>
      {output.preview.length > 0 && (
        <pre className={`font-mono text-[12px] leading-[18px] bg-bg-elevated p-2 rounded-sm border border-border-subtle whitespace-pre-wrap break-all overflow-x-auto ${
          partState === "completed" ? "text-success" : "text-error"
        }`}>{output.preview}</pre>
      )}
    </div>
  );
}

function formatCount(count: { readonly bytes: number; readonly lines: number }): string {
  return `${count.bytes.toLocaleString()} B / ${count.lines.toLocaleString()} lines`;
}
