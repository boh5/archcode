import { useState, useCallback, useEffect } from "react";
import { Plus, Trash2 } from "lucide-react";
import {
  DialogRoot,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "../ui/Dialog";
import { useCreateGoal } from "../../api/mutations";
import type { ApprovalPoint, DoneCondition, RetryPolicy } from "../../api/types";

type ConditionKind = DoneCondition["kind"];

interface CreateGoalDialogProps {
  open: boolean;
  onClose: () => void;
  slug: string;
  onCreated: (goalId: string) => void;
}

const CONDITION_KINDS: { kind: ConditionKind; label: string; hint: string }[] = [
  { kind: "file_exists", label: "File exists", hint: "path" },
  { kind: "grep_contains", label: "Grep contains", hint: "pattern, path?, minMatches?" },
  { kind: "grep_empty", label: "Grep empty", hint: "pattern, path?" },
  { kind: "command_succeeds", label: "Command succeeds", hint: "command, timeoutMs?" },
  { kind: "tests_pass", label: "Tests pass", hint: "command?" },
  { kind: "typecheck_pass", label: "Typecheck passes", hint: "command?" },
  { kind: "lsp_clean", label: "LSP clean", hint: "paths?, severity?" },
  { kind: "user_confirmed", label: "User confirmed", hint: "prompt" },
];

const APPROVAL_POINTS: ApprovalPoint[] = ["after_plan", "before_complete"];

const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 2,
  backoffMs: 1000,
  escalateOnFailure: true,
};

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export function validateCondition(condition: DoneCondition): string[] {
  const errors: string[] = [];
  switch (condition.kind) {
    case "file_exists":
      if (!isNonEmpty(condition.params.path)) errors.push("path is required");
      break;
    case "grep_contains":
      if (!isNonEmpty(condition.params.pattern)) errors.push("pattern is required");
      if (condition.params.path !== undefined && condition.params.path !== "" && !isNonEmpty(condition.params.path)) errors.push("path must be non-empty if set");
      if (condition.params.minMatches !== undefined && !isPositiveInt(condition.params.minMatches)) errors.push("minMatches must be a positive integer");
      break;
    case "grep_empty":
      if (!isNonEmpty(condition.params.pattern)) errors.push("pattern is required");
      if (condition.params.path !== undefined && condition.params.path !== "" && !isNonEmpty(condition.params.path)) errors.push("path must be non-empty if set");
      break;
    case "command_succeeds":
      if (!isNonEmpty(condition.params.command)) errors.push("command is required");
      if (condition.params.timeoutMs !== undefined && !isPositiveInt(condition.params.timeoutMs)) errors.push("timeoutMs must be a positive integer");
      break;
    case "tests_pass":
      if (condition.params.command !== undefined && condition.params.command !== "" && !isNonEmpty(condition.params.command)) errors.push("command must be non-empty if set");
      break;
    case "typecheck_pass":
      if (condition.params.command !== undefined && condition.params.command !== "" && !isNonEmpty(condition.params.command)) errors.push("command must be non-empty if set");
      break;
    case "lsp_clean":
      break;
    case "user_confirmed":
      if (!isNonEmpty(condition.params.prompt)) errors.push("prompt is required");
      break;
    case "spec_compliance":
      if (!isNonEmpty(condition.params.specPath)) errors.push("specPath is required");
      break;
  }
  return errors;
}

export function sanitizeCondition(condition: DoneCondition): DoneCondition {
  switch (condition.kind) {
    case "file_exists":
      return { ...condition, params: { path: condition.params.path.trim() } };
    case "grep_contains":
      return {
        ...condition,
        params: {
          pattern: condition.params.pattern.trim(),
          ...(isNonEmpty(condition.params.path) ? { path: condition.params.path.trim() } : {}),
          ...(isPositiveInt(condition.params.minMatches) ? { minMatches: condition.params.minMatches } : {}),
        },
      };
    case "grep_empty":
      return {
        ...condition,
        params: {
          pattern: condition.params.pattern.trim(),
          ...(isNonEmpty(condition.params.path) ? { path: condition.params.path.trim() } : {}),
        },
      };
    case "command_succeeds":
      return {
        ...condition,
        params: {
          command: condition.params.command.trim(),
          ...(isPositiveInt(condition.params.timeoutMs) ? { timeoutMs: condition.params.timeoutMs } : {}),
        },
      };
    case "tests_pass":
      return { ...condition, params: isNonEmpty(condition.params.command) ? { command: condition.params.command.trim() } : {} };
    case "typecheck_pass":
      return { ...condition, params: isNonEmpty(condition.params.command) ? { command: condition.params.command.trim() } : {} };
    case "lsp_clean":
      return { ...condition, params: condition.params.severity === "error" || condition.params.severity === "warning" ? { severity: condition.params.severity } : {} };
    case "user_confirmed":
      return { ...condition, params: { prompt: condition.params.prompt.trim() } };
    case "spec_compliance":
      return {
        ...condition,
        params: {
          specPath: condition.params.specPath.trim(),
          ...(condition.params.focusAreas && condition.params.focusAreas.length > 0 ? { focusAreas: condition.params.focusAreas } : {}),
        },
      };
  }
}

function updateConditionParamValue(condition: DoneCondition, key: string, value: string | number | string[]): DoneCondition {
  switch (condition.kind) {
    case "file_exists":
      return key === "path" && typeof value === "string" ? { ...condition, params: { ...condition.params, path: value } } : condition;
    case "grep_contains":
      if (key === "pattern" && typeof value === "string") return { ...condition, params: { ...condition.params, pattern: value } };
      if (key === "path" && typeof value === "string") return { ...condition, params: { ...condition.params, path: value } };
      if (key === "minMatches" && typeof value === "number") return { ...condition, params: { ...condition.params, minMatches: value } };
      return condition;
    case "grep_empty":
      if (key === "pattern" && typeof value === "string") return { ...condition, params: { ...condition.params, pattern: value } };
      if (key === "path" && typeof value === "string") return { ...condition, params: { ...condition.params, path: value } };
      return condition;
    case "command_succeeds":
      if (key === "command" && typeof value === "string") return { ...condition, params: { ...condition.params, command: value } };
      if (key === "timeoutMs" && typeof value === "number") return { ...condition, params: { ...condition.params, timeoutMs: value } };
      return condition;
    case "tests_pass":
      return key === "command" && typeof value === "string" ? { ...condition, params: { ...condition.params, command: value } } : condition;
    case "typecheck_pass":
      return key === "command" && typeof value === "string" ? { ...condition, params: { ...condition.params, command: value } } : condition;
    case "lsp_clean":
      return key === "severity" && typeof value === "string" ? { ...condition, params: { ...condition.params, severity: value === "warning" ? "warning" : "error" } } : condition;
    case "user_confirmed":
      return key === "prompt" && typeof value === "string" ? { ...condition, params: { ...condition.params, prompt: value } } : condition;
    case "spec_compliance":
      if (key === "specPath" && typeof value === "string") return { ...condition, params: { ...condition.params, specPath: value } };
      if (key === "focusAreas" && Array.isArray(value)) return { ...condition, params: { ...condition.params, focusAreas: value } };
      return condition;
  }
}

function conditionParamValue(condition: DoneCondition, key: string): unknown {
  return Object.entries(condition.params).find(([paramKey]) => paramKey === key)?.[1];
}

function makeCondition(kind: ConditionKind): DoneCondition {
  const id = crypto.randomUUID();
  switch (kind) {
    case "file_exists":
      return { id, kind, params: { path: "" }, required: true };
    case "grep_contains":
      return { id, kind, params: { pattern: "", path: "", minMatches: 1 }, required: true };
    case "grep_empty":
      return { id, kind, params: { pattern: "", path: "" }, required: true };
    case "command_succeeds":
      return { id, kind, params: { command: "", timeoutMs: 60000 }, required: true };
    case "tests_pass":
      return { id, kind, params: { command: "bun test" }, required: true };
    case "typecheck_pass":
      return { id, kind, params: { command: "bun run typecheck" }, required: true };
    case "lsp_clean":
      return { id, kind, params: { paths: [], severity: "error" }, required: true };
    case "user_confirmed":
      return { id, kind, params: { prompt: "" }, required: true };
    case "spec_compliance":
      return { id, kind, params: { specPath: "", focusAreas: [] }, required: true };
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unhandled condition kind: ${exhaustive as string}`);
    }
  }
}

export function CreateGoalDialog({ open, onClose, slug, onCreated }: CreateGoalDialogProps) {
  const createGoal = useCreateGoal();

  const [title, setTitle] = useState("");
  const [conditions, setConditions] = useState<DoneCondition[]>([]);
  const [maxRetries, setMaxRetries] = useState(2);
  const [escalateOnFailure, setEscalateOnFailure] = useState(true);
  const [approvalPoints, setApprovalPoints] = useState<ApprovalPoint[]>([
    "after_plan",
    "before_complete",
  ]);
  const [reviewerAgent, setReviewerAgent] = useState("reviewer");
  const [author, setAuthor] = useState("architect");

  useEffect(() => {
    if (open) {
      setTitle("");
      setConditions([]);
      setMaxRetries(2);
      setEscalateOnFailure(true);
      setApprovalPoints(["after_plan", "before_complete"]);
      setReviewerAgent("reviewer");
      setAuthor("architect");
    }
  }, [open]);

  const trimmedTitle = title.trim();
  const conditionErrors = conditions.map((c) => validateCondition(c));
  const allConditionsValid = conditions.length > 0 && conditionErrors.every((e) => e.length === 0);
  const canSubmit = trimmedTitle.length > 0 && allConditionsValid && !createGoal.isPending;

  const addCondition = useCallback((kind: ConditionKind) => {
    setConditions((prev) => [...prev, makeCondition(kind)]);
  }, []);

  const removeCondition = useCallback((id: string) => {
    setConditions((prev) => prev.filter((c) => c.id !== id));
  }, []);

  const updateConditionRequired = useCallback((id: string, required: boolean) => {
    setConditions((prev) => prev.map((c) => (c.id === id ? { ...c, required } : c)));
  }, []);

  const updateConditionParam = useCallback(
    (id: string, key: string, value: string | number | string[]) => {
      setConditions((prev) =>
        prev.map((c) =>
          c.id === id
            ? updateConditionParamValue(c, key, value)
            : c,
        ),
      );
    },
    [],
  );

  const toggleApprovalPoint = useCallback((point: ApprovalPoint) => {
    setApprovalPoints((prev) =>
      prev.includes(point) ? prev.filter((p) => p !== point) : [...prev, point],
    );
  }, []);

  const handleSubmit = useCallback(
    (e: { preventDefault: () => void }) => {
      e.preventDefault();
      if (!canSubmit) return;

      const retryPolicy: RetryPolicy = {
        maxRetries,
        backoffMs: DEFAULT_RETRY_POLICY.backoffMs,
        escalateOnFailure,
      };

      createGoal.mutate(
        {
          slug,
          title: trimmedTitle,
          doneConditions: conditions.map(sanitizeCondition),
          retryPolicy,
          approvalPoints,
          reviewerAgent: reviewerAgent.trim() || "reviewer",
          author: author.trim() || "architect",
        },
        {
          onSuccess: (goal) => {
            onCreated(goal.id);
          },
        },
      );
    },
    [
      canSubmit,
      createGoal,
      slug,
      trimmedTitle,
      conditions,
      maxRetries,
      escalateOnFailure,
      approvalPoints,
      reviewerAgent,
      author,
      onCreated,
    ],
  );

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) onClose();
    },
    [onClose],
  );

  const errorMessage = createGoal.error
    ? createGoal.error instanceof Error
      ? createGoal.error.message
      : "Failed to create goal"
    : null;

  return (
    <DialogRoot open={open} onOpenChange={handleOpenChange}>
      <DialogContent size="x-large">
        <form onSubmit={handleSubmit} className="flex h-full flex-col">
          <div className="flex items-center justify-between border-b border-border-subtle px-5 py-4 shrink-0">
            <DialogTitle className="text-base font-semibold text-text-primary">
              New Goal
            </DialogTitle>
            <DialogDescription className="sr-only">
              Create a draft goal with done conditions
            </DialogDescription>
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
            <div>
              <label
                htmlFor="new-goal-title"
                className="mb-1.5 block text-[13px] font-medium text-text-secondary"
              >
                Title
              </label>
              <input
                id="new-goal-title"
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="What should the agent accomplish?"
                className="w-full rounded-sm border border-border-default bg-bg-base px-3 py-2 text-[13px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none transition-colors duration-150"
                autoFocus
                disabled={createGoal.isPending}
              />
            </div>

            <div>
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[13px] font-medium text-text-secondary">
                  Done Conditions
                </span>
                <span className="text-[11px] text-text-muted">
                  {conditions.length} added
                </span>
              </div>

              <div className="flex flex-wrap gap-1.5 mb-3">
                {CONDITION_KINDS.map(({ kind, label }) => (
                  <button
                    key={kind}
                    type="button"
                    onClick={() => addCondition(kind)}
                    disabled={createGoal.isPending}
                    className="inline-flex items-center gap-1 rounded-sm border border-border-subtle bg-bg-base px-2 py-1 text-[11.5px] text-text-secondary transition-colors duration-150 hover:bg-bg-hover hover:text-text-primary disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Plus size={11} />
                    {label}
                  </button>
                ))}
              </div>

              {conditions.length === 0 ? (
                <div className="rounded-sm border border-dashed border-border-subtle px-3 py-6 text-center text-[12px] text-text-muted">
                  Add at least one done condition to define when the goal is complete.
                </div>
              ) : (
                <ul className="space-y-2">
                  {conditions.map((condition, index) => (
                    <ConditionRow
                      key={condition.id}
                      condition={condition}
                      errors={conditionErrors[index]}
                      disabled={createGoal.isPending}
                      onRemove={() => removeCondition(condition.id)}
                      onParamChange={(key, value) =>
                        updateConditionParam(condition.id, key, value)
                      }
                      onRequiredChange={(required) =>
                        updateConditionRequired(condition.id, required)
                      }
                    />
                  ))}
                </ul>
              )}
            </div>

            <div>
              <span className="mb-2 block text-[13px] font-medium text-text-secondary">
                Retry Policy
              </span>
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2 text-[12.5px] text-text-secondary">
                  <span>maxRetries</span>
                  <input
                    type="number"
                    min={0}
                    max={10}
                    value={maxRetries}
                    onChange={(e) => setMaxRetries(Number(e.target.value) || 0)}
                    disabled={createGoal.isPending}
                    className="w-20 rounded-sm border border-border-default bg-bg-base px-2 py-1 text-[12.5px] text-text-primary focus:border-accent focus:outline-none"
                  />
                </label>
                <label className="flex items-center gap-2 text-[12.5px] text-text-secondary">
                  <input
                    type="checkbox"
                    checked={escalateOnFailure}
                    onChange={(e) => setEscalateOnFailure(e.target.checked)}
                    disabled={createGoal.isPending}
                    className="accent-accent"
                  />
                  <span>escalate on failure</span>
                </label>
              </div>
            </div>

            <div>
              <span className="mb-2 block text-[13px] font-medium text-text-secondary">
                Approval Points
              </span>
              <div className="flex items-center gap-4">
                {APPROVAL_POINTS.map((point) => (
                  <label
                    key={point}
                    className="flex items-center gap-2 text-[12.5px] text-text-secondary"
                  >
                    <input
                      type="checkbox"
                      checked={approvalPoints.includes(point)}
                      onChange={() => toggleApprovalPoint(point)}
                      disabled={createGoal.isPending}
                      className="accent-accent"
                    />
                    <span className="font-mono">{point}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label
                  htmlFor="new-goal-reviewer"
                  className="mb-1.5 block text-[13px] font-medium text-text-secondary"
                >
                  Reviewer agent
                </label>
                <input
                  id="new-goal-reviewer"
                  type="text"
                  value={reviewerAgent}
                  onChange={(e) => setReviewerAgent(e.target.value)}
                  disabled={createGoal.isPending}
                  className="w-full rounded-sm border border-border-default bg-bg-base px-3 py-2 text-[13px] text-text-primary focus:border-accent focus:outline-none transition-colors duration-150"
                />
              </div>
              <div>
                <label
                  htmlFor="new-goal-author"
                  className="mb-1.5 block text-[13px] font-medium text-text-secondary"
                >
                  Author
                </label>
                <input
                  id="new-goal-author"
                  type="text"
                  value={author}
                  onChange={(e) => setAuthor(e.target.value)}
                  disabled={createGoal.isPending}
                  className="w-full rounded-sm border border-border-default bg-bg-base px-3 py-2 text-[13px] text-text-primary focus:border-accent focus:outline-none transition-colors duration-150"
                />
              </div>
            </div>
          </div>

          {errorMessage && (
            <div className="px-5 py-2 text-xs text-error shrink-0">{errorMessage}</div>
          )}

          <div className="flex justify-end gap-2 border-t border-border-subtle px-5 py-3 shrink-0">
            <button
              type="button"
              onClick={onClose}
              className="rounded-sm bg-bg-active px-4 py-2 text-[13px] font-medium text-text-primary transition-colors duration-150 hover:bg-bg-hover"
              disabled={createGoal.isPending}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="rounded-sm bg-accent px-4 py-2 text-[13px] font-medium text-bg-base transition-colors duration-150 hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
              disabled={!canSubmit}
            >
              {createGoal.isPending ? "Creating…" : "Create Draft"}
            </button>
          </div>
        </form>
      </DialogContent>
    </DialogRoot>
  );
}

interface ConditionRowProps {
  condition: DoneCondition;
  errors: string[];
  disabled: boolean;
  onRemove: () => void;
  onParamChange: (key: string, value: string | number | string[]) => void;
  onRequiredChange: (required: boolean) => void;
}

function ConditionRow({
  condition,
  errors,
  disabled,
  onRemove,
  onParamChange,
  onRequiredChange,
}: ConditionRowProps) {
  const paramFields = PARAM_FIELDS_BY_KIND[condition.kind] ?? [];

  return (
    <li className="rounded-sm border border-border-subtle bg-bg-base px-3 py-2.5">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[12.5px] font-mono font-medium text-text-primary">
          {condition.kind}
        </span>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-[11.5px] text-text-muted">
            <input
              type="checkbox"
              checked={condition.required ?? true}
              onChange={(e) => onRequiredChange(e.target.checked)}
              disabled={disabled}
              className="accent-accent"
            />
            required
          </label>
          <button
            type="button"
            onClick={onRemove}
            disabled={disabled}
            aria-label="Remove condition"
            className="flex h-5 w-5 items-center justify-center rounded-sm text-text-muted transition-colors duration-150 hover:bg-bg-hover hover:text-error disabled:opacity-40"
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>
      {paramFields.length > 0 && (
        <div className="grid grid-cols-2 gap-2">
          {paramFields.map((field) => (
            <ParamInput
              key={field.key}
              field={field}
              value={conditionParamValue(condition, field.key)}
              disabled={disabled}
              onChange={(value) => onParamChange(field.key, value)}
            />
          ))}
        </div>
      )}
      {errors.length > 0 && (
        <ul className="mt-2 space-y-0.5">
          {errors.map((err) => (
            <li key={err} className="text-[11px] text-error">{err}</li>
          ))}
        </ul>
      )}
    </li>
  );
}

interface ParamField {
  key: string;
  label: string;
  type: "text" | "number" | "select";
  placeholder?: string;
  options?: string[];
}

const PARAM_FIELDS_BY_KIND: Partial<Record<ConditionKind, ParamField[]>> = {
  file_exists: [{ key: "path", label: "path", type: "text", placeholder: "/src/index.ts" }],
  grep_contains: [
    { key: "pattern", label: "pattern", type: "text", placeholder: "export function" },
    { key: "path", label: "path", type: "text", placeholder: "src/" },
    { key: "minMatches", label: "minMatches", type: "number", placeholder: "1" },
  ],
  grep_empty: [
    { key: "pattern", label: "pattern", type: "text", placeholder: "TODO" },
    { key: "path", label: "path", type: "text", placeholder: "src/" },
  ],
  command_succeeds: [
    { key: "command", label: "command", type: "text", placeholder: "bun run build" },
    { key: "timeoutMs", label: "timeoutMs", type: "number", placeholder: "60000" },
  ],
  tests_pass: [{ key: "command", label: "command", type: "text", placeholder: "bun test" }],
  typecheck_pass: [
    { key: "command", label: "command", type: "text", placeholder: "bun run typecheck" },
  ],
  lsp_clean: [
    { key: "severity", label: "severity", type: "select", options: ["error", "warning"] },
  ],
  user_confirmed: [{ key: "prompt", label: "prompt", type: "text", placeholder: "Confirm?" }],
  spec_compliance: [
    { key: "specPath", label: "specPath", type: "text", placeholder: "spec.md" },
  ],
};

function ParamInput({
  field,
  value,
  disabled,
  onChange,
}: {
  field: ParamField;
  value: unknown;
  disabled: boolean;
  onChange: (value: string | number | string[]) => void;
}) {
  if (field.type === "select") {
    const options = field.options ?? [];
    const strValue = typeof value === "string" ? value : "";
    return (
      <label className="flex flex-col gap-1">
        <span className="text-[11px] text-text-muted font-mono">{field.label}</span>
        <select
          value={options.includes(strValue) ? strValue : ""}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className="rounded-sm border border-border-subtle bg-bg-base px-2 py-1.5 text-[12px] text-text-primary focus:border-accent focus:outline-none"
        >
          <option value="" disabled>
            Select…
          </option>
          {options.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      </label>
    );
  }

  if (field.type === "number") {
    const numValue = typeof value === "number" ? value : value === undefined || value === "" ? "" : Number(value);
    return (
      <label className="flex flex-col gap-1">
        <span className="text-[11px] text-text-muted font-mono">{field.label}</span>
        <input
          type="number"
          value={numValue === "" ? "" : Number(numValue)}
          onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))}
          placeholder={field.placeholder}
          disabled={disabled}
          className="rounded-sm border border-border-subtle bg-bg-base px-2 py-1.5 text-[12px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
        />
      </label>
    );
  }

  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] text-text-muted font-mono">{field.label}</span>
      <input
        type="text"
        value={typeof value === "string" ? value : value === undefined ? "" : String(value)}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.placeholder}
        disabled={disabled}
        className="rounded-sm border border-border-subtle bg-bg-base px-2 py-1.5 text-[12px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
      />
    </label>
  );
}
