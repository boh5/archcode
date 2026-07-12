import { useLayoutEffect, useRef, useState } from "react";
import type { ToolPart, DiffFile } from "@archcode/protocol";
import { TOOL_ASK_USER } from "@archcode/protocol";
import {
  Clock,
  LoaderCircle,
  Check,
  X,
  TriangleAlert,
  ChevronRight,
  type LucideIcon,
} from "lucide-react";
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

// ─── ToolCard ───

export interface ToolCardProps {
  part: ToolPart;
}

interface AskUserExchange {
  header: string;
  question: string;
  answer: string;
}

function getAskUserExchanges(part: ToolPart, outputText: string | null): AskUserExchange[] | undefined {
  if (part.toolName !== TOOL_ASK_USER || part.state !== "completed" || !("input" in part)) return undefined;
  if (!part.input || typeof part.input !== "object" || Array.isArray(part.input)) return undefined;
  const questions = (part.input as Record<string, unknown>).questions;
  if (!Array.isArray(questions) || questions.length === 0) return undefined;

  const metadata = part.meta?.askUser;
  const structuredAnswers = metadata !== null && typeof metadata === "object"
    && (metadata as Record<string, unknown>).version === 1
    && Array.isArray((metadata as Record<string, unknown>).answers)
    ? (metadata as { answers: unknown[] }).answers
    : undefined;

  return questions.flatMap((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const question = value as Record<string, unknown>;
    if (typeof question.question !== "string") return [];
    const answerValue = structuredAnswers?.[index];
    const answer = Array.isArray(answerValue) && answerValue.every((item) => typeof item === "string")
      ? answerValue.join(", ")
      : questions.length === 1 && outputText !== null ? outputText : "";
    if (answer.length === 0) return [];
    return [{
      header: typeof question.header === "string" ? question.header : `Q${index + 1}`,
      question: question.question,
      answer,
    }];
  });
}

function AskUserResult({ exchanges }: { exchanges: AskUserExchange[] }) {
  return (
    <div className="border-t border-border-subtle px-2.5 py-2" data-testid="ask-user-result">
      <div className="flex flex-col gap-2">
        {exchanges.map((exchange, index) => (
          <div key={`${exchange.header}-${index}`} className="rounded-sm border border-border-subtle bg-bg-elevated px-2.5 py-2">
            <div className="text-[10.5px] font-medium uppercase tracking-wide text-text-muted mb-1">
              {exchange.header}
            </div>
            <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1 text-[12px] leading-relaxed">
              <span className="text-text-muted">Question</span>
              <span className="text-text-primary break-words">{exchange.question}</span>
              <span className="text-text-muted">Answer</span>
              <span className="text-success break-words">{exchange.answer}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ToolCard({ part }: ToolCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [isLong, setIsLong] = useState(false);
  const contentRef = useRef<HTMLPreElement>(null);

  const isUnknownResult = part.state === "error" && (part.meta as Record<string, unknown> | undefined)?.unknownResult === true;
  const config = isUnknownResult
    ? { icon: TriangleAlert, bgClass: "bg-warning-muted", textClass: "text-warning" }
    : STATUS_CONFIG[part.state];
  const nameClass = isUnknownResult ? "text-warning" : NAME_CLASS[part.state];
  const summary = getToolSummary(part.toolName, "input" in part ? part.input : undefined);

  const outputText =
    part.state === "completed"
      ? (part as { output: string }).output
      : part.state === "error"
        ? (part as { errorMessage: string }).errorMessage
        : null;
  const askUserExchanges = getAskUserExchanges(part, outputText);

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
  const StatusIcon = config.icon;
  const ToolIcon = summary.icon;

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
          className={`w-[18px] h-[18px] rounded flex items-center justify-center shrink-0 ${config.bgClass} ${config.textClass} ${config.animate ?? ""}`}
          aria-hidden="true"
        >
          <StatusIcon size={10} />
        </span>
        <span className={`text-xs font-medium font-mono shrink-0 whitespace-nowrap ${nameClass}`}>
          {ToolIcon ? <ToolIcon size={12} className="inline-block align-text-bottom mr-0.5" /> : null}{part.toolName}
        </span>
        <span className="text-xs text-text-secondary truncate">{summary.primary}</span>
        {summary.secondary && (
          <span className="text-[11px] text-text-muted truncate hidden sm:inline">{summary.secondary}</span>
        )}
        <span className="ml-auto text-[11px] text-text-muted">{statusLabel}</span>
        {isLong && (
          <ChevronRight
            size={10}
            className={`text-text-muted transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}
            aria-hidden="true"
          />
        )}
      </button>

      {inputDetails && askUserExchanges === undefined && (
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
          <span className="text-[11px] text-warning inline-flex items-center gap-1">
            <TriangleAlert size={11} className="inline" aria-hidden="true" />
            Result unknown — execution was interrupted before completion
          </span>
        </div>
      )}

      {diffFiles && diffFiles.length > 0 && (
        <div className="border-t border-border-subtle">
          <DiffView files={diffFiles} defaultExpanded={false} />
        </div>
      )}

      {askUserExchanges !== undefined && askUserExchanges.length > 0 && (
        <AskUserResult exchanges={askUserExchanges} />
      )}

      {outputText && askUserExchanges === undefined && (
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
