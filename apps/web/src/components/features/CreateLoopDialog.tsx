import { useState, useCallback } from "react";
import {
  DialogRoot,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "../ui/Dialog";
import { useCreateLoop, useUpdateLoop } from "../../api/mutations";
import type {
  ApprovalPoint,
  DoneCondition,
  LoopApprovalPolicy,
  LoopBudgetConfig,
  LoopConfig,
  LoopMode,
  LoopRunKind,
  LoopScheduleSpec,
  LoopState,
  LoopToolProfileId,
  LoopTriggerSpec,
  RetryPolicy,
} from "../../api/types";

interface PresetQuickStart {
  id: string;
  label: string;
  template: Partial<LoopFormState>;
  note: string;
}

interface ToolProfileOption {
  id: LoopToolProfileId;
  label: string;
  description: string;
  externalRequirement?: string;
}

const DEFAULT_BUDGET: LoopBudgetConfig = {
  maxIterationsPerRun: 8,
  maxTokensPerRun: 120000,
  maxWallClockMsPerRun: 15 * 60_000,
  maxRunsPerDay: 2,
  softThresholdRatio: 0.8,
  hardThresholdRatio: 1,
};

const TOOL_PROFILE_OPTIONS: ToolProfileOption[] = [
  {
    id: "loop_local_report",
    label: "Local report",
    description: "Read local project state and produce a report without repository-changing actions.",
  },
  {
    id: "loop_local_maintenance",
    label: "Local maintenance",
    description: "Local file edits and verification through the normal tool permission flow.",
  },
  {
    id: "loop_github_pr_watch",
    label: "GitHub PR watch",
    description: "Watch PR status, checks, comments, and optionally hand off a scoped fix Goal.",
    externalRequirement: "Requires GitHub.com integration with an env token. It can watch, report, comment when allowed, and propose fix Goals only.",
  },
  {
    id: "loop_ci_watch",
    label: "GitHub Actions watch",
    description: "Inspect GitHub Actions runs, failure groups, and safe retry candidates.",
    externalRequirement: "Requires GitHub.com plus GitHub Actions access through the configured env token.",
  },
  {
    id: "loop_goal_action",
    label: "Goal action",
    description: "Create and run scoped Goals with configured done conditions and reviewer checks.",
  },
];

function budgetTemplate(overrides: Partial<LoopBudgetConfig> = {}): Partial<LoopFormState> {
  const budget = { ...DEFAULT_BUDGET, ...overrides };
  return {
    maxIterationsPerRun: budget.maxIterationsPerRun,
    maxTokensPerRun: budget.maxTokensPerRun ?? DEFAULT_BUDGET.maxTokensPerRun,
    maxWallClockMinutesPerRun: Math.round((budget.maxWallClockMsPerRun ?? DEFAULT_BUDGET.maxWallClockMsPerRun ?? 0) / 60_000),
    maxRunsPerDay: budget.maxRunsPerDay ?? DEFAULT_BUDGET.maxRunsPerDay,
    maxEstimatedUsdPerRun: budget.maxEstimatedUsdPerRun,
    softThresholdRatio: budget.softThresholdRatio,
    hardThresholdRatio: budget.hardThresholdRatio,
  };
}

const PRESET_QUICK_STARTS: PresetQuickStart[] = [
  {
    id: "daily_triage",
    label: "Daily Triage",
    note: "Local report template",
    template: {
      title: "Daily Triage",
      description: "Inspect local project health and summarize issues.",
      runKind: "session",
      mode: "report",
      toolProfileId: "loop_local_report",
      taskPrompt: "Run local project triage and summarize status, failures, stale work, and next steps.",
      ...budgetTemplate(),
    },
  },
  {
    id: "changelog_drafter",
    label: "Changelog Drafter",
    note: "Local report template",
    template: {
      title: "Changelog Drafter",
      description: "Draft changelog text from local history and diffs.",
      runKind: "session",
      mode: "report",
      toolProfileId: "loop_local_report",
      taskPrompt: "Review recent local git history and draft a categorized changelog entry.",
      ...budgetTemplate(),
    },
  },
  {
    id: "pr_babysitter",
    label: "PR Babysitter",
    note: "GitHub.com PR watch/status/comment + optional fix Goal handoff",
    template: {
      title: "PR Babysitter",
      description: "Watch PR status, comments, and checks, then report useful next steps.",
      runKind: "session",
      mode: "report",
      toolProfileId: "loop_github_pr_watch",
      taskPrompt: "Watch configured PRs, summarize status and comments, draft a status comment only when useful and allowed, and propose an optional fix Goal for small scoped repairs.",
      ...budgetTemplate({ maxIterationsPerRun: 12, maxTokensPerRun: 160000, maxWallClockMsPerRun: 20 * 60_000, maxRunsPerDay: 4 }),
    },
  },
  {
    id: "ci_sweeper",
    label: "CI Sweeper",
    note: "GitHub Actions watch template",
    template: {
      title: "CI Sweeper",
      description: "Inspect workflow runs and summarize failure groups.",
      runKind: "session",
      mode: "report",
      toolProfileId: "loop_ci_watch",
      taskPrompt: "Inspect recent GitHub Actions workflow runs, group failures, and suggest the next safe check.",
      ...budgetTemplate({ maxIterationsPerRun: 16, maxTokensPerRun: 200000, maxWallClockMsPerRun: 30 * 60_000, maxRunsPerDay: 4 }),
    },
  },
  {
    id: "dependency_sweeper",
    label: "Dependency Sweeper",
    note: "Goal action template",
    template: {
      title: "Dependency Sweeper",
      description: "Create a scoped Goal for dependency maintenance.",
      runKind: "goal",
      mode: "act",
      approvalPolicy: "explicit_per_run",
      toolProfileId: "loop_goal_action",
      goalTitle: "Dependency Sweeper Goal",
      goalPrompt: "Inspect dependency manifests, choose a scoped update or report, verify, and record evidence.",
      goalConditions: [
        { id: "typecheck", kind: "typecheck_pass", params: { command: "bun run typecheck" }, required: true },
        { id: "tests", kind: "tests_pass", params: { command: "bun test" }, required: true },
      ],
      ...budgetTemplate({ maxIterationsPerRun: 20, maxTokensPerRun: 240000, maxWallClockMsPerRun: 45 * 60_000, maxRunsPerDay: 2 }),
    },
  },
  {
    id: "post_merge_cleanup",
    label: "Post-Land Cleanup",
    note: "GitHub.com follow-up report template",
    template: {
      title: "Post-Land Cleanup",
      description: "Summarize linked issues, comments, and follow-up cleanup status.",
      runKind: "session",
      mode: "report",
      toolProfileId: "loop_github_pr_watch",
      taskPrompt: "Inspect the relevant PR and linked issues, summarize leftover follow-ups, and draft a concise status comment only when useful and allowed.",
      ...budgetTemplate({ maxIterationsPerRun: 10, maxTokensPerRun: 140000, maxWallClockMsPerRun: 20 * 60_000, maxRunsPerDay: 3 }),
    },
  },
  {
    id: "issue_triage",
    label: "Issue Triage",
    note: "GitHub.com issue report template",
    template: {
      title: "Issue Triage",
      description: "Inspect open issues and suggest labels, owners, or next questions.",
      runKind: "session",
      mode: "report",
      toolProfileId: "loop_github_pr_watch",
      taskPrompt: "Inspect configured issues, group duplicates or stale reports, and suggest labels, owners, and next questions.",
      ...budgetTemplate({ maxIterationsPerRun: 10, maxTokensPerRun: 140000, maxWallClockMsPerRun: 20 * 60_000, maxRunsPerDay: 3 }),
    },
  },
];

const APPROVAL_POINTS: ApprovalPoint[] = ["after_plan", "before_complete"];

const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 2,
  backoffMs: 1000,
  escalateOnFailure: true,
};

// Minimum interval/trigger guards; server validation remains the source of truth.
const MIN_INTERVAL_MS = 1000;
const MIN_TRIGGER_CADENCE_MS = 30000;

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
  /** Testability hook: pre-fill form state without driving controlled inputs. */
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
  onSubmitConfig: (config: LoopConfig, author: string | undefined) => void;
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
  cronExpression: string;
  triggerOnPr: boolean;
  triggerCadenceMs: number;
  runKind: LoopRunKind;
  mode: LoopMode;
  approvalPolicy: LoopApprovalPolicy;
  maxIterationsPerRun: number;
  maxTokensPerRun: number;
  maxWallClockMinutesPerRun: number;
  maxRunsPerDay: number;
  maxEstimatedUsdPerRun?: number;
  softThresholdRatio: number;
  hardThresholdRatio: number;
  toolProfileId: LoopToolProfileId;
  taskPrompt: string;
  instructions: string;
  author: string;
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
    softThresholdRatio: state.softThresholdRatio,
    hardThresholdRatio: state.hardThresholdRatio,
  };
}

export function buildLoopConfig(state: LoopFormState): LoopConfig {
  const trimmedTitle = state.title.trim();
  const schedule: LoopScheduleSpec =
    state.scheduleKind === "interval"
      ? { kind: "interval", everyMs: state.everyMs }
      : state.scheduleKind === "cron"
        ? { kind: "cron", expression: state.cronExpression.trim() }
        : { kind: "manual" };
  const triggers: LoopTriggerSpec[] = state.triggerOnPr
    ? [{ kind: "on_pr", cadenceMs: state.triggerCadenceMs }]
    : [];
  const budget = buildBudgetConfig(state);

  const config: LoopConfig = {
    title: trimmedTitle,
    ...(isNonEmpty(state.description) ? { description: state.description.trim() } : {}),
    schedule,
    runKind: state.runKind,
    mode: state.mode,
    approvalPolicy: state.approvalPolicy,
    limits: budget,
    budget,
    toolProfileId: state.toolProfileId,
    ...(triggers.length > 0 ? { triggers } : {}),
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

function loopConfigToFormState(config: LoopConfig): Partial<LoopFormState> {
  const budget = config.budget ?? config.limits;
  const scheduleKind: ScheduleKind = config.schedule.kind;
  const onPrTrigger = config.triggers?.find((trigger) => trigger.kind === "on_pr");
  const wallClockMs = "maxWallClockMsPerRun" in budget ? budget.maxWallClockMsPerRun : undefined;
  const maxTokensPerRun = "maxTokensPerRun" in budget ? budget.maxTokensPerRun : undefined;
  const maxRunsPerDay = "maxRunsPerDay" in budget ? budget.maxRunsPerDay : undefined;
  const maxEstimatedUsdPerRun = "maxEstimatedUsdPerRun" in budget ? budget.maxEstimatedUsdPerRun : undefined;
  const softThresholdRatio = "softThresholdRatio" in budget ? budget.softThresholdRatio : DEFAULT_BUDGET.softThresholdRatio;
  const hardThresholdRatio = "hardThresholdRatio" in budget ? budget.hardThresholdRatio : DEFAULT_BUDGET.hardThresholdRatio;
  const goalTemplate = config.goalTemplate;

  return {
    title: config.title,
    description: config.description ?? "",
    scheduleKind,
    everyMs: config.schedule.kind === "interval" ? config.schedule.everyMs : 60000,
    cronExpression: config.schedule.kind === "cron" ? config.schedule.expression : "*/15 * * * *",
    triggerOnPr: onPrTrigger !== undefined,
    triggerCadenceMs: onPrTrigger?.cadenceMs ?? 60000,
    runKind: config.runKind,
    mode: config.mode,
    approvalPolicy: config.approvalPolicy,
    maxIterationsPerRun: budget.maxIterationsPerRun,
    maxTokensPerRun: maxTokensPerRun ?? DEFAULT_BUDGET.maxTokensPerRun ?? 120000,
    maxWallClockMinutesPerRun: wallClockMs === undefined ? 15 : Math.max(1, Math.round(wallClockMs / 60_000)),
    maxRunsPerDay: maxRunsPerDay ?? DEFAULT_BUDGET.maxRunsPerDay ?? 2,
    maxEstimatedUsdPerRun,
    softThresholdRatio,
    hardThresholdRatio,
    toolProfileId: config.toolProfileId ?? "loop_local_report",
    taskPrompt: config.taskPrompt ?? "",
    instructions: config.instructions ?? "",
    goalTitle: goalTemplate?.title ?? "",
    goalAuthor: goalTemplate?.author ?? "architect",
    goalPrompt: goalTemplate?.prompt ?? "",
    goalInstructions: goalTemplate?.instructions ?? "",
    goalConditions: goalTemplate?.doneConditions ?? [],
    goalMaxRetries: goalTemplate?.retryPolicy.maxRetries ?? 2,
    goalEscalateOnFailure: goalTemplate?.retryPolicy.escalateOnFailure ?? true,
    goalApprovalPoints: goalTemplate?.approvalPoints ?? ["after_plan", "before_complete"],
    goalReviewerAgent: goalTemplate?.reviewerAgent ?? "reviewer",
  };
}

function applyPresetState(
  preset: PresetQuickStart,
  setters: {
    setTitle: (value: string) => void;
    setDescription: (value: string) => void;
    setRunKind: (value: LoopRunKind) => void;
    setMode: (value: LoopMode) => void;
    setApprovalPolicy: (value: LoopApprovalPolicy) => void;
    setMaxIterationsPerRun: (value: number) => void;
    setMaxTokensPerRun: (value: number) => void;
    setMaxWallClockMinutesPerRun: (value: number) => void;
    setMaxRunsPerDay: (value: number) => void;
    setMaxEstimatedUsdPerRun: (value: number | undefined) => void;
    setSoftThresholdRatio: (value: number) => void;
    setHardThresholdRatio: (value: number) => void;
    setToolProfileId: (value: LoopToolProfileId) => void;
    setTaskPrompt: (value: string) => void;
    setInstructions: (value: string) => void;
    setGoalTitle: (value: string) => void;
    setGoalPrompt: (value: string) => void;
    setGoalConditions: (value: DoneCondition[]) => void;
  },
): void {
  const template = preset.template;
  setters.setTitle(template.title ?? preset.label);
  setters.setDescription(template.description ?? "");
  setters.setRunKind(template.runKind ?? "session");
  setters.setMode(template.mode ?? "report");
  setters.setApprovalPolicy(template.approvalPolicy ?? (template.mode === "act" ? "explicit_per_run" : "interactive"));
  setters.setMaxIterationsPerRun(template.maxIterationsPerRun ?? DEFAULT_BUDGET.maxIterationsPerRun);
  setters.setMaxTokensPerRun(template.maxTokensPerRun ?? DEFAULT_BUDGET.maxTokensPerRun ?? 0);
  setters.setMaxWallClockMinutesPerRun(template.maxWallClockMinutesPerRun ?? 15);
  setters.setMaxRunsPerDay(template.maxRunsPerDay ?? DEFAULT_BUDGET.maxRunsPerDay ?? 0);
  setters.setMaxEstimatedUsdPerRun(template.maxEstimatedUsdPerRun);
  setters.setSoftThresholdRatio(template.softThresholdRatio ?? DEFAULT_BUDGET.softThresholdRatio);
  setters.setHardThresholdRatio(template.hardThresholdRatio ?? DEFAULT_BUDGET.hardThresholdRatio);
  setters.setToolProfileId(template.toolProfileId ?? "loop_local_report");
  setters.setTaskPrompt(template.taskPrompt ?? "");
  setters.setInstructions(template.instructions ?? "");
  setters.setGoalTitle(template.goalTitle ?? "");
  setters.setGoalPrompt(template.goalPrompt ?? "");
  setters.setGoalConditions(template.goalConditions ?? []);
}

export function CreateLoopForm({ slug, onCreated, onClose, initialState }: CreateLoopFormProps) {
  const createLoop = useCreateLoop();

  const handleSubmitConfig = useCallback(
    (config: LoopConfig, author: string | undefined) => {
      createLoop.mutate(
        {
          slug,
          config,
          ...(author ? { author } : {}),
        },
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
      description="Create a new Loop with schedule, run kind, mode, tool profile, budget, and task or Goal fields"
      submitLabel="Create Loop"
      pendingLabel="Creating…"
      pending={createLoop.isPending}
      error={createLoop.error}
      onClose={onClose}
      onSubmitConfig={handleSubmitConfig}
      initialState={initialState}
      showQuickStarts
    />
  );
}

function LoopForm({
  title: formTitle,
  description: formDescription,
  submitLabel,
  pendingLabel,
  pending,
  error,
  onClose,
  onSubmitConfig,
  initialState,
  showQuickStarts = false,
}: LoopFormProps) {
  void formDescription;

  const [title, setTitle] = useState(initialState?.title ?? "");
  const [description, setDescription] = useState(initialState?.description ?? "");
  const [runKind, setRunKind] = useState<LoopRunKind>(initialState?.runKind ?? "session");
  const [scheduleKind, setScheduleKind] = useState<ScheduleKind>(initialState?.scheduleKind ?? "manual");
  const [everyMs, setEveryMs] = useState(initialState?.everyMs ?? 60000);
  const [cronExpression, setCronExpression] = useState(initialState?.cronExpression ?? "*/15 * * * *");
  const [triggerOnPr, setTriggerOnPr] = useState(initialState?.triggerOnPr ?? false);
  const [triggerCadenceMs, setTriggerCadenceMs] = useState(initialState?.triggerCadenceMs ?? 60000);
  const [mode, setMode] = useState<LoopMode>(initialState?.mode ?? "report");
  const [approvalPolicy, setApprovalPolicy] = useState<LoopApprovalPolicy>(initialState?.approvalPolicy ?? "interactive");
  const [maxIterationsPerRun, setMaxIterationsPerRun] = useState(initialState?.maxIterationsPerRun ?? 8);
  const [maxTokensPerRun, setMaxTokensPerRun] = useState(initialState?.maxTokensPerRun ?? 120000);
  const [maxWallClockMinutesPerRun, setMaxWallClockMinutesPerRun] = useState(initialState?.maxWallClockMinutesPerRun ?? 15);
  const [maxRunsPerDay, setMaxRunsPerDay] = useState(initialState?.maxRunsPerDay ?? 2);
  const [maxEstimatedUsdPerRun, setMaxEstimatedUsdPerRun] = useState<number | undefined>(initialState?.maxEstimatedUsdPerRun);
  const [softThresholdRatio, setSoftThresholdRatio] = useState(initialState?.softThresholdRatio ?? 0.8);
  const [hardThresholdRatio, setHardThresholdRatio] = useState(initialState?.hardThresholdRatio ?? 1);
  const [toolProfileId, setToolProfileId] = useState<LoopToolProfileId>(initialState?.toolProfileId ?? "loop_local_report");
  const [taskPrompt, setTaskPrompt] = useState(initialState?.taskPrompt ?? "");
  const [instructions, setInstructions] = useState(initialState?.instructions ?? "");
  const [author, setAuthor] = useState(initialState?.author ?? "architect");

  const [goalTitle, setGoalTitle] = useState(initialState?.goalTitle ?? "");
  const [goalAuthor, setGoalAuthor] = useState(initialState?.goalAuthor ?? "architect");
  const [goalPrompt, setGoalPrompt] = useState(initialState?.goalPrompt ?? "");
  const [goalInstructions, setGoalInstructions] = useState(initialState?.goalInstructions ?? "");
  const [goalConditions, setGoalConditions] = useState<DoneCondition[]>(initialState?.goalConditions ?? []);
  const [goalMaxRetries, setGoalMaxRetries] = useState(initialState?.goalMaxRetries ?? 2);
  const [goalEscalateOnFailure, setGoalEscalateOnFailure] = useState(initialState?.goalEscalateOnFailure ?? true);
  const [goalApprovalPoints, setGoalApprovalPoints] = useState<ApprovalPoint[]>(
    initialState?.goalApprovalPoints ?? ["after_plan", "before_complete"],
  );
  const [goalReviewerAgent, setGoalReviewerAgent] = useState(initialState?.goalReviewerAgent ?? "reviewer");

  const trimmedTitle = title.trim();
  const intervalValid = scheduleKind !== "interval" || (Number.isInteger(everyMs) && everyMs >= MIN_INTERVAL_MS);
  const cronValid = scheduleKind !== "cron" || isFiveFieldCronExpression(cronExpression);
  const triggerCadenceValid = !triggerOnPr || (Number.isInteger(triggerCadenceMs) && triggerCadenceMs >= MIN_TRIGGER_CADENCE_MS);
  const budgetValid =
    isPositiveInt(maxIterationsPerRun) &&
    isPositiveInt(maxTokensPerRun) &&
    isPositiveInt(maxWallClockMinutesPerRun) &&
    isPositiveInt(maxRunsPerDay) &&
    softThresholdRatio > 0 &&
    softThresholdRatio <= 1 &&
    hardThresholdRatio >= softThresholdRatio &&
    hardThresholdRatio <= 1;
  const sessionValid = runKind !== "session" || isNonEmpty(taskPrompt);
  const goalConditionsValid =
    runKind !== "goal" ||
    (goalConditions.length > 0 && goalConditions.every((c) => validateCondition(c).length === 0));
  const goalTitleValid = runKind !== "goal" || isNonEmpty(goalTitle);
  const canSubmit =
    isNonEmpty(trimmedTitle) &&
    intervalValid &&
    cronValid &&
    triggerCadenceValid &&
    budgetValid &&
    sessionValid &&
    goalConditionsValid &&
    goalTitleValid &&
    !pending;

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
      cronExpression,
      triggerOnPr,
      triggerCadenceMs,
      runKind,
      mode,
      approvalPolicy,
      maxIterationsPerRun,
      maxTokensPerRun,
      maxWallClockMinutesPerRun,
      maxRunsPerDay,
      maxEstimatedUsdPerRun,
      softThresholdRatio,
      hardThresholdRatio,
      toolProfileId,
      taskPrompt,
      instructions,
      author,
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
    cronExpression,
    triggerOnPr,
    triggerCadenceMs,
    runKind,
    mode,
    approvalPolicy,
    maxIterationsPerRun,
    maxTokensPerRun,
    maxWallClockMinutesPerRun,
    maxRunsPerDay,
    maxEstimatedUsdPerRun,
    softThresholdRatio,
    hardThresholdRatio,
    toolProfileId,
    taskPrompt,
    instructions,
    author,
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
      onSubmitConfig(config, isNonEmpty(author) ? author.trim() : undefined);
    },
    [canSubmit, buildConfig, author, onSubmitConfig],
  );

  const handlePresetClick = useCallback(
    (preset: PresetQuickStart) => {
      if (pending) return;
      applyPresetState(preset, {
        setTitle,
        setDescription,
        setRunKind,
        setMode,
        setApprovalPolicy,
        setMaxIterationsPerRun,
        setMaxTokensPerRun,
        setMaxWallClockMinutesPerRun,
        setMaxRunsPerDay,
        setMaxEstimatedUsdPerRun,
        setSoftThresholdRatio,
        setHardThresholdRatio,
        setToolProfileId,
        setTaskPrompt,
        setInstructions,
        setGoalTitle,
        setGoalPrompt,
        setGoalConditions,
      });
    },
    [pending],
  );

  const selectedToolProfile = TOOL_PROFILE_OPTIONS.find((profile) => profile.id === toolProfileId) ?? TOOL_PROFILE_OPTIONS[0];

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
                {PRESET_QUICK_STARTS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => handlePresetClick(preset)}
                    disabled={pending}
                    aria-label={`Preset ${preset.label}`}
                    className="inline-flex flex-col items-start gap-0.5 rounded-sm border border-border-subtle bg-bg-base px-2.5 py-1.5 text-left text-[12px] text-text-secondary transition-colors duration-150 hover:bg-bg-hover hover:text-text-primary disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <span>{preset.label}</span>
                    <span className="text-[10px] text-text-muted">{preset.note}</span>
                  </button>
                ))}
              </div>
              <p className="mt-2 text-[11px] text-text-muted">
                Presets are editable quick-start templates. Stored runKind, mode, tool profile, budget, and task or Goal fields drive runtime behavior.
              </p>
          </section>
        )}

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
                disabled={pending}
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
                disabled={pending}
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
                    disabled={pending}
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
                    disabled={pending}
                    className="accent-accent"
                  />
                  <span>goal</span>
                </label>
              </div>
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
                    <span>everyMs</span>
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
                  everyMs must be a positive integer of at least {MIN_INTERVAL_MS} ms.
                </p>
              )}
              {scheduleKind === "cron" && !cronValid && (
                <p className="mt-1 text-[11px] text-error">
                  Cron must be a 5-field UTC expression
                </p>
              )}
            </div>

            <section className="rounded-sm border border-border-subtle bg-bg-base p-3 space-y-3">
              <div>
                <span className="mb-1.5 block text-[13px] font-medium text-text-secondary">
                  Triggers
                </span>
                <p className="text-[11px] text-text-muted">
                  Triggers enqueue work separately from the schedule. PR polling cadence is UTC/runtime evaluated.
                </p>
              </div>
              <label className="flex items-center gap-2 text-[12.5px] text-text-secondary">
                <input
                  data-testid="loop-trigger-on-pr"
                  type="checkbox"
                  checked={triggerOnPr}
                  onChange={(e) => setTriggerOnPr(e.target.checked)}
                  disabled={pending}
                  className="accent-accent"
                />
                <span>on_pr</span>
              </label>
              <label className="flex flex-col gap-1 text-[12.5px] text-text-secondary">
                <span>cadenceMs</span>
                <input
                  data-testid="loop-trigger-cadence-ms"
                  id="new-loop-trigger-cadence-ms"
                  type="number"
                  min={MIN_TRIGGER_CADENCE_MS}
                  value={triggerCadenceMs}
                  onChange={(e) => setTriggerCadenceMs(Number(e.target.value) || 0)}
                  disabled={pending || !triggerOnPr}
                  className="w-40 rounded-sm border border-border-default bg-bg-base px-2 py-1.5 text-[12.5px] text-text-primary focus:border-accent focus:outline-none disabled:opacity-50"
                />
              </label>
              {triggerOnPr && !triggerCadenceValid && (
                <p className="text-[11px] text-error">
                  Cadence must be at least 30000 ms
                </p>
              )}
            </section>

            <label className="flex flex-col gap-1 text-[12.5px] text-text-secondary">
              <span>Project max concurrency</span>
              <input
                data-testid="loop-max-concurrent"
                type="text"
                value="Runtime-managed; not editable from Loop config"
                readOnly
                disabled
                className="rounded-sm border border-border-subtle bg-bg-base px-2 py-1.5 text-[12.5px] text-text-muted"
              />
              <span className="text-[11px] text-text-muted">
                The server rejects project-level concurrency updates here because no runtime persistence API exists yet.
              </span>
            </label>

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
                    disabled={pending}
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
                    disabled={pending}
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
                  <span>explicit_per_run</span>
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
                <span className="mb-2 block text-[13px] font-medium text-text-secondary">
                  Tool Profile
                </span>
                <select
                  id="new-loop-tool-profile"
                  value={toolProfileId}
                  onChange={(e) => setToolProfileId(e.target.value as LoopToolProfileId)}
                  disabled={pending}
                  className="w-full rounded-sm border border-border-default bg-bg-base px-3 py-2 text-[13px] text-text-primary focus:border-accent focus:outline-none"
                >
                  {TOOL_PROFILE_OPTIONS.map((profile) => (
                    <option key={profile.id} value={profile.id}>{profile.label}</option>
                  ))}
                </select>
                <p className="mt-1 text-[11px] text-text-muted">{selectedToolProfile.description}</p>
                {selectedToolProfile.externalRequirement && (
                  <div className="mt-2 rounded-sm border border-warning-muted bg-warning-muted px-2.5 py-2 text-[11px] text-warning">
                    {selectedToolProfile.externalRequirement} PR Babysitter does not merge, rebase, approve, or force-push.
                  </div>
                )}
              </div>
            </section>

            <section className="rounded-sm border border-border-subtle bg-bg-base p-3 space-y-3">
              <div>
                <span className="mb-1.5 block text-[13px] font-medium text-text-secondary">
                  Budget Defaults
                </span>
                <p className="text-[11px] text-text-muted">
                  These are Loop runtime guardrails. Missing USD pricing makes USD availability unknown, never free.
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
                <div className="grid grid-cols-2 gap-2">
                  <label className="flex flex-col gap-1 text-[12.5px] text-text-secondary">
                    <span>soft ratio</span>
                    <input
                      id="new-loop-soft-ratio"
                      type="number"
                      min={0.01}
                      max={1}
                      step="0.01"
                      value={softThresholdRatio}
                      onChange={(e) => setSoftThresholdRatio(Number(e.target.value) || 0)}
                      disabled={pending}
                      className="rounded-sm border border-border-default bg-bg-base px-2 py-1.5 text-[12.5px] text-text-primary focus:border-accent focus:outline-none"
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-[12.5px] text-text-secondary">
                    <span>hard ratio</span>
                    <input
                      id="new-loop-hard-ratio"
                      type="number"
                      min={0.01}
                      max={1}
                      step="0.01"
                      value={hardThresholdRatio}
                      onChange={(e) => setHardThresholdRatio(Number(e.target.value) || 0)}
                      disabled={pending}
                      className="rounded-sm border border-border-default bg-bg-base px-2 py-1.5 text-[12.5px] text-text-primary focus:border-accent focus:outline-none"
                    />
                  </label>
                </div>
              </div>
              {!budgetValid && (
                <p className="text-[11px] text-error">
                  Budget values must be positive, and hard ratio must be at least the soft ratio and no more than 1.
                </p>
              )}
            </section>

            {runKind === "session" && (
              <div>
                <label
                  htmlFor="new-loop-task-prompt"
                  className="mb-1.5 block text-[13px] font-medium text-text-secondary"
                >
                  Task Prompt
                </label>
                <textarea
                  id="new-loop-task-prompt"
                  value={taskPrompt}
                  onChange={(e) => setTaskPrompt(e.target.value)}
                  placeholder="Instructions for each session run"
                  rows={3}
                  disabled={pending}
                  className="w-full rounded-sm border border-border-default bg-bg-base px-3 py-2 text-[13px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none transition-colors duration-150"
                />
                {!sessionValid && (
                  <p className="mt-1 text-[11px] text-error">
                    Session loops need a task prompt before submit.
                  </p>
                )}
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
                disabled={pending}
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
                    disabled={pending}
                  />
                  {!goalTitleValid && (
                    <p className="mt-1 text-[11px] text-error">Goal loops need a Goal title before submit.</p>
                  )}
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
                      disabled={pending}
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
                      disabled={pending}
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
                    disabled={pending}
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
                    disabled={pending}
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
                        disabled={pending}
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
                            disabled={pending}
                            onRemove={() => removeCondition(condition.id)}
                            onParamChange={(key, value) =>
                              updateConditionParam(condition.id, key, value)
                            }
                          />
                        );
                      })}
                    </ul>
                  )}
                  {!goalConditionsValid && (
                    <p className="mt-2 text-[11px] text-error">
                      Goal loops need at least one valid done condition before submit.
                    </p>
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
                        disabled={pending}
                        className="w-20 rounded-sm border border-border-default bg-bg-base px-2 py-1 text-[12.5px] text-text-primary focus:border-accent focus:outline-none"
                      />
                    </label>
                    <label className="flex items-center gap-2 text-[12.5px] text-text-secondary">
                      <input
                        type="checkbox"
                        checked={goalEscalateOnFailure}
                        onChange={(e) => setGoalEscalateOnFailure(e.target.checked)}
                        disabled={pending}
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
                          disabled={pending}
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
                disabled={pending}
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
          Create a new Loop with schedule, run kind, mode, and approval policy
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
          Edit Loop schedule, run kind, mode, tool profile, budget, and task or Goal fields
        </DialogDescription>
        {open && <EditLoopForm slug={slug} loop={loop} onClose={onClose} />}
      </DialogContent>
    </DialogRoot>
  );
}

export function EditLoopForm({ slug, loop, onClose }: { slug: string; loop: LoopState; onClose?: () => void }) {
  const updateLoop = useUpdateLoop();
  const initialState = loopConfigToFormState(loop.config);

  const handleSubmitConfig = useCallback(
    (config: LoopConfig) => {
      updateLoop.mutate(
        { slug, loopId: loop.loopId, config },
        { onSuccess: () => onClose?.() },
      );
    },
    [updateLoop, slug, loop.loopId, onClose],
  );

  return (
    <LoopForm
      slug={slug}
      title="Edit Loop"
      description="Update this Loop's schedule, run kind, mode, tool profile, budget, and task or Goal fields"
      submitLabel="Save Loop"
      pendingLabel="Saving…"
      pending={updateLoop.isPending}
      error={updateLoop.error}
      onClose={onClose}
      onSubmitConfig={handleSubmitConfig}
      initialState={initialState}
    />
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
