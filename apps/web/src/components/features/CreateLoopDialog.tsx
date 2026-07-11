import { useState, useCallback } from "react";
import {
  DialogRoot,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "../ui/Dialog";
import { useCreateLoop, useUpdateLoop } from "../../api/mutations";
import type {
  CreateLoopPayload,
  LoopApprovalPolicy,
  LoopBudgetConfig,
  LoopConfig,
  LoopScheduleSpec,
  LoopState,
  LoopTemplateId,
} from "../../api/types";

interface LoopTemplateOption {
  id: LoopTemplateId;
  label: string;
  note: string;
  description: string;
  defaultTaskPrompt: string;
  defaultApprovalPolicy: LoopApprovalPolicy;
  defaultBudget: LoopBudgetConfig;
}

const DEFAULT_BUDGET: LoopBudgetConfig = {
  maxIterationsPerRun: 8,
  maxTokensPerRun: 120000,
  maxWallClockMsPerRun: 15 * 60_000,
  maxRunsPerDay: 2,
  softThresholdRatio: 0.8,
  hardThresholdRatio: 1,
};

const LOOP_TEMPLATES: LoopTemplateOption[] = [
  {
    id: "watch_report",
    label: "Watch & Report",
    note: "Read-only project report",
    description: "Inspect local project health and summarize issues without repository changes.",
    defaultTaskPrompt: "Run local project triage and summarize status, failures, stale work, and next steps.",
    defaultApprovalPolicy: "interactive",
    defaultBudget: { ...DEFAULT_BUDGET },
  },
  {
    id: "maintain_fix",
    label: "Maintain & Fix",
    note: "Scoped maintenance pass",
    description: "Run a scoped maintenance pass and apply safe local fixes.",
    defaultTaskPrompt: "Identify one narrowly bounded issue, make the minimal fix, and record verification output.",
    defaultApprovalPolicy: "explicit_per_run",
    defaultBudget: { ...DEFAULT_BUDGET, maxIterationsPerRun: 16, maxTokensPerRun: 200000, maxWallClockMsPerRun: 30 * 60_000 },
  },
  {
    id: "pr_babysitter",
    label: "PR Babysitter",
    note: "GitHub.com PR status and comments",
    description: "Watch PR status, comments, and checks, then report useful next steps.",
    defaultTaskPrompt: "Watch configured PRs, summarize status and comments, draft a status comment only when useful and allowed, and propose an optional fix Goal for small scoped repairs.",
    defaultApprovalPolicy: "interactive",
    defaultBudget: { ...DEFAULT_BUDGET, maxIterationsPerRun: 12, maxTokensPerRun: 160000, maxWallClockMsPerRun: 20 * 60_000, maxRunsPerDay: 4 },
  },
  {
    id: "goal_runner",
    label: "Goal Runner",
    note: "Recurring Goal execution",
    description: "Create and run a recurring Goal from natural-language fields.",
    defaultTaskPrompt: "",
    defaultApprovalPolicy: "explicit_per_run",
    defaultBudget: { ...DEFAULT_BUDGET, maxIterationsPerRun: 20, maxTokensPerRun: 240000, maxWallClockMsPerRun: 45 * 60_000, maxRunsPerDay: 2 },
  },
];

const MIN_INTERVAL_MS = 1000;

type ScheduleKind = "manual" | "interval" | "cron";

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
  initialState?: Partial<LoopFormState>;
}

interface LoopFormProps {
  slug: string;
  title: string;
  description: string;
  submitLabel: string;
  pendingLabel: string;
  pending: boolean;
  error: unknown;
  onClose?: () => void;
  onSubmitPayload: (payload: CreateLoopPayload) => void;
  initialState?: Partial<LoopFormState>;
  showQuickStarts?: boolean;
}

interface EditLoopDialogProps {
  open: boolean;
  onClose: () => void;
  slug: string;
  loop: LoopState;
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export interface LoopFormState {
  templateId: LoopTemplateId;
  scheduleKind: ScheduleKind;
  everyMs: number;
  cronExpression: string;
  approvalPolicy: LoopApprovalPolicy;
  maxIterationsPerRun: number;
  maxTokensPerRun: number;
  maxWallClockMinutesPerRun: number;
  maxRunsPerDay: number;
  maxEstimatedUsdPerRun?: number;
  taskPrompt: string;
  useWorktree: boolean;
  goalObjective: string;
  goalAcceptanceCriteria: string;
}

function buildBudgetConfig(state: LoopFormState): LoopBudgetConfig {
  return {
    maxIterationsPerRun: state.maxIterationsPerRun,
    ...(isPositiveInt(state.maxTokensPerRun) ? { maxTokensPerRun: state.maxTokensPerRun } : {}),
    ...(state.maxEstimatedUsdPerRun !== undefined && state.maxEstimatedUsdPerRun > 0
      ? { maxEstimatedUsdPerRun: state.maxEstimatedUsdPerRun }
      : {}),
    ...(isPositiveInt(state.maxWallClockMinutesPerRun)
      ? { maxWallClockMsPerRun: state.maxWallClockMinutesPerRun * 60_000 }
      : {}),
    ...(isPositiveInt(state.maxRunsPerDay) ? { maxRunsPerDay: state.maxRunsPerDay } : {}),
    softThresholdRatio: DEFAULT_BUDGET.softThresholdRatio,
    hardThresholdRatio: DEFAULT_BUDGET.hardThresholdRatio,
  };
}

function buildSchedule(state: LoopFormState): LoopScheduleSpec {
  return state.scheduleKind === "interval"
    ? { kind: "interval", everyMs: state.everyMs }
    : state.scheduleKind === "cron"
      ? { kind: "cron", expression: state.cronExpression.trim() }
      : { kind: "manual" };
}

function buildGoalTemplate(state: LoopFormState): CreateLoopPayload["goalTemplate"] | undefined {
  if (state.templateId !== "goal_runner") return undefined;
  return {
    objective: state.goalObjective.trim(),
    acceptanceCriteria: state.goalAcceptanceCriteria.trim(),
  };
}

export function buildCreatePayload(state: LoopFormState): CreateLoopPayload {
  const payload: CreateLoopPayload = {
    templateId: state.templateId,
    schedule: buildSchedule(state),
    approvalPolicy: state.approvalPolicy,
    limits: buildBudgetConfig(state),
    useWorktree: state.useWorktree,
  };

  if (isNonEmpty(state.taskPrompt)) payload.taskPrompt = state.taskPrompt.trim();

  const goalTemplate = buildGoalTemplate(state);
  if (goalTemplate) payload.goalTemplate = goalTemplate;

  return payload;
}

export function buildLoopConfig(state: LoopFormState): LoopConfig {
  const payload = buildCreatePayload(state);
  return {
    templateId: payload.templateId,
    title: null,
    schedule: payload.schedule,
    approvalPolicy: payload.approvalPolicy,
    limits: payload.limits,
    useWorktree: payload.useWorktree,
    ...(payload.taskPrompt ? { taskPrompt: payload.taskPrompt } : {}),
    ...(payload.goalTemplate ? { goalTemplate: { title: null, ...payload.goalTemplate } } : {}),
  };
}

function loopConfigToFormState(config: LoopConfig): Partial<LoopFormState> {
  const budget = config.limits;
  const scheduleKind: ScheduleKind = config.schedule.kind;
  const wallClockMs = "maxWallClockMsPerRun" in budget ? budget.maxWallClockMsPerRun : undefined;
  const maxTokensPerRun = "maxTokensPerRun" in budget ? budget.maxTokensPerRun : undefined;
  const maxRunsPerDay = "maxRunsPerDay" in budget ? budget.maxRunsPerDay : undefined;
  const maxEstimatedUsdPerRun = "maxEstimatedUsdPerRun" in budget ? budget.maxEstimatedUsdPerRun : undefined;
  const goalTemplate = config.goalTemplate;

  return {
    scheduleKind,
    everyMs: config.schedule.kind === "interval" ? config.schedule.everyMs : 60000,
    cronExpression: config.schedule.kind === "cron" ? config.schedule.expression : "*/15 * * * *",
    templateId: config.templateId,
    approvalPolicy: config.approvalPolicy,
    maxIterationsPerRun: budget.maxIterationsPerRun,
    maxTokensPerRun: maxTokensPerRun ?? DEFAULT_BUDGET.maxTokensPerRun ?? 120000,
    maxWallClockMinutesPerRun: wallClockMs === undefined ? 15 : Math.max(1, Math.round(wallClockMs / 60_000)),
    maxRunsPerDay: maxRunsPerDay ?? DEFAULT_BUDGET.maxRunsPerDay ?? 2,
    maxEstimatedUsdPerRun,
    taskPrompt: config.taskPrompt ?? "",
    useWorktree: config.useWorktree === true,
    goalObjective: goalTemplate?.objective ?? "",
    goalAcceptanceCriteria: goalTemplate?.acceptanceCriteria ?? "",
  };
}

function applyTemplate(
  template: LoopTemplateOption,
  setters: {
    setTemplateId: (value: LoopTemplateId) => void;
    setApprovalPolicy: (value: LoopApprovalPolicy) => void;
    setMaxIterationsPerRun: (value: number) => void;
    setMaxTokensPerRun: (value: number) => void;
    setMaxWallClockMinutesPerRun: (value: number) => void;
    setMaxRunsPerDay: (value: number) => void;
    setMaxEstimatedUsdPerRun: (value: number | undefined) => void;
    setTaskPrompt: (value: string) => void;
    setGoalObjective: (value: string) => void;
    setGoalAcceptanceCriteria: (value: string) => void;
  },
): void {
  setters.setTemplateId(template.id);
  setters.setApprovalPolicy(template.defaultApprovalPolicy);
  setters.setMaxIterationsPerRun(template.defaultBudget.maxIterationsPerRun);
  setters.setMaxTokensPerRun(template.defaultBudget.maxTokensPerRun ?? DEFAULT_BUDGET.maxTokensPerRun ?? 0);
  setters.setMaxWallClockMinutesPerRun(
    Math.round((template.defaultBudget.maxWallClockMsPerRun ?? DEFAULT_BUDGET.maxWallClockMsPerRun ?? 0) / 60_000),
  );
  setters.setMaxRunsPerDay(template.defaultBudget.maxRunsPerDay ?? DEFAULT_BUDGET.maxRunsPerDay ?? 0);
  setters.setMaxEstimatedUsdPerRun(template.defaultBudget.maxEstimatedUsdPerRun);
  setters.setTaskPrompt(template.defaultTaskPrompt);
  setters.setGoalObjective("");
  setters.setGoalAcceptanceCriteria("");
}

export function CreateLoopForm({ slug, onCreated, onClose, initialState }: CreateLoopFormProps) {
  const createLoop = useCreateLoop();

  const handleSubmitPayload = useCallback(
    (payload: CreateLoopPayload) => {
      createLoop.mutate(
        { slug, ...payload },
        {
          onSuccess: (response) => {
            onCreated(response.loop.loopId);
          },
        },
      );
    },
    [createLoop, slug, onCreated],
  );

  return (
    <LoopForm
      slug={slug}
      title="New Loop"
      description="Create a new Loop from a template with schedule, budget, and task or Goal fields"
      submitLabel="Create Loop"
      pendingLabel="Creating…"
      pending={createLoop.isPending}
      error={createLoop.error}
      onClose={onClose}
      onSubmitPayload={handleSubmitPayload}
      initialState={initialState}
      showQuickStarts
    />
  );
}

export function LoopForm({
  title: formTitle,
  description: formDescription,
  submitLabel,
  pendingLabel,
  pending,
  error,
  onClose,
  onSubmitPayload,
  initialState,
  showQuickStarts = false,
}: LoopFormProps) {
  void formDescription;

  const [templateId, setTemplateId] = useState<LoopTemplateId>(initialState?.templateId ?? "watch_report");
  const [scheduleKind, setScheduleKind] = useState<ScheduleKind>(initialState?.scheduleKind ?? "manual");
  const [everyMs, setEveryMs] = useState(initialState?.everyMs ?? 60000);
  const [cronExpression, setCronExpression] = useState(initialState?.cronExpression ?? "*/15 * * * *");
  const [approvalPolicy, setApprovalPolicy] = useState<LoopApprovalPolicy>(initialState?.approvalPolicy ?? "interactive");
  const [maxIterationsPerRun, setMaxIterationsPerRun] = useState(initialState?.maxIterationsPerRun ?? 8);
  const [maxTokensPerRun, setMaxTokensPerRun] = useState(initialState?.maxTokensPerRun ?? 120000);
  const [maxWallClockMinutesPerRun, setMaxWallClockMinutesPerRun] = useState(initialState?.maxWallClockMinutesPerRun ?? 15);
  const [maxRunsPerDay, setMaxRunsPerDay] = useState(initialState?.maxRunsPerDay ?? 2);
  const [maxEstimatedUsdPerRun, setMaxEstimatedUsdPerRun] = useState<number | undefined>(initialState?.maxEstimatedUsdPerRun);
  const [taskPrompt, setTaskPrompt] = useState(initialState?.taskPrompt ?? "");
  const [useWorktree, setUseWorktree] = useState<boolean>(initialState?.useWorktree ?? false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [goalObjective, setGoalObjective] = useState(initialState?.goalObjective ?? "");
  const [goalAcceptanceCriteria, setGoalAcceptanceCriteria] = useState(initialState?.goalAcceptanceCriteria ?? "");

  const intervalValid = scheduleKind !== "interval" || (Number.isInteger(everyMs) && everyMs >= MIN_INTERVAL_MS);
  const cronValid = scheduleKind !== "cron" || isFiveFieldCronExpression(cronExpression);
  const budgetValid =
    isPositiveInt(maxIterationsPerRun) &&
    isPositiveInt(maxTokensPerRun) &&
    isPositiveInt(maxWallClockMinutesPerRun) &&
    isPositiveInt(maxRunsPerDay);
  const isGoalTemplate = templateId === "goal_runner";
  const taskPromptValid = isGoalTemplate || isNonEmpty(taskPrompt);
  const goalObjectiveValid = !isGoalTemplate || isNonEmpty(goalObjective);
  const goalAcceptanceValid = !isGoalTemplate || isNonEmpty(goalAcceptanceCriteria);
  const canSubmit =
    intervalValid &&
    cronValid &&
    budgetValid &&
    taskPromptValid &&
    goalObjectiveValid &&
    goalAcceptanceValid &&
    !pending;

  const buildState = useCallback(
    (): LoopFormState => ({
      scheduleKind,
      everyMs,
      cronExpression,
      templateId,
      approvalPolicy,
      maxIterationsPerRun,
      maxTokensPerRun,
      maxWallClockMinutesPerRun,
      maxRunsPerDay,
      maxEstimatedUsdPerRun,
      taskPrompt,
      useWorktree,
      goalObjective,
      goalAcceptanceCriteria,
    }),
    [
      scheduleKind,
      everyMs,
      cronExpression,
      templateId,
      approvalPolicy,
      maxIterationsPerRun,
      maxTokensPerRun,
      maxWallClockMinutesPerRun,
      maxRunsPerDay,
      maxEstimatedUsdPerRun,
      taskPrompt,
      useWorktree,
      goalObjective,
      goalAcceptanceCriteria,
    ],
  );

  const handleSubmit = useCallback(
    (e: { preventDefault: () => void }) => {
      e.preventDefault();
      if (!canSubmit) return;
      onSubmitPayload(buildCreatePayload(buildState()));
    },
    [canSubmit, buildState, onSubmitPayload],
  );

  const handleTemplateClick = useCallback(
    (template: LoopTemplateOption) => {
      if (pending) return;
      applyTemplate(template, {
        setTemplateId,
        setApprovalPolicy,
        setMaxIterationsPerRun,
        setMaxTokensPerRun,
        setMaxWallClockMinutesPerRun,
        setMaxRunsPerDay,
        setMaxEstimatedUsdPerRun,
        setTaskPrompt,
        setGoalObjective,
        setGoalAcceptanceCriteria,
      });
    },
    [pending],
  );

  const errorMessage = error
    ? error instanceof Error
      ? error.message
      : "Loop form action failed"
    : null;

  return (
    <form onSubmit={handleSubmit} className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border-subtle px-5 py-4 shrink-0">
        <span className="text-base font-semibold text-text-primary">
          {formTitle}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
        {showQuickStarts && (
          <section>
            <span className="mb-2 block text-[13px] font-medium text-text-secondary">
              Quick Starts
            </span>
            <div className="flex flex-wrap gap-1.5">
              {LOOP_TEMPLATES.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  onClick={() => handleTemplateClick(template)}
                  disabled={pending}
                  aria-label={`Template ${template.label}`}
                  className="inline-flex flex-col items-start gap-0.5 rounded-sm border border-border-subtle bg-bg-base px-2.5 py-1.5 text-left text-[12px] text-text-secondary transition-colors duration-150 hover:bg-bg-hover hover:text-text-primary disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <span>{template.label}</span>
                  <span className="text-[10px] text-text-muted">{template.note}</span>
                </button>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-text-muted">
              Templates define the Loop runtime shape. The create request sends only the selected template id and minimal fields.
            </p>
          </section>
        )}

        <div>
          <span className="mb-2 block text-[13px] font-medium text-text-secondary">
            Template
          </span>
          <div className="grid grid-cols-2 gap-2">
            {LOOP_TEMPLATES.map((template) => (
              <label key={template.id} className="flex items-center gap-2 rounded-sm border border-border-subtle px-2 py-1.5 text-[12.5px] text-text-secondary">
                <input
                  type="radio"
                  name="loop-template"
                  value={template.id}
                  checked={templateId === template.id}
                  onChange={() => setTemplateId(template.id)}
                  disabled={pending}
                  autoFocus={template.id === "watch_report"}
                  className="accent-accent"
                />
                <span>{template.label}</span>
              </label>
            ))}
          </div>
          {templateId === "pr_babysitter" && (
            <div className="mt-2 rounded-sm border border-warning-muted bg-warning-muted px-2.5 py-2 text-[11px] text-warning">
              Requires GitHub.com integration with an env token. PR Babysitter can watch, report, and comment when allowed; it does not merge, rebase, approve, or force-push.
            </div>
          )}
        </div>

        <div data-testid="loop-schedule-kind">
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
                disabled={pending}
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
                disabled={pending}
                className="accent-accent"
              />
              <span>interval</span>
            </label>
            <label className="flex items-center gap-2 text-[12.5px] text-text-secondary">
              <input
                type="radio"
                name="loop-schedule"
                value="cron"
                checked={scheduleKind === "cron"}
                onChange={() => setScheduleKind("cron")}
                disabled={pending}
                className="accent-accent"
              />
              <span>cron</span>
            </label>
            {scheduleKind === "interval" && (
              <label className="flex items-center gap-2 text-[12.5px] text-text-secondary">
                <span>every (ms)</span>
                <input
                  id="new-loop-every-ms"
                  type="number"
                  min={MIN_INTERVAL_MS}
                  value={everyMs}
                  onChange={(e) => setEveryMs(Number(e.target.value) || 0)}
                  disabled={pending}
                  className="w-28 rounded-sm border border-border-default bg-bg-base px-2 py-1 text-[12.5px] text-text-primary focus:border-accent focus:outline-none"
                />
              </label>
            )}
          </div>
          {scheduleKind === "cron" && (
            <label className="mt-2 flex flex-col gap-1 text-[12.5px] text-text-secondary">
              <span>UTC cron expression</span>
              <input
                data-testid="loop-cron-expression"
                id="new-loop-cron-expression"
                type="text"
                value={cronExpression}
                onChange={(e) => setCronExpression(e.target.value)}
                placeholder="*/15 * * * *"
                disabled={pending}
                className="w-full rounded-sm border border-border-default bg-bg-base px-2 py-1.5 font-mono text-[12.5px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
              />
            </label>
          )}
          {scheduleKind === "interval" && !intervalValid && (
            <p className="mt-1 text-[11px] text-error">
              Interval must be a positive integer of at least {MIN_INTERVAL_MS} ms.
            </p>
          )}
          {scheduleKind === "cron" && !cronValid && (
            <p className="mt-1 text-[11px] text-error">
              Cron must be a 5-field UTC expression
            </p>
          )}
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
                disabled={pending}
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
                disabled={pending}
                className="accent-accent"
              />
              <span>explicit per run</span>
            </label>
          </div>
          <p className="mt-1 text-[11px] text-text-muted">
            {approvalPolicy === "interactive"
              ? "interactive: approvals follow the normal interactive HITL flow."
              : "explicit_per_run: each run requires an explicit approval before it starts."}
          </p>
        </div>

        <section className="rounded-sm border border-border-subtle bg-bg-base p-3 space-y-3">
          <div>
            <span className="mb-1.5 block text-[13px] font-medium text-text-secondary">
              Budget
            </span>
            <p className="text-[11px] text-text-muted">
              Loop runtime guardrails. Missing USD pricing makes USD availability unknown, never free.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-[12.5px] text-text-secondary">
              <span>maxIterationsPerRun</span>
              <input
                id="new-loop-max-iterations"
                type="number"
                min={1}
                value={maxIterationsPerRun}
                onChange={(e) => setMaxIterationsPerRun(Number(e.target.value) || 0)}
                disabled={pending}
                className="rounded-sm border border-border-default bg-bg-base px-2 py-1.5 text-[12.5px] text-text-primary focus:border-accent focus:outline-none"
              />
            </label>
            <label className="flex flex-col gap-1 text-[12.5px] text-text-secondary">
              <span>maxTokensPerRun</span>
              <input
                id="new-loop-max-tokens"
                type="number"
                min={1}
                value={maxTokensPerRun}
                onChange={(e) => setMaxTokensPerRun(Number(e.target.value) || 0)}
                disabled={pending}
                className="rounded-sm border border-border-default bg-bg-base px-2 py-1.5 text-[12.5px] text-text-primary focus:border-accent focus:outline-none"
              />
            </label>
            <label className="flex flex-col gap-1 text-[12.5px] text-text-secondary">
              <span>maxWallClockMinutesPerRun</span>
              <input
                id="new-loop-max-wall-clock"
                type="number"
                min={1}
                value={maxWallClockMinutesPerRun}
                onChange={(e) => setMaxWallClockMinutesPerRun(Number(e.target.value) || 0)}
                disabled={pending}
                className="rounded-sm border border-border-default bg-bg-base px-2 py-1.5 text-[12.5px] text-text-primary focus:border-accent focus:outline-none"
              />
            </label>
            <label className="flex flex-col gap-1 text-[12.5px] text-text-secondary">
              <span>maxRunsPerDay</span>
              <input
                id="new-loop-max-runs-day"
                type="number"
                min={1}
                value={maxRunsPerDay}
                onChange={(e) => setMaxRunsPerDay(Number(e.target.value) || 0)}
                disabled={pending}
                className="rounded-sm border border-border-default bg-bg-base px-2 py-1.5 text-[12.5px] text-text-primary focus:border-accent focus:outline-none"
              />
            </label>
            <label className="flex flex-col gap-1 text-[12.5px] text-text-secondary">
              <span>maxEstimatedUsdPerRun <span className="text-text-muted">(optional)</span></span>
              <input
                id="new-loop-max-usd"
                type="number"
                min={0}
                step="0.01"
                value={maxEstimatedUsdPerRun ?? ""}
                onChange={(e) => setMaxEstimatedUsdPerRun(e.target.value.trim().length === 0 ? undefined : Number(e.target.value) || 0)}
                disabled={pending}
                className="rounded-sm border border-border-default bg-bg-base px-2 py-1.5 text-[12.5px] text-text-primary focus:border-accent focus:outline-none"
              />
            </label>
          </div>
          {!budgetValid && (
            <p className="text-[11px] text-error">
              Budget values must be positive integers.
            </p>
          )}
        </section>

        {!isGoalTemplate && (
          <div>
            <label
              htmlFor="new-loop-task-prompt"
              className="mb-1.5 block text-[13px] font-medium text-text-secondary"
            >
              Run instructions
            </label>
            <textarea
              id="new-loop-task-prompt"
              value={taskPrompt}
              onChange={(e) => setTaskPrompt(e.target.value)}
              placeholder="Describe what each Loop run should do."
              rows={3}
              disabled={pending}
              className="w-full rounded-sm border border-border-default bg-bg-base px-3 py-2 text-[13px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none transition-colors duration-150"
            />
            {!taskPromptValid && (
              <p className="mt-1 text-[11px] text-error">
                Template loops need run instructions before submit.
              </p>
            )}
          </div>
        )}

        {isGoalTemplate && (
          <section className="rounded-sm border border-border-subtle p-3 space-y-4">
            <div className="text-[13px] font-medium text-text-secondary">
              Goal Template (inline)
            </div>
            <p className="text-[11px] text-text-muted">
              Each run creates a fresh Goal from these natural-language fields. The Reviewer judges completion against the acceptance criteria.
              Goal titles are generated asynchronously after each Goal is created.
            </p>

            <div>
              <label
                htmlFor="new-loop-goal-objective"
                className="mb-1.5 block text-[13px] font-medium text-text-secondary"
              >
                Goal Objective
              </label>
              <textarea
                id="new-loop-goal-objective"
                value={goalObjective}
                onChange={(e) => setGoalObjective(e.target.value)}
                placeholder="Describe the task objective in natural language."
                rows={3}
                disabled={pending}
                className="w-full rounded-sm border border-border-default bg-bg-base px-2 py-2 text-[13px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none transition-colors duration-150 resize-y"
              />
              {!goalObjectiveValid && (
                <p className="mt-1 text-[11px] text-error">Goal loops need a Goal objective before submit.</p>
              )}
            </div>

            <div>
              <label
                htmlFor="new-loop-goal-acceptance-criteria"
                className="mb-1.5 block text-[13px] font-medium text-text-secondary"
              >
                Goal Acceptance Criteria
              </label>
              <textarea
                id="new-loop-goal-acceptance-criteria"
                value={goalAcceptanceCriteria}
                onChange={(e) => setGoalAcceptanceCriteria(e.target.value)}
                placeholder="Describe what done looks like in natural language. The Reviewer will judge completion against this."
                rows={3}
                disabled={pending}
                className="w-full rounded-sm border border-border-default bg-bg-base px-2 py-2 text-[13px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none transition-colors duration-150 resize-y"
              />
              {!goalAcceptanceValid && (
                <p className="mt-1 text-[11px] text-error">Goal loops need acceptance criteria before submit.</p>
              )}
            </div>
          </section>
        )}

        <section className="rounded-sm border border-border-subtle bg-bg-base">
          <button
            type="button"
            data-testid="loop-advanced-toggle"
            onClick={() => setShowAdvanced((prev) => !prev)}
            disabled={pending}
            className="flex w-full items-center justify-between px-3 py-2 text-[13px] font-medium text-text-secondary transition-colors duration-150 hover:bg-bg-hover"
          >
            <span>Advanced</span>
            <span className="text-[11px] text-text-muted">{showAdvanced ? "hide" : "show"}</span>
          </button>
          {showAdvanced && (
            <div data-testid="loop-advanced-section" className="space-y-3 border-t border-border-subtle px-3 py-3">
              <label className="flex items-start gap-2 text-[12.5px] text-text-secondary">
                <input
                  data-testid="loop-use-worktree"
                  type="checkbox"
                  checked={useWorktree}
                  onChange={(e) => setUseWorktree(e.target.checked)}
                  disabled={pending}
                  className="mt-0.5 accent-accent"
                />
                <span>
                  Run each Loop run in an isolated git worktree.
                  <span className="mt-0.5 block text-[11px] text-text-muted">
                    Off by default. Enable only when you want isolated working copies; the Loop will not auto-enable worktrees.
                  </span>
                </span>
              </label>
            </div>
          )}
        </section>
      </div>

      {errorMessage && (
        <div className="px-5 py-2 text-xs text-error shrink-0">{errorMessage}</div>
      )}

      <div className="flex justify-end gap-2 border-t border-border-subtle px-5 py-3 shrink-0">
        <button
          type="button"
          onClick={onClose}
          className="rounded-sm bg-bg-active px-4 py-2 text-[13px] font-medium text-text-primary transition-colors duration-150 hover:bg-bg-hover"
          disabled={pending}
        >
          Cancel
        </button>
        <button
          type="submit"
          data-testid="loop-create-submit"
          className="rounded-sm bg-accent px-4 py-2 text-[13px] font-medium text-bg-base transition-colors duration-150 hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
          disabled={!canSubmit}
        >
          {pending ? pendingLabel : submitLabel}
        </button>
      </div>
    </form>
  );
}

function isFiveFieldCronExpression(value: string): boolean {
  return value.trim().split(/\s+/).filter(Boolean).length === 5;
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
          Create a new Loop with a template, schedule, and approval policy
        </DialogDescription>
        <CreateLoopForm slug={slug} onCreated={onCreated} onClose={onClose} />
      </DialogContent>
    </DialogRoot>
  );
}

export function EditLoopDialog({ open, onClose, slug, loop }: EditLoopDialogProps) {
  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) onClose();
    },
    [onClose],
  );

  return (
    <DialogRoot open={open} onOpenChange={handleOpenChange}>
      <DialogContent size="x-large">
        <DialogTitle className="sr-only">Edit Loop</DialogTitle>
        <DialogDescription className="sr-only">
          Edit Loop template, schedule, budget, and task or Goal fields
        </DialogDescription>
        {open && <EditLoopForm slug={slug} loop={loop} onClose={onClose} />}
      </DialogContent>
    </DialogRoot>
  );
}

export function EditLoopForm({ slug, loop, onClose }: { slug: string; loop: LoopState; onClose?: () => void }) {
  const updateLoop = useUpdateLoop();
  const initialState = loopConfigToFormState(loop.config);

  const handleSubmitPayload = useCallback(
    (payload: CreateLoopPayload) => {
      updateLoop.mutate(
        {
          slug,
          loopId: loop.loopId,
          templateId: payload.templateId,
          schedule: payload.schedule,
          approvalPolicy: payload.approvalPolicy,
          limits: payload.limits,
          ...(payload.taskPrompt ? { taskPrompt: payload.taskPrompt } : {}),
          ...(payload.goalTemplate ? { goalTemplate: payload.goalTemplate } : {}),
          ...(loop.config.triggers ? { triggers: loop.config.triggers } : {}),
          useWorktree: payload.useWorktree,
        },
        { onSuccess: () => onClose?.() },
      );
    },
    [updateLoop, slug, loop.loopId, loop.config, onClose],
  );

  return (
    <LoopForm
      slug={slug}
      title="Edit Loop"
      description="Update this Loop's template, schedule, budget, and task or Goal fields"
      submitLabel="Save Loop"
      pendingLabel="Saving…"
      pending={updateLoop.isPending}
      error={updateLoop.error}
      onClose={onClose}
      onSubmitPayload={handleSubmitPayload}
      initialState={initialState}
    />
  );
}
