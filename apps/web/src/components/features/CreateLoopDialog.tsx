import { useState, useCallback } from "react";
import {
  DialogRoot,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "../ui/Dialog";
import { useCreateLoop } from "../../api/mutations";
import type {
  ApprovalPoint,
  DoneCondition,
  LoopApprovalPolicy,
  LoopConfig,
  LoopMode,
  LoopRunKind,
  LoopScheduleSpec,
  RetryPolicy,
} from "../../api/types";

// Only Phase 3 runnable presets are enabled; unsupported connector presets
// are shown disabled with a Phase 4+ label. Server validation is authoritative.
interface PresetQuickStart {
  id: string;
  label: string;
  enabled: boolean;
  phaseLabel?: string;
}

const PRESET_QUICK_STARTS: PresetQuickStart[] = [
  { id: "daily_triage", label: "Daily Triage", enabled: true },
  { id: "changelog_drafter", label: "Changelog Drafter", enabled: true },
  { id: "pr_babysitter", label: "PR Babysitter", enabled: false, phaseLabel: "Phase 4+" },
  { id: "ci_sweeper", label: "CI Sweeper", enabled: false, phaseLabel: "Phase 4+" },
  { id: "dependency_sweeper", label: "Dependency Sweeper", enabled: false, phaseLabel: "Phase 4+" },
  { id: "post_merge_cleanup", label: "Post-Merge Cleanup", enabled: false, phaseLabel: "Phase 4+" },
  { id: "issue_triage", label: "Issue Triage", enabled: false, phaseLabel: "Phase 4+" },
];

const APPROVAL_POINTS: ApprovalPoint[] = ["after_plan", "before_complete"];

const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 2,
  backoffMs: 1000,
  escalateOnFailure: true,
};

// Minimum interval guard; server validation remains the source of truth.
const MIN_INTERVAL_MS = 1000;

type ScheduleKind = "manual" | "interval";

interface CreateLoopDialogProps {
  open: boolean;
  onClose: () => void;
  slug: string;
  onCreated: (loopId: string) => void;
}

interface CreateLoopFormProps {
  slug: string;
  onCreated: (loopId: string) => void;
  onClose?: () => void;
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

type ConditionKind = DoneCondition["kind"];

const CONDITION_KINDS: { kind: ConditionKind; label: string }[] = [
  { kind: "file_exists", label: "File exists" },
  { kind: "grep_contains", label: "Grep contains" },
  { kind: "grep_empty", label: "Grep empty" },
  { kind: "command_succeeds", label: "Command succeeds" },
  { kind: "tests_pass", label: "Tests pass" },
  { kind: "typecheck_pass", label: "Typecheck passes" },
  { kind: "lsp_clean", label: "LSP clean" },
  { kind: "user_confirmed", label: "User confirmed" },
];

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

function validateCondition(condition: DoneCondition): string[] {
  const errors: string[] = [];
  switch (condition.kind) {
    case "file_exists":
      if (!isNonEmpty(condition.params.path)) errors.push("path is required");
      break;
    case "grep_contains":
      if (!isNonEmpty(condition.params.pattern)) errors.push("pattern is required");
      break;
    case "grep_empty":
      if (!isNonEmpty(condition.params.pattern)) errors.push("pattern is required");
      break;
    case "command_succeeds":
      if (!isNonEmpty(condition.params.command)) errors.push("command is required");
      break;
    case "user_confirmed":
      if (!isNonEmpty(condition.params.prompt)) errors.push("prompt is required");
      break;
    case "spec_compliance":
      if (!isNonEmpty(condition.params.specPath)) errors.push("specPath is required");
      break;
    case "tests_pass":
    case "typecheck_pass":
    case "lsp_clean":
      break;
  }
  return errors;
}

function sanitizeCondition(condition: DoneCondition): DoneCondition {
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
  const params = condition.params as Record<string, unknown>;
  return { ...condition, params: { ...params, [key]: value } } as unknown as DoneCondition;
}

function conditionParamValue(condition: DoneCondition, key: string): unknown {
  return (condition.params as Record<string, unknown>)[key];
}

export interface LoopFormState {
  title: string;
  description: string;
  scheduleKind: ScheduleKind;
  everyMs: number;
  runKind: LoopRunKind;
  mode: LoopMode;
  approvalPolicy: LoopApprovalPolicy;
  maxIterationsPerRun: number;
  taskPrompt: string;
  instructions: string;
  goalTitle: string;
  goalAuthor: string;
  goalPrompt: string;
  goalInstructions: string;
  goalConditions: DoneCondition[];
  goalMaxRetries: number;
  goalEscalateOnFailure: boolean;
  goalApprovalPoints: ApprovalPoint[];
  goalReviewerAgent: string;
}

export function buildLoopConfig(state: LoopFormState): LoopConfig {
  const trimmedTitle = state.title.trim();
  const schedule: LoopScheduleSpec =
    state.scheduleKind === "interval" ? { kind: "interval", everyMs: state.everyMs } : { kind: "manual" };

  const config: LoopConfig = {
    title: trimmedTitle,
    ...(isNonEmpty(state.description) ? { description: state.description.trim() } : {}),
    schedule,
    runKind: state.runKind,
    mode: state.mode,
    approvalPolicy: state.approvalPolicy,
    limits: { maxIterationsPerRun: state.maxIterationsPerRun },
    ...(isNonEmpty(state.taskPrompt) ? { taskPrompt: state.taskPrompt.trim() } : {}),
    ...(isNonEmpty(state.instructions) ? { instructions: state.instructions.trim() } : {}),
  };

  if (state.runKind === "goal") {
    config.goalTemplate = {
      title: state.goalTitle.trim(),
      author: state.goalAuthor.trim() || "architect",
      doneConditions: state.goalConditions.map(sanitizeCondition),
      retryPolicy: {
        maxRetries: state.goalMaxRetries,
        backoffMs: DEFAULT_RETRY_POLICY.backoffMs,
        escalateOnFailure: state.goalEscalateOnFailure,
      },
      approvalPoints: state.goalApprovalPoints,
      reviewerAgent: state.goalReviewerAgent.trim() || "reviewer",
      ...(isNonEmpty(state.goalPrompt) ? { prompt: state.goalPrompt.trim() } : {}),
      ...(isNonEmpty(state.goalInstructions) ? { instructions: state.goalInstructions.trim() } : {}),
    };
  }

  return config;
}

export function CreateLoopForm({ slug, onCreated, onClose }: CreateLoopFormProps) {
  const createLoop = useCreateLoop();

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [runKind, setRunKind] = useState<LoopRunKind>("session");
  const [scheduleKind, setScheduleKind] = useState<ScheduleKind>("manual");
  const [everyMs, setEveryMs] = useState(60000);
  const [mode, setMode] = useState<LoopMode>("report");
  const [approvalPolicy, setApprovalPolicy] = useState<LoopApprovalPolicy>("interactive");
  const [maxIterationsPerRun, setMaxIterationsPerRun] = useState(8);
  const [taskPrompt, setTaskPrompt] = useState("");
  const [instructions, setInstructions] = useState("");
  const [author, setAuthor] = useState("architect");

  const [goalTitle, setGoalTitle] = useState("");
  const [goalAuthor, setGoalAuthor] = useState("architect");
  const [goalPrompt, setGoalPrompt] = useState("");
  const [goalInstructions, setGoalInstructions] = useState("");
  const [goalConditions, setGoalConditions] = useState<DoneCondition[]>([]);
  const [goalMaxRetries, setGoalMaxRetries] = useState(2);
  const [goalEscalateOnFailure, setGoalEscalateOnFailure] = useState(true);
  const [goalApprovalPoints, setGoalApprovalPoints] = useState<ApprovalPoint[]>([
    "after_plan",
    "before_complete",
  ]);
  const [goalReviewerAgent, setGoalReviewerAgent] = useState("reviewer");

  const trimmedTitle = title.trim();
  const intervalValid = scheduleKind !== "interval" || (Number.isInteger(everyMs) && everyMs >= MIN_INTERVAL_MS);
  const goalConditionsValid =
    runKind !== "goal" ||
    (goalConditions.length > 0 && goalConditions.every((c) => validateCondition(c).length === 0));
  const goalTitleValid = runKind !== "goal" || isNonEmpty(goalTitle);
  const canSubmit =
    isNonEmpty(trimmedTitle) &&
    intervalValid &&
    goalConditionsValid &&
    goalTitleValid &&
    !createLoop.isPending;

  const addCondition = useCallback((kind: ConditionKind) => {
    setGoalConditions((prev) => [...prev, makeCondition(kind)]);
  }, []);

  const removeCondition = useCallback((id: string) => {
    setGoalConditions((prev) => prev.filter((c) => c.id !== id));
  }, []);

  const updateConditionParam = useCallback(
    (id: string, key: string, value: string | number | string[]) => {
      setGoalConditions((prev) =>
        prev.map((c) => (c.id === id ? updateConditionParamValue(c, key, value) : c)),
      );
    },
    [],
  );

  const toggleApprovalPoint = useCallback((point: ApprovalPoint) => {
    setGoalApprovalPoints((prev) =>
      prev.includes(point) ? prev.filter((p) => p !== point) : [...prev, point],
    );
  }, []);

  const buildConfig = useCallback((): LoopConfig => {
    return buildLoopConfig({
      title,
      description,
      scheduleKind,
      everyMs,
      runKind,
      mode,
      approvalPolicy,
      maxIterationsPerRun,
      taskPrompt,
      instructions,
      goalTitle,
      goalAuthor,
      goalPrompt,
      goalInstructions,
      goalConditions,
      goalMaxRetries,
      goalEscalateOnFailure,
      goalApprovalPoints,
      goalReviewerAgent,
    });
  }, [
    title,
    description,
    scheduleKind,
    everyMs,
    runKind,
    mode,
    approvalPolicy,
    maxIterationsPerRun,
    taskPrompt,
    instructions,
    goalTitle,
    goalAuthor,
    goalPrompt,
    goalInstructions,
    goalConditions,
    goalMaxRetries,
    goalEscalateOnFailure,
    goalApprovalPoints,
    goalReviewerAgent,
  ]);

  const handleSubmit = useCallback(
    (e: { preventDefault: () => void }) => {
      e.preventDefault();
      if (!canSubmit) return;

      const config = buildConfig();
      createLoop.mutate(
        {
          slug,
          config,
          ...(isNonEmpty(author) ? { author: author.trim() } : {}),
        },
        {
          onSuccess: (response) => {
            onCreated(response.loop.loopId);
          },
        },
      );
    },
    [canSubmit, buildConfig, createLoop, slug, author, onCreated],
  );

  const handlePresetClick = useCallback(
    (preset: PresetQuickStart) => {
      if (!preset.enabled || createLoop.isPending) return;
      createLoop.mutate(
        { slug, presetId: preset.id, ...(isNonEmpty(author) ? { author: author.trim() } : {}) },
        {
          onSuccess: (response) => {
            onCreated(response.loop.loopId);
          },
        },
      );
    },
    [createLoop, slug, author, onCreated],
  );

  const errorMessage = createLoop.error
    ? createLoop.error instanceof Error
      ? createLoop.error.message
      : "Failed to create loop"
    : null;

  return (
    <form onSubmit={handleSubmit} className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border-subtle px-5 py-4 shrink-0">
        <span className="text-base font-semibold text-text-primary">
          New Loop
        </span>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
            <section>
              <span className="mb-2 block text-[13px] font-medium text-text-secondary">
                Quick Starts
              </span>
              <div className="flex flex-wrap gap-1.5">
                {PRESET_QUICK_STARTS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => handlePresetClick(preset)}
                    disabled={!preset.enabled || createLoop.isPending}
                    aria-label={`Preset ${preset.label}`}
                    className="inline-flex items-center gap-1 rounded-sm border border-border-subtle bg-bg-base px-2.5 py-1.5 text-[12px] text-text-secondary transition-colors duration-150 hover:bg-bg-hover hover:text-text-primary disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {preset.label}
                    {!preset.enabled && preset.phaseLabel ? (
                      <span className="text-[10px] text-text-muted">{preset.phaseLabel}</span>
                    ) : null}
                  </button>
                ))}
              </div>
            </section>

            <div>
              <label
                htmlFor="new-loop-title"
                className="mb-1.5 block text-[13px] font-medium text-text-secondary"
              >
                Title
              </label>
              <input
                id="new-loop-title"
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Loop title"
                className="w-full rounded-sm border border-border-default bg-bg-base px-3 py-2 text-[13px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none transition-colors duration-150"
                autoFocus
                disabled={createLoop.isPending}
              />
            </div>

            <div>
              <label
                htmlFor="new-loop-description"
                className="mb-1.5 block text-[13px] font-medium text-text-secondary"
              >
                Description <span className="text-text-muted">(optional)</span>
              </label>
              <input
                id="new-loop-description"
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Short description"
                className="w-full rounded-sm border border-border-default bg-bg-base px-3 py-2 text-[13px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none transition-colors duration-150"
                disabled={createLoop.isPending}
              />
            </div>

            <div>
              <span className="mb-2 block text-[13px] font-medium text-text-secondary">
                Run Kind
              </span>
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2 text-[12.5px] text-text-secondary">
                  <input
                    type="radio"
                    name="loop-run-kind"
                    value="session"
                    checked={runKind === "session"}
                    onChange={() => setRunKind("session")}
                    disabled={createLoop.isPending}
                    className="accent-accent"
                  />
                  <span>session</span>
                </label>
                <label className="flex items-center gap-2 text-[12.5px] text-text-secondary">
                  <input
                    type="radio"
                    name="loop-run-kind"
                    value="goal"
                    checked={runKind === "goal"}
                    onChange={() => setRunKind("goal")}
                    disabled={createLoop.isPending}
                    className="accent-accent"
                  />
                  <span>goal</span>
                </label>
              </div>
            </div>

            <div>
              <span className="mb-2 block text-[13px] font-medium text-text-secondary">
                Schedule
              </span>
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2 text-[12.5px] text-text-secondary">
                  <input
                    type="radio"
                    name="loop-schedule"
                    value="manual"
                    checked={scheduleKind === "manual"}
                    onChange={() => setScheduleKind("manual")}
                    disabled={createLoop.isPending}
                    className="accent-accent"
                  />
                  <span>manual</span>
                </label>
                <label className="flex items-center gap-2 text-[12.5px] text-text-secondary">
                  <input
                    type="radio"
                    name="loop-schedule"
                    value="interval"
                    checked={scheduleKind === "interval"}
                    onChange={() => setScheduleKind("interval")}
                    disabled={createLoop.isPending}
                    className="accent-accent"
                  />
                  <span>interval</span>
                </label>
                {scheduleKind === "interval" && (
                  <label className="flex items-center gap-2 text-[12.5px] text-text-secondary">
                    <span>everyMs</span>
                    <input
                      id="new-loop-every-ms"
                      type="number"
                      min={MIN_INTERVAL_MS}
                      value={everyMs}
                      onChange={(e) => setEveryMs(Number(e.target.value) || 0)}
                      disabled={createLoop.isPending}
                      className="w-28 rounded-sm border border-border-default bg-bg-base px-2 py-1 text-[12.5px] text-text-primary focus:border-accent focus:outline-none"
                    />
                  </label>
                )}
              </div>
              {scheduleKind === "interval" && !intervalValid && (
                <p className="mt-1 text-[11px] text-error">
                  everyMs must be a positive integer of at least {MIN_INTERVAL_MS} ms.
                </p>
              )}
            </div>

            <div>
              <span className="mb-2 block text-[13px] font-medium text-text-secondary">
                Mode
              </span>
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2 text-[12.5px] text-text-secondary">
                  <input
                    type="radio"
                    name="loop-mode"
                    value="report"
                    checked={mode === "report"}
                    onChange={() => setMode("report")}
                    disabled={createLoop.isPending}
                    className="accent-accent"
                  />
                  <span>report</span>
                </label>
                <label className="flex items-center gap-2 text-[12.5px] text-text-secondary">
                  <input
                    type="radio"
                    name="loop-mode"
                    value="act"
                    checked={mode === "act"}
                    onChange={() => setMode("act")}
                    disabled={createLoop.isPending}
                    className="accent-accent"
                  />
                  <span>act</span>
                </label>
              </div>
              <p className="mt-1 text-[11px] text-text-muted">
                {mode === "report"
                  ? "report: the Loop produces a report only; no file edits or side effects."
                  : "act: the Loop may perform write actions and run effectful tools."}
              </p>
            </div>

            <div>
              <span className="mb-2 block text-[13px] font-medium text-text-secondary">
                Approval Policy
              </span>
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2 text-[12.5px] text-text-secondary">
                  <input
                    type="radio"
                    name="loop-approval-policy"
                    value="interactive"
                    checked={approvalPolicy === "interactive"}
                    onChange={() => setApprovalPolicy("interactive")}
                    disabled={createLoop.isPending}
                    className="accent-accent"
                  />
                  <span>interactive</span>
                </label>
                <label className="flex items-center gap-2 text-[12.5px] text-text-secondary">
                  <input
                    type="radio"
                    name="loop-approval-policy"
                    value="explicit_per_run"
                    checked={approvalPolicy === "explicit_per_run"}
                    onChange={() => setApprovalPolicy("explicit_per_run")}
                    disabled={createLoop.isPending}
                    className="accent-accent"
                  />
                  <span>explicit_per_run</span>
                </label>
              </div>
              <p className="mt-1 text-[11px] text-text-muted">
                {approvalPolicy === "interactive"
                  ? "interactive: approvals follow the normal interactive HITL flow."
                  : "explicit_per_run: each run requires an explicit approval before it starts."}
              </p>
            </div>

            <div>
              <label
                htmlFor="new-loop-max-iterations"
                className="mb-1.5 block text-[13px] font-medium text-text-secondary"
              >
                Max Iterations Per Run
              </label>
              <input
                id="new-loop-max-iterations"
                type="number"
                min={1}
                value={maxIterationsPerRun}
                onChange={(e) => setMaxIterationsPerRun(Number(e.target.value) || 0)}
                disabled={createLoop.isPending}
                className="w-28 rounded-sm border border-border-default bg-bg-base px-2 py-1.5 text-[12.5px] text-text-primary focus:border-accent focus:outline-none"
              />
            </div>

            {runKind === "session" && (
              <div>
                <label
                  htmlFor="new-loop-task-prompt"
                  className="mb-1.5 block text-[13px] font-medium text-text-secondary"
                >
                  Task Prompt <span className="text-text-muted">(optional)</span>
                </label>
                <textarea
                  id="new-loop-task-prompt"
                  value={taskPrompt}
                  onChange={(e) => setTaskPrompt(e.target.value)}
                  placeholder="Instructions for each session run"
                  rows={3}
                  disabled={createLoop.isPending}
                  className="w-full rounded-sm border border-border-default bg-bg-base px-3 py-2 text-[13px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none transition-colors duration-150"
                />
              </div>
            )}

            <div>
              <label
                htmlFor="new-loop-instructions"
                className="mb-1.5 block text-[13px] font-medium text-text-secondary"
              >
                Instructions <span className="text-text-muted">(optional)</span>
              </label>
              <input
                id="new-loop-instructions"
                type="text"
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                placeholder="Extra run instructions"
                className="w-full rounded-sm border border-border-default bg-bg-base px-3 py-2 text-[13px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none transition-colors duration-150"
                disabled={createLoop.isPending}
              />
            </div>

            {runKind === "goal" && (
              <section className="rounded-sm border border-border-subtle p-3 space-y-4">
                <div className="text-[13px] font-medium text-text-secondary">
                  Goal Template (inline)
                </div>
                <p className="text-[11px] text-text-muted">
                  Each run creates a fresh draft Goal from these inline fields. No existing Goal selector.
                </p>

                <div>
                  <label
                    htmlFor="new-loop-goal-title"
                    className="mb-1.5 block text-[13px] font-medium text-text-secondary"
                  >
                    Goal Title
                  </label>
                  <input
                    id="new-loop-goal-title"
                    type="text"
                    value={goalTitle}
                    onChange={(e) => setGoalTitle(e.target.value)}
                    placeholder="Goal title"
                    className="w-full rounded-sm border border-border-default bg-bg-base px-3 py-2 text-[13px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none transition-colors duration-150"
                    disabled={createLoop.isPending}
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label
                      htmlFor="new-loop-goal-author"
                      className="mb-1.5 block text-[13px] font-medium text-text-secondary"
                    >
                      Goal Author
                    </label>
                    <input
                      id="new-loop-goal-author"
                      type="text"
                      value={goalAuthor}
                      onChange={(e) => setGoalAuthor(e.target.value)}
                      disabled={createLoop.isPending}
                      className="w-full rounded-sm border border-border-default bg-bg-base px-3 py-2 text-[13px] text-text-primary focus:border-accent focus:outline-none transition-colors duration-150"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="new-loop-goal-reviewer"
                      className="mb-1.5 block text-[13px] font-medium text-text-secondary"
                    >
                      Reviewer agent
                    </label>
                    <input
                      id="new-loop-goal-reviewer"
                      type="text"
                      value={goalReviewerAgent}
                      onChange={(e) => setGoalReviewerAgent(e.target.value)}
                      disabled={createLoop.isPending}
                      className="w-full rounded-sm border border-border-default bg-bg-base px-3 py-2 text-[13px] text-text-primary focus:border-accent focus:outline-none transition-colors duration-150"
                    />
                  </div>
                </div>

                <div>
                  <label
                    htmlFor="new-loop-goal-prompt"
                    className="mb-1.5 block text-[13px] font-medium text-text-secondary"
                  >
                    Goal Prompt <span className="text-text-muted">(optional)</span>
                  </label>
                  <textarea
                    id="new-loop-goal-prompt"
                    value={goalPrompt}
                    onChange={(e) => setGoalPrompt(e.target.value)}
                    placeholder="Bootstrap prompt for each Goal run"
                    rows={2}
                    disabled={createLoop.isPending}
                    className="w-full rounded-sm border border-border-default bg-bg-base px-3 py-2 text-[13px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none transition-colors duration-150"
                  />
                </div>

                <div>
                  <label
                    htmlFor="new-loop-goal-instructions"
                    className="mb-1.5 block text-[13px] font-medium text-text-secondary"
                  >
                    Goal Instructions <span className="text-text-muted">(optional)</span>
                  </label>
                  <input
                    id="new-loop-goal-instructions"
                    type="text"
                    value={goalInstructions}
                    onChange={(e) => setGoalInstructions(e.target.value)}
                    disabled={createLoop.isPending}
                    className="w-full rounded-sm border border-border-default bg-bg-base px-3 py-2 text-[13px] text-text-primary focus:border-accent focus:outline-none transition-colors duration-150"
                  />
                </div>

                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-[13px] font-medium text-text-secondary">
                      Done Conditions
                    </span>
                    <span className="text-[11px] text-text-muted">
                      {goalConditions.length} added
                    </span>
                  </div>

                  <div className="flex flex-wrap gap-1.5 mb-3">
                    {CONDITION_KINDS.map(({ kind, label }) => (
                      <button
                        key={kind}
                        type="button"
                        onClick={() => addCondition(kind)}
                        disabled={createLoop.isPending}
                        className="inline-flex items-center gap-1 rounded-sm border border-border-subtle bg-bg-base px-2 py-1 text-[11.5px] text-text-secondary transition-colors duration-150 hover:bg-bg-hover hover:text-text-primary disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        {label}
                      </button>
                    ))}
                  </div>

                  {goalConditions.length === 0 ? (
                    <div className="rounded-sm border border-dashed border-border-subtle px-3 py-6 text-center text-[12px] text-text-muted">
                      Add at least one done condition to define when the Goal is complete.
                    </div>
                  ) : (
                    <ul className="space-y-2">
                      {goalConditions.map((condition) => {
                        const errors = validateCondition(condition);
                        return (
                          <GoalConditionRow
                            key={condition.id}
                            condition={condition}
                            errors={errors}
                            disabled={createLoop.isPending}
                            onRemove={() => removeCondition(condition.id)}
                            onParamChange={(key, value) =>
                              updateConditionParam(condition.id, key, value)
                            }
                          />
                        );
                      })}
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
                        value={goalMaxRetries}
                        onChange={(e) => setGoalMaxRetries(Number(e.target.value) || 0)}
                        disabled={createLoop.isPending}
                        className="w-20 rounded-sm border border-border-default bg-bg-base px-2 py-1 text-[12.5px] text-text-primary focus:border-accent focus:outline-none"
                      />
                    </label>
                    <label className="flex items-center gap-2 text-[12.5px] text-text-secondary">
                      <input
                        type="checkbox"
                        checked={goalEscalateOnFailure}
                        onChange={(e) => setGoalEscalateOnFailure(e.target.checked)}
                        disabled={createLoop.isPending}
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
                          checked={goalApprovalPoints.includes(point)}
                          onChange={() => toggleApprovalPoint(point)}
                          disabled={createLoop.isPending}
                          className="accent-accent"
                        />
                        <span className="font-mono">{point}</span>
                      </label>
                    ))}
                  </div>
                </div>
              </section>
            )}

            <div>
              <label
                htmlFor="new-loop-author"
                className="mb-1.5 block text-[13px] font-medium text-text-secondary"
              >
                Author
              </label>
              <input
                id="new-loop-author"
                type="text"
                value={author}
                onChange={(e) => setAuthor(e.target.value)}
                disabled={createLoop.isPending}
                className="w-full rounded-sm border border-border-default bg-bg-base px-3 py-2 text-[13px] text-text-primary focus:border-accent focus:outline-none transition-colors duration-150"
              />
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
              disabled={createLoop.isPending}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="rounded-sm bg-accent px-4 py-2 text-[13px] font-medium text-bg-base transition-colors duration-150 hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
              disabled={!canSubmit}
            >
              {createLoop.isPending ? "Creating…" : "Create Loop"}
            </button>
          </div>
        </form>
  );
}

export function CreateLoopDialog({ open, onClose, slug, onCreated }: CreateLoopDialogProps) {
  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) onClose();
    },
    [onClose],
  );

  return (
    <DialogRoot open={open} onOpenChange={handleOpenChange}>
      <DialogContent size="x-large">
        <DialogTitle className="sr-only">New Loop</DialogTitle>
        <DialogDescription className="sr-only">
          Create a new Loop with schedule, run kind, mode, and approval policy
        </DialogDescription>
        <CreateLoopForm slug={slug} onCreated={onCreated} onClose={onClose} />
      </DialogContent>
    </DialogRoot>
  );
}

interface GoalConditionRowProps {
  condition: DoneCondition;
  errors: string[];
  disabled: boolean;
  onRemove: () => void;
  onParamChange: (key: string, value: string | number | string[]) => void;
}

const GOAL_PARAM_FIELDS: Partial<Record<ConditionKind, { key: string; label: string; type: "text" | "number" }[]>> = {
  file_exists: [{ key: "path", label: "path", type: "text" }],
  grep_contains: [
    { key: "pattern", label: "pattern", type: "text" },
    { key: "path", label: "path", type: "text" },
    { key: "minMatches", label: "minMatches", type: "number" },
  ],
  grep_empty: [
    { key: "pattern", label: "pattern", type: "text" },
    { key: "path", label: "path", type: "text" },
  ],
  command_succeeds: [
    { key: "command", label: "command", type: "text" },
    { key: "timeoutMs", label: "timeoutMs", type: "number" },
  ],
  tests_pass: [{ key: "command", label: "command", type: "text" }],
  typecheck_pass: [{ key: "command", label: "command", type: "text" }],
  user_confirmed: [{ key: "prompt", label: "prompt", type: "text" }],
  spec_compliance: [{ key: "specPath", label: "specPath", type: "text" }],
};

function GoalConditionRow({
  condition,
  errors,
  disabled,
  onRemove,
  onParamChange,
}: GoalConditionRowProps) {
  const fields = GOAL_PARAM_FIELDS[condition.kind] ?? [];

  return (
    <li className="rounded-sm border border-border-subtle bg-bg-base px-3 py-2.5">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[12.5px] font-mono font-medium text-text-primary">
          {condition.kind}
        </span>
        <button
          type="button"
          onClick={onRemove}
          disabled={disabled}
          aria-label="Remove condition"
          className="flex h-5 w-5 items-center justify-center rounded-sm text-text-muted transition-colors duration-150 hover:bg-bg-hover hover:text-error disabled:opacity-40"
        >
          x
        </button>
      </div>
      {fields.length > 0 && (
        <div className="grid grid-cols-2 gap-2">
          {fields.map((field) => (
            <label key={field.key} className="flex flex-col gap-1">
              <span className="text-[11px] text-text-muted font-mono">{field.label}</span>
              <input
                type={field.type}
                value={
                  field.type === "number"
                    ? typeof conditionParamValue(condition, field.key) === "number"
                      ? Number(conditionParamValue(condition, field.key))
                      : ""
                    : typeof conditionParamValue(condition, field.key) === "string"
                      ? (conditionParamValue(condition, field.key) as string)
                      : ""
                }
                onChange={(e) =>
                  onParamChange(
                    field.key,
                    field.type === "number" ? Number(e.target.value) || 0 : e.target.value,
                  )
                }
                disabled={disabled}
                className="rounded-sm border border-border-subtle bg-bg-base px-2 py-1.5 text-[12px] text-text-primary focus:border-accent focus:outline-none"
              />
            </label>
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