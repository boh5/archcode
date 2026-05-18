import { useState, useCallback } from "react";
import { useAttentionQueue } from "../../hooks/use-attention-queue";
import type { PermissionRequest, QuestionRequest, PermissionDecision } from "../../api/types";

// ─── Agent badge colors ───

const AGENT_TYPES = [
  "orchestrator",
  "product",
  "spec",
  "critic",
  "foreman",
  "builder",
  "reviewer",
  "librarian",
  "explorer",
] as const;

type AgentType = (typeof AGENT_TYPES)[number];

const AGENT_BADGE_COLORS: Record<AgentType, string> = {
  orchestrator: "bg-[#8b5cf630] text-[#8b5cf6]",
  product: "bg-[#6366f120] text-[#6366f1]",
  spec: "bg-[#3b82f620] text-[#3b82f6]",
  critic: "bg-[#f59e0b20] text-[#f59e0b]",
  foreman: "bg-[#10b98120] text-[#10b981]",
  builder: "bg-[#06b6d420] text-[#06b6d4]",
  reviewer: "bg-[#ec489920] text-[#ec4899]",
  librarian: "bg-[#8b5cf620] text-[#8b5cf6]",
  explorer: "bg-[#64748b20] text-[#64748b]",
};

function isValidAgentType(value: string): value is AgentType {
  return (AGENT_TYPES as readonly string[]).includes(value);
}

// ─── Border type for confirmation cards ───

type BorderType = "default" | "file_write" | "destructive";

function getConfirmationBorderType(toolName: string, input: unknown): BorderType {
  if (toolName === "file_write" || toolName === "file_edit") return "file_write";
  if (toolName === "bash") {
    if (typeof input === "object" && input !== null && "command" in input) {
      const cmd = (input as { command: string }).command;
      if (typeof cmd === "string") {
        const destructivePatterns = /\b(rm\s|rm\s+-|rmdir|mv\s+\S+\s+\/dev|dd\s|mkfs|format|:\s*>|>\s*\/)/i;
        if (destructivePatterns.test(cmd)) return "destructive";
      }
    }
    return "default";
  }
  return "default";
}

const BORDER_CLASSES: Record<BorderType, string> = {
  default: "border-warning",
  file_write: "border-warning",
  destructive: "border-error",
};

const CMD_BORDER_CLASSES: Record<BorderType, string> = {
  default: "border-border-default",
  file_write: "border-border-default",
  destructive: "border-error/30 text-error",
};

// ─── Format tool input for display ───

function formatInputSnippet(input: unknown, toolName: string): string {
  if (input === null || input === undefined) return "";
  if (typeof input === "string") return input;
  if (typeof input === "object") {
    if (toolName === "bash" && "command" in input) {
      return String((input as { command: string }).command);
    }
    if (("file_path" in input || "filePath" in input || "path" in input)) {
      const obj = input as Record<string, unknown>;
      const path = obj.file_path ?? obj.filePath ?? obj.path;
      if (typeof path === "string") return path;
    }
    try {
      const json = JSON.stringify(input);
      return json.length > 200 ? json.slice(0, 200) + "…" : json;
    } catch {
      return String(input);
    }
  }
  return String(input);
}

// ─── Question type (from AskUserQuestion) ───

interface QuestionData {
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multiple?: boolean;
  custom: boolean;
}

// ─── ConfirmationCard ───

function ConfirmationCard({
  permission,
  onRespond,
}: {
  permission: PermissionRequest;
  onRespond: (id: string, decision: PermissionDecision) => void;
}) {
  const borderType = getConfirmationBorderType(permission.toolName, permission.input);
  const inputSnippet = formatInputSnippet(permission.input, permission.toolName);
  const agentType = permission.agentName ?? "orchestrator";
  const resolvedAgent = isValidAgentType(agentType) ? agentType : "explorer" as AgentType;

  return (
    <div className={`bg-bg-elevated border-[1.5px] ${BORDER_CLASSES[borderType]} rounded-md px-3.5 py-2.5 shrink-0`}>
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-sm shrink-0">
          {borderType === "destructive" ? "⚠️" : "🔒"}
        </span>
        <span className={`font-semibold text-[13px] ${borderType === "destructive" ? "text-error" : "text-text-primary"}`}>
          {permission.toolName}
        </span>
        {permission.reason && (
          <span className="text-[12px] text-text-secondary">— {permission.reason}</span>
        )}
        <span className={`ml-auto text-[11px] px-1.5 py-[2px] rounded font-medium ${AGENT_BADGE_COLORS[resolvedAgent]}`}>
          {resolvedAgent}
          {permission.currentDepth !== undefined ? ` d${permission.currentDepth}` : ""}
        </span>
      </div>

      {permission.description && (
        <div className="text-[12.5px] text-text-secondary leading-[1.55] mb-2">
          {permission.description}
        </div>
      )}

      {inputSnippet && (
        <div className={`font-mono text-[12px] bg-bg-base border rounded-sm px-2.5 py-1.5 mb-2 whitespace-pre-wrap break-all max-h-[120px] overflow-y-auto ${CMD_BORDER_CLASSES[borderType]}`}>
          {inputSnippet}
        </div>
      )}

      <div className="flex flex-wrap gap-1.5">
        <button
          className="px-3.5 py-[5px] rounded-sm text-[12px] font-medium bg-success-muted text-success cursor-pointer transition-colors duration-150 hover:opacity-90"
          onClick={() => onRespond(permission.id, "approve_once")}
        >
          Allow Once
        </button>
        <button
          className="px-3.5 py-[5px] rounded-sm text-[12px] font-medium bg-accent-muted text-accent cursor-pointer transition-colors duration-150 hover:opacity-90"
          onClick={() => onRespond(permission.id, "approve_always")}
        >
          Allow for Project
        </button>
        <button
          className="px-3.5 py-[5px] rounded-sm text-[12px] font-medium bg-bg-active text-text-muted cursor-pointer transition-colors duration-150 hover:bg-bg-hover hover:text-text-secondary"
          onClick={() => onRespond(permission.id, "deny")}
        >
          Deny
        </button>
      </div>
    </div>
  );
}

// ─── QuestionCard ───

function QuestionCard({
  questionRequest,
  onRespond,
}: {
  questionRequest: QuestionRequest;
  onRespond: (id: string, body: { answers: string[][] } | { isError: true; reason: string }) => void;
}) {
  const questions = (questionRequest.questions ?? []) as QuestionData[];
  const hasMultipleQuestions = questions.length > 1;

  const [activeTab, setActiveTab] = useState<number>(0);

  const [answers, setAnswers] = useState<string[][]>(() =>
    questions.map(() => []),
  );
  const [customTexts, setCustomTexts] = useState<string[]>(() =>
    questions.map(() => ""),
  );

  const isConfirmTab = activeTab === questions.length;
  const allAnswered = answers.every((a) => a.length > 0);

  const toggleOption = useCallback(
    (qIndex: number, label: string, multiple?: boolean) => {
      setAnswers((prev) => {
        const next = [...prev];
        const current = [...next[qIndex]];
        if (multiple) {
          const idx = current.indexOf(label);
          if (idx >= 0) current.splice(idx, 1);
          else current.push(label);
        } else {
          current.length = 0;
          current.push(label);
        }
        next[qIndex] = current;
        return next;
      });
    },
    [],
  );

  const handleSubmitCustom = useCallback(
    (qIndex: number) => {
      const text = customTexts[qIndex].trim();
      if (!text) return;
      setAnswers((prev) => {
        const next = [...prev];
        const current = [...next[qIndex]];
        if (!current.includes(text)) current.push(text);
        next[qIndex] = current;
        return next;
      });
      setCustomTexts((prev) => {
        const next = [...prev];
        next[qIndex] = "";
        return next;
      });
    },
    [customTexts],
  );

  const handleSubmitAll = useCallback(() => {
    if (!allAnswered) return;
    onRespond(questionRequest.id, { answers });
  }, [allAnswered, answers, onRespond, questionRequest.id]);

  const handleCancel = useCallback(() => {
    onRespond(questionRequest.id, { isError: true, reason: "Cancelled by user" });
  }, [onRespond, questionRequest.id]);

  return (
    <div className="bg-bg-elevated border-[1.5px] border-accent rounded-md overflow-hidden shrink-0">
      <div className="flex items-center gap-2 px-3.5 py-2 bg-accent-subtle border-b border-accent-muted">
        <span className="text-sm">❓</span>
        <span className="font-semibold text-[13px] text-accent">Questions</span>
        {questionRequest.toolName && (
          <span className="text-[11px] text-text-muted">via {questionRequest.toolName}</span>
        )}
      </div>

      {hasMultipleQuestions && (
        <div className="flex border-b border-border-subtle bg-bg-surface">
          {questions.map((q, i) => (
            <button
              key={i}
              className={`flex-1 py-1.5 text-center text-[11px] font-medium cursor-pointer border-none border-b-2 bg-transparent transition-all duration-150 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap
                ${answers[i].length > 0 ? "text-success opacity-70" : ""}
                ${activeTab === i ? "text-accent border-b-accent bg-bg-elevated" : "text-text-muted border-b-transparent hover:text-text-secondary hover:bg-bg-hover"}
              `}
              onClick={() => setActiveTab(i)}
            >
              {q.header || `Q${i + 1}`}
              {answers[i].length > 0 && " ✓"}
            </button>
          ))}
          <button
            className={`flex-1 py-1.5 text-center text-[11px] font-medium cursor-pointer border-none border-b-2 bg-transparent transition-all duration-150
              ${activeTab === questions.length ? "text-success border-b-success bg-bg-elevated" : "text-success/70 border-b-transparent hover:text-success hover:bg-bg-hover"}
            `}
            onClick={() => setActiveTab(questions.length)}
          >
            Confirm
          </button>
        </div>
      )}

      <div className="px-3.5 py-2.5">
        {isConfirmTab ? (
          <div className="text-center">
            <div className="text-[12.5px] text-text-secondary mb-3">
              Review your answers before submitting
            </div>
            <div className="text-left mb-3">
              {questions.map((q, i) => (
                <div key={i} className="flex gap-2 py-1 text-[12px]">
                  <span className="text-text-muted shrink-0">{q.header || `Q${i + 1}`}:</span>
                  <span className="text-text-primary break-words">
                    {answers[i].length > 0 ? answers[i].join(", ") : "—"}
                  </span>
                </div>
              ))}
            </div>
            <div className="flex justify-center gap-2">
              <button
                className="px-4 py-1.5 rounded-sm text-[12px] font-medium bg-accent text-white border border-accent cursor-pointer transition-colors duration-150 hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed"
                onClick={handleSubmitAll}
                disabled={!allAnswered}
              >
                Submit All Answers
              </button>
              <button
                className="px-4 py-1.5 rounded-sm text-[12px] font-medium bg-transparent text-error border border-border-default cursor-pointer transition-colors duration-150 hover:bg-error-muted"
                onClick={handleCancel}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <QuestionPane
            question={questions[activeTab]}
            qIndex={activeTab}
            selected={answers[activeTab]}
            customText={customTexts[activeTab]}
            onToggleOption={(label) => toggleOption(activeTab, label, questions[activeTab]?.multiple)}
            onCustomTextChange={(text) =>
              setCustomTexts((prev) => {
                const next = [...prev];
                next[activeTab] = text;
                return next;
              })
            }
            onSubmitCustom={() => handleSubmitCustom(activeTab)}
            isLastQuestion={activeTab === questions.length - 1 && !hasMultipleQuestions}
            onSubmitAll={handleSubmitAll}
            allAnswered={allAnswered}
            onCancel={handleCancel}
          />
        )}
      </div>
    </div>
  );
}

// ─── Single question pane ───

function QuestionPane({
  question,
  qIndex,
  selected,
  customText,
  onToggleOption,
  onCustomTextChange,
  onSubmitCustom,
  isLastQuestion,
  onSubmitAll,
  allAnswered,
  onCancel,
}: {
  question: QuestionData;
  qIndex: number;
  selected: string[];
  customText: string;
  onToggleOption: (label: string) => void;
  onCustomTextChange: (text: string) => void;
  onSubmitCustom: () => void;
  isLastQuestion: boolean;
  onSubmitAll: () => void;
  allAnswered: boolean;
  onCancel: () => void;
}) {
  const hasOptions = question.options && question.options.length > 0;

  return (
    <div>
      <div className="text-[13px] text-text-primary leading-[1.55] mb-2.5">
        {question.question}
      </div>

      {hasOptions && (
        <div className="flex flex-col gap-1.5 mb-2">
          {question.options.map((opt) => {
            const isSelected = selected.includes(opt.label);
            return (
              <label
                key={opt.label}
                className={`flex items-center gap-2 px-2.5 py-1.5 border rounded-sm cursor-pointer text-[12.5px] transition-all duration-150
                  ${isSelected
                    ? "bg-accent-subtle border-accent text-accent"
                    : "border-border-default text-text-secondary hover:bg-bg-hover hover:border-border-strong hover:text-text-primary"
                  }
                `}
              >
                <span
                  className={`w-4 h-4 border-[1.5px] flex items-center justify-center text-[10px] shrink-0
                    ${question.multiple ? "rounded-[3px]" : "rounded-full"}
                    ${isSelected ? "border-accent bg-accent text-white" : "border-border-strong"}
                  `}
                >
                  {isSelected && (question.multiple ? "✓" : "●")}
                </span>
                <input
                  type={question.multiple ? "checkbox" : "radio"}
                  name={`question-${qIndex}`}
                  value={opt.label}
                  checked={isSelected}
                  onChange={() => onToggleOption(opt.label)}
                  className="sr-only"
                />
                <span className="flex-1 min-w-0">{opt.label}</span>
                {opt.description && (
                  <span className="text-[11px] text-text-muted truncate">{opt.description}</span>
                )}
              </label>
            );
          })}
        </div>
      )}

      {question.custom !== false && (
        <div className="mb-2">
          <div className="flex gap-1.5">
            <input
              type="text"
              value={customText}
              onChange={(e) => onCustomTextChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && customText.trim()) onSubmitCustom();
              }}
              placeholder="Type your own answer…"
              className="flex-1 bg-bg-base border border-border-default rounded-sm px-2.5 py-2 text-[13px] text-text-primary font-sans outline-none transition-colors duration-150 focus:border-accent placeholder:text-text-muted"
            />
            {customText.trim() && (
              <button
                className="px-3 py-2 rounded-sm text-[12px] font-medium bg-accent text-white cursor-pointer transition-colors duration-150 hover:bg-accent-hover"
                onClick={onSubmitCustom}
              >
                Add
              </button>
            )}
          </div>
        </div>
      )}

      {isLastQuestion && (
        <div className="flex justify-center gap-2 mt-2">
          <button
            className="px-4 py-1.5 rounded-sm text-[12px] font-medium bg-accent text-white border border-accent cursor-pointer transition-colors duration-150 hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={onSubmitAll}
            disabled={!allAnswered}
          >
            Submit Answer
          </button>
          <button
            className="px-4 py-1.5 rounded-sm text-[12px] font-medium bg-transparent text-error border border-border-default cursor-pointer transition-colors duration-150 hover:bg-error-muted"
            onClick={onCancel}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

// ─── AttentionQueue (main export) ───

export interface AttentionQueueProps {
  sessionId: string;
}

export function AttentionQueue({ sessionId }: AttentionQueueProps) {
  const { permissions, questions, respondPermission, respondQuestion } =
    useAttentionQueue(sessionId);

  const totalItems = permissions.length + questions.length;

  if (totalItems === 0) return null;

  return (
    <div className="max-h-[min(500px,50vh)] overflow-y-auto bg-bg-surface shrink-0 border-t border-border-subtle px-5 py-2.5 flex flex-col gap-2">
      <div className="flex items-center gap-1.5 text-[11.5px] font-semibold text-warning mb-0.5">
        <span>🔔</span>
        Attention Required
        <span className="bg-warning-muted text-warning px-[7px] py-[1px] rounded-[10px] text-[11px] font-semibold">
          {totalItems}
        </span>
      </div>

      {permissions.map((perm) => (
        <ConfirmationCard
          key={perm.id}
          permission={perm}
          onRespond={respondPermission}
        />
      ))}

      {questions.map((q) => (
        <QuestionCard
          key={q.id}
          questionRequest={q}
          onRespond={respondQuestion}
        />
      ))}
    </div>
  );
}