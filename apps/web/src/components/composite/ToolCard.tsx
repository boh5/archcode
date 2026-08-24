import { useEffect, useRef, useState } from "react";
import {
  getToolCategory,
  TOOL_ASK_USER,
  type ToolAskUserPresentation,
  type ToolDiffPresentation,
  type ToolPart,
  type ToolProcessDetails,
} from "@archcode/protocol";
import { ChevronRight } from "lucide-react";
import {
  getToolSummary,
  summarizeToolDiffMetadata,
} from "../../lib/tool-format";
import { DiffView } from "../diff/DiffView";
import {
  WORK_ACTIVITY_CHILD_LANE_CLASS,
  WORK_ACTIVITY_NESTED_LANE_CLASS,
} from "../primitives/ConversationRail";
import { ToolOutputViewer } from "./ToolOutputViewer";

const STATUS_LABEL: Record<ToolPart["state"], string> = {
  pending: "Pending",
  running: "Running",
  interrupted: "Interrupted",
  completed: "Completed",
  error: "Error",
};

function summarizeAskUserPresentation(
  presentation: ToolAskUserPresentation,
): string | undefined {
  if (presentation.truncated) return "Answer recorded · details truncated";
  if (presentation.answers.length > 1) {
    return `${presentation.answers.length} questions answered`;
  }
  const answerGroup = presentation.answers[0];
  if (answerGroup === undefined || answerGroup.answers.length === 0) return undefined;
  return `Question answered · ${answerGroup.answers.join(", ")}`;
}

export interface ToolCardProps {
  readonly part: ToolPart;
  readonly projectSlug: string;
  /** The current root/focus Session id used by the artifact authorization boundary. */
  readonly sessionId: string;
  /** Adds a compact divider when this summary participates in a grouped Tool Run. */
  readonly grouped?: boolean;
}

export function ToolCard({ part, projectSlug, sessionId, grouped = false }: ToolCardProps) {
  const liveOutput = part.state === "running" ? part.liveOutput : undefined;
  const [expanded, setExpanded] = useState(liveOutput !== undefined);
  const manuallyCollapsed = useRef(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  useEffect(() => {
    if (liveOutput !== undefined && !manuallyCollapsed.current) setExpanded(true);
  }, [liveOutput]);

  const settled = part.state === "completed" || part.state === "error" ? part.result : undefined;
  const details = settled?.details;
  const isUnknownResult = details?.unknownResult === true;
  const diffPresentation = details?.presentations?.find(
    (presentation): presentation is ToolDiffPresentation => presentation.kind === "diff",
  );
  const askPresentation = details?.presentations?.find(
    (presentation): presentation is ToolAskUserPresentation => presentation.kind === "ask_user",
  );
  const askSummary = part.toolName === TOOL_ASK_USER
    && part.state === "completed"
    && settled?.isError === false
    && askPresentation
    ? summarizeAskUserPresentation(askPresentation)
    : undefined;
  const recovery = settled?.output.recovery;
  const artifactRecovery = recovery?.kind === "artifact" ? recovery : undefined;

  const hasInput = "input" in part;
  const category = getToolCategory(part.toolName);
  const isShell = category === "shell";
  const summary = getToolSummary(part.toolName, hasInput ? part.input : undefined);
  const shellCommand = isShell && hasInput ? getShellCommand(part.input) : undefined;
  const summaryPrimary = shellCommand ?? summary.primary;
  const diffSummary = diffPresentation
    ? summarizeToolDiffMetadata({
        files: diffPresentation.files,
        simplified: diffPresentation.simplified,
        truncated: diffPresentation.truncated,
      })
    : undefined;
  const hasDetails = diffPresentation !== undefined
    || askPresentation !== undefined
    || isUnknownResult
    || details?.error !== undefined
    || artifactRecovery !== undefined
    || liveOutput !== undefined
    || (isShell && settled !== undefined)
    || (!isShell && part.state === "error" && (settled?.output.preview.length ?? 0) > 0);
  const statusLabel = isUnknownResult ? "Unknown" : STATUS_LABEL[part.state];
  const statusClass = part.state === "running"
    ? "text-signal-foreground"
    : part.state === "interrupted"
      ? "text-warning"
      : part.state === "error"
        ? "text-error"
        : isUnknownResult
          ? "text-warning"
          : "text-text-tertiary";
  const detailsId = `${part.id}-details`;
  const summaryBorderClass = grouped
    ? "border-x-0 border-t-0 border-b border-border-subtle"
    : "border-0";
  const summaryLaneClass = grouped
    ? WORK_ACTIVITY_NESTED_LANE_CLASS
    : WORK_ACTIVITY_CHILD_LANE_CLASS;
  const summaryClass = `tool-card-summary-control grid min-h-9 select-none grid-cols-[14px_minmax(98px,160px)_minmax(0,1fr)_auto] items-center gap-[9px] rounded-[5px] bg-transparent px-[9px] py-[7px] text-left [@media(max-width:560px)]:grid-cols-[14px_minmax(90px,112px)_minmax(0,1fr)_auto] [@media(pointer:coarse)]:min-h-11 ${summaryBorderClass} ${summaryLaneClass}`;
  const summaryContent = askSummary ? (
    <>
      <ChevronRight size={10} className={`text-text-muted transition-transform duration-[var(--motion-fast)] ${expanded ? "rotate-90" : ""}`} aria-hidden="true" />
      <strong
        className="col-span-2 min-w-0 truncate text-[12.5px] font-semibold text-text-secondary"
        title={askSummary}
        data-testid="ask-user-summary"
      >
        {askSummary}
      </strong>
      {diffSummary ? (
        <span className="shrink-0 whitespace-nowrap font-mono text-[11px] tabular-nums text-text-tertiary [@media(max-width:560px)]:hidden">
          {diffSummary.fileCount} {diffSummary.fileCount === 1 ? "file" : "files"}
          {diffSummary.additions !== undefined && diffSummary.deletions !== undefined
            ? ` · +${diffSummary.additions} −${diffSummary.deletions}`
            : null}
        </span>
      ) : <span className="h-px min-w-6 bg-border-subtle" aria-hidden="true" />}
    </>
  ) : (
    <>
      {hasDetails
        ? <ChevronRight size={10} className={`text-text-muted transition-transform duration-[var(--motion-fast)] ${expanded ? "rotate-90" : ""}`} aria-hidden="true" />
        : <span aria-hidden="true" />}
      <span
        className={`min-w-0 truncate font-mono text-[12px] font-semibold ${isUnknownResult ? "text-warning" : "text-text-tertiary"}`}
        title={part.toolName}
      >
        {part.toolName}
      </span>
      <span
        className={`min-w-0 truncate text-[12.5px] font-medium text-text-secondary ${isShell ? "font-mono" : ""}`}
        title={summaryPrimary}
      >
        {summaryPrimary}
      </span>
      <span className="flex shrink-0 items-center gap-2">
        {diffSummary && (
          <span className="whitespace-nowrap font-mono text-[11px] tabular-nums text-text-tertiary [@media(max-width:560px)]:hidden">
            {diffSummary.fileCount} {diffSummary.fileCount === 1 ? "file" : "files"}
            {diffSummary.additions !== undefined && diffSummary.deletions !== undefined
              ? ` · +${diffSummary.additions} −${diffSummary.deletions}`
              : null}
          </span>
        )}
        {(part.state !== "completed" || isUnknownResult) && (
          <span className={`text-[11px] font-semibold ${statusClass}`}>{statusLabel}</span>
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
          className={`${summaryClass} cursor-pointer transition-[background-color,transform] duration-[var(--motion-fast)] hover:translate-x-0.5 hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand`}
          onClick={() => setExpanded((value) => {
            const next = !value;
            if (!next) manuallyCollapsed.current = true;
            return next;
          })}
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
        <div id={detailsId} className="w-full min-w-0" data-tool-detail-surface="">
          {isUnknownResult && (
            <div className="ml-[18px] w-[calc(100%-18px)] border-l-2 border-warning px-3 py-2 text-[12px] text-warning">
              Result unknown — execution was interrupted before completion
            </div>
          )}

          {diffPresentation && diffPresentation.files.length > 0 && (
            <div className="ml-[18px] overflow-hidden rounded-md border border-border-subtle bg-bg-elevated">
              {(diffPresentation.simplified || diffPresentation.truncated) && (
                <div
                  className="border-b border-border-subtle px-3 py-2 text-[11px] text-warning"
                  data-testid="tool-diff-disclosure"
                >
                  {diffPresentation.simplified && diffPresentation.truncated
                    ? "Large change — showing a simplified, truncated diff."
                    : diffPresentation.simplified
                      ? "Large change — showing a simplified diff."
                      : "Large change — diff output was truncated."}
                </div>
              )}
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

          {isShell && liveOutput && (
            <LiveShellOutput liveOutput={liveOutput} />
          )}

          {isShell && settled && (
            <ShellOutput output={settled.output} process={details?.process} />
          )}

          {artifactRecovery && (
            <div className="border-t border-border-subtle px-3 py-2">
              <button
                type="button"
                data-testid="tool-output-open"
                className="h-8 rounded-sm bg-brand-subtle px-3 text-[12px] font-medium text-brand transition-colors duration-[var(--motion-fast)] hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                onClick={() => setViewerOpen((value) => !value)}
              >
                {viewerOpen ? "Hide output" : "View output"}
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

function LiveShellOutput({
  liveOutput,
}: {
  liveOutput: NonNullable<Extract<ToolPart, { state: "running" }>["liveOutput"]>;
}) {
  return (
    <div
      className="ml-[18px] mt-0.5 overflow-hidden rounded-md bg-[var(--terminal-bg)] text-[var(--terminal-text)]"
      data-testid="tool-live-output"
    >
      {liveOutput.preview.length > 0 && (
        <pre className="overflow-x-auto whitespace-pre-wrap break-all px-3 py-2.5 font-mono text-[12px] leading-[1.65]">
          {liveOutput.preview}
        </pre>
      )}
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-[var(--terminal-border)] px-3 py-1.5 font-mono text-[11px] text-[var(--terminal-muted)]">
        <span className="text-[var(--terminal-success)]">Live</span>
        <span>
          {liveOutput.omittedBytes > 0
            ? `${liveOutput.omittedBytes.toLocaleString()} B earlier output omitted`
            : "collecting output"}
        </span>
      </div>
      {liveOutput.liveLimitReached && (
        <div className="border-t border-[var(--terminal-border)] px-3 py-2 font-mono text-[11px] text-warning">
          Live preview paused at its safety limit. Final output is still being collected.
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
      <dl className="flex flex-col">
        {presentation.answers.map((exchange, index) => (
          <div key={`${exchange.question}-${index}`} className="grid grid-cols-[minmax(92px,34%)_minmax(0,1fr)] gap-x-3 border-b border-border-subtle px-1 py-2 last:border-b-0">
            <dt className="break-words text-[11.5px] leading-[1.45] text-text-tertiary">{exchange.question}</dt>
            <dd className="break-words text-right text-[11.5px] font-medium leading-[1.45] text-text-primary">{exchange.answers.join(", ")}</dd>
          </div>
        ))}
      </dl>
      {presentation.truncated && (
        <p className="mt-2 border-t border-border-subtle px-1 pt-2 text-[11px] leading-4 text-warning" data-testid="ask-user-truncation">
          Additional finalized details are not available in this bounded Web projection.
        </p>
      )}
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
