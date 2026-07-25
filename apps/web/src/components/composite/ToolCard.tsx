import { useState } from "react";
import type {
  ToolAskUserPresentation,
  ToolDiffPresentation,
  ToolPart,
  ToolProcessDetails,
} from "@archcode/protocol";
import { ChevronRight } from "lucide-react";
import {
  getToolSummary,
  summarizeToolDiffMetadata,
} from "../../lib/tool-format";
import { getToolCategory } from "@archcode/protocol";
import { DiffView } from "../diff/DiffView";
import { ToolOutputViewer } from "./ToolOutputViewer";

const STATUS_LABEL: Record<ToolPart["state"], string> = {
  pending: "Pending",
  running: "Running",
  completed: "Completed",
  error: "Error",
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

  const hasInput = "input" in part;
  const category = getToolCategory(part.toolName);
  const isShell = category === "shell";
  const summary = getToolSummary(part.toolName, hasInput ? part.input : undefined);
  const shellCommand = isShell && hasInput ? getShellCommand(part.input) : undefined;
  const summaryPrimary = shellCommand ?? summary.primary;
  const diffSummary = diffPresentation
    ? summarizeToolDiffMetadata({ files: diffPresentation.files, truncated: diffPresentation.truncated })
    : undefined;
  const hasDetails = diffPresentation !== undefined
    || askPresentation !== undefined
    || isUnknownResult
    || details?.error !== undefined
    || artifactRecovery !== undefined
    || (isShell && settled !== undefined)
    || (!isShell && part.state === "error" && (settled?.output.preview.length ?? 0) > 0);
  const statusLabel = isUnknownResult ? "Unknown" : STATUS_LABEL[part.state];
  const statusClass = part.state === "running"
    ? "text-signal-foreground"
    : part.state === "error"
      ? "text-error"
      : isUnknownResult
        ? "text-warning"
        : "text-text-tertiary";
  const detailsId = `${part.id}-details`;
  const summaryClass = "tool-card-summary-control grid min-h-9 w-full select-none grid-cols-[12px_minmax(0,160px)_minmax(0,1fr)_auto] items-center gap-2 rounded-md border-0 bg-transparent py-1 pl-0 pr-1.5 text-left max-[560px]:grid-cols-[12px_minmax(0,112px)_minmax(0,1fr)_auto]";
  const summaryContent = (
    <>
      {hasDetails
        ? <ChevronRight size={10} className={`text-text-muted transition-transform duration-[var(--motion-icon)] ${expanded ? "rotate-90" : ""}`} aria-hidden="true" />
        : <span aria-hidden="true" />}
      <span
        className={`min-w-0 truncate font-mono text-[12px] font-semibold ${isUnknownResult ? "text-warning" : "text-text-tertiary"}`}
        title={part.toolName}
      >
        {part.toolName}
      </span>
      <span
        className={`min-w-0 truncate text-[13px] font-medium ${isShell ? "font-mono text-text-secondary" : "text-text-primary"}`}
        title={summaryPrimary}
      >
        {summaryPrimary}
      </span>
      <span className="flex shrink-0 items-center gap-2">
        {diffSummary && (
          <span className="whitespace-nowrap font-mono text-[11px] tabular-nums text-text-tertiary max-[560px]:hidden">
            {diffSummary.fileCount} {diffSummary.fileCount === 1 ? "file" : "files"}
            {diffSummary.additions !== undefined && diffSummary.deletions !== undefined
              ? ` · +${diffSummary.additions} −${diffSummary.deletions}`
              : null}
          </span>
        )}
        {(part.state !== "completed" || isUnknownResult) && (
          <span className={`text-[10px] font-semibold ${statusClass}`}>{statusLabel}</span>
        )}
      </span>
    </>
  );

  return (
    <div className="w-full min-w-0 shrink-0 overflow-hidden" data-tool-card="">
      {hasDetails ? (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={detailsId}
          className={`${summaryClass} cursor-pointer transition-colors duration-[var(--motion-hover)] hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand`}
          onClick={() => setExpanded((value) => !value)}
        >
          {summaryContent}
        </button>
      ) : (
        <div
          className={`${summaryClass} cursor-default`}
          data-tool-summary-static=""
          aria-label={`${part.toolName}, ${summaryPrimary}, ${statusLabel}`}
        >
          {summaryContent}
        </div>
      )}

      {expanded && hasDetails && (
        <div id={detailsId}>
          {isUnknownResult && (
            <div className="ml-[18px] w-[calc(100%-18px)] border-l-2 border-warning px-3 py-2 text-[12px] text-warning">
              Result unknown — execution was interrupted before completion
            </div>
          )}

          {diffPresentation && diffPresentation.files.length > 0 && (
            <div className="ml-[18px] overflow-hidden rounded-md border border-border-subtle bg-bg-elevated">
              <DiffView files={diffPresentation.files} defaultExpanded />
            </div>
          )}

          {askPresentation && <AskUserResult presentation={askPresentation} />}

          {details?.error && (
            <KeyValueRows entries={{
              error: details.error.kind,
              code: details.error.code,
              name: details.error.name,
              ...(details.error.hint ? { hint: details.error.hint } : {}),
            }} />
          )}

          {!isShell && part.state === "error" && settled?.output.preview && (
            <ToolErrorOutput preview={settled.output.preview} />
          )}

          {isShell && settled && (
            <ShellOutput output={settled.output} process={details?.process} />
          )}

          {artifactRecovery && (
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

          {viewerOpen && artifactRecovery && (
            <ToolOutputViewer projectSlug={projectSlug} sessionId={sessionId} outputRef={artifactRecovery.outputRef} />
          )}
        </div>
      )}
    </div>
  );
}

function getShellCommand(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const command = (input as Record<string, unknown>).command;
  return typeof command === "string" && command.length > 0 ? command : undefined;
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

function ToolErrorOutput({ preview }: { preview: string }) {
  return (
    <pre className="ml-[18px] overflow-x-auto whitespace-pre-wrap break-all border-l-2 border-error px-3 py-2 font-mono text-[12px] leading-[1.6] text-error">
      {preview}
    </pre>
  );
}

function ShellOutput({ output, process }: {
  output: Extract<ToolPart, { state: "completed" | "error" }>["result"]["output"];
  process?: ToolProcessDetails;
}) {
  return (
    <div className="ml-[18px] mt-0.5 overflow-hidden rounded-md bg-[var(--terminal-bg)] text-[var(--terminal-text)]">
      {output.preview.length > 0 && (
        <pre className="overflow-x-auto whitespace-pre-wrap break-all px-3 py-2.5 font-mono text-[12px] leading-[1.65]">
          {output.preview}
        </pre>
      )}
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-[var(--terminal-border)] px-3 py-1.5 font-mono text-[11px] text-[var(--terminal-muted)]">
        <span className={process?.exitCode === 0 ? "text-[var(--terminal-success)]" : process?.exitCode == null ? "" : "text-[var(--terminal-error)]"}>
          exit {process?.exitCode ?? "—"}
        </span>
        <span>
          {process ? `${process.durationMs} ms` : output.completeness}
          {(output.omitted.bytes > 0 || output.omitted.lines > 0)
            ? ` · ${formatCount(output.omitted)} omitted`
            : ""}
        </span>
      </div>
    </div>
  );
}

function formatCount(count: { readonly bytes: number; readonly lines: number }): string {
  return `${count.bytes.toLocaleString()} B / ${count.lines.toLocaleString()} lines`;
}
