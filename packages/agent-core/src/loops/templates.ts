import {
  TOOL_GITHUB_CREATE_ISSUE_COMMENT,
  TOOL_GITHUB_GET_PULL_REQUEST,
  TOOL_GITHUB_GET_PULL_REQUEST_CHECKS,
  TOOL_GITHUB_LIST_ISSUE_COMMENTS,
  TOOL_GITHUB_LIST_PULL_REQUESTS,
} from "@archcode/protocol";
import type { AgentName } from "../agents/factory-types";
import type { LoopConfig } from "./state";

export const LOOP_TEMPLATE_IDS = [
  "watch_report",
  "maintain_fix",
  "pr_babysitter",
  "goal_runner",
] as const;

export type LoopTemplateId = (typeof LOOP_TEMPLATE_IDS)[number];

export interface LoopTemplateRunConfig {
  readonly type: "session" | "goal";
  readonly agent: AgentName;
}

export interface LoopTemplate {
  readonly id: LoopTemplateId;
  readonly label: string;
  readonly description: string;
  readonly run: LoopTemplateRunConfig;
  readonly extraTools: readonly string[];
  readonly defaults: Omit<LoopConfig, "templateId" | "title">;
}

export type ExpandedLoopTemplate = LoopConfig;

export const PR_BABYSITTER_EXTRA_TOOLS = [
  TOOL_GITHUB_GET_PULL_REQUEST,
  TOOL_GITHUB_LIST_PULL_REQUESTS,
  TOOL_GITHUB_GET_PULL_REQUEST_CHECKS,
  TOOL_GITHUB_LIST_ISSUE_COMMENTS,
  TOOL_GITHUB_CREATE_ISSUE_COMMENT,
] as const;

const MINUTE_MS = 60_000;

const LOOP_TEMPLATES = {
  watch_report: {
    id: "watch_report",
    label: "Watch & Report",
    description: "Inspect local project state on a schedule and report findings without changing files.",
    run: { type: "session", agent: "plan" },
    extraTools: [],
    defaults: {
      schedule: { kind: "manual" },
      approvalPolicy: "interactive",
      useWorktree: false,
      limits: templateBudget(8, 120_000, 15, 2),
      taskPrompt:
        "Inspect the project state and prepare a concise report. Summarize notable git, code health, and follow-up findings without making repository changes.",
    },
  },
  maintain_fix: {
    id: "maintain_fix",
    label: "Maintain & Fix",
    description: "Run a scoped maintenance pass that may make local fixes through the Build agent.",
    run: { type: "session", agent: "build" },
    extraTools: [],
    defaults: {
      schedule: { kind: "manual" },
      approvalPolicy: "explicit_per_run",
      useWorktree: false,
      limits: templateBudget(16, 200_000, 30, 2),
      taskPrompt:
        "Run a scoped maintenance pass. Identify one narrowly bounded issue, make the minimal fix, and record verification output in the session.",
    },
  },
  pr_babysitter: {
    id: "pr_babysitter",
    label: "PR Babysitter",
    description: "Watch pull requests, checks, and comments; report blockers and post status comments when useful.",
    run: { type: "session", agent: "plan" },
    extraTools: PR_BABYSITTER_EXTRA_TOOLS,
    defaults: {
      schedule: { kind: "manual" },
      approvalPolicy: "interactive",
      useWorktree: false,
      limits: templateBudget(12, 160_000, 20, 4),
      taskPrompt:
        "Watch pull requests and prepare a concise status report. Collect checks, comments, and blockers; draft a short issue comment only when a clear status update is useful and normal permissions allow it.",
    },
  },
  goal_runner: {
    id: "goal_runner",
    label: "Goal Runner",
    description: "Create and run a recurring Goal with the Orchestrator agent.",
    run: { type: "goal", agent: "orchestrator" },
    extraTools: [],
    defaults: {
      schedule: { kind: "manual" },
      approvalPolicy: "explicit_per_run",
      useWorktree: false,
      limits: templateBudget(20, 240_000, 45, 2),
    },
  },
} as const satisfies Record<LoopTemplateId, LoopTemplate>;

export function isLoopTemplateId(id: string): id is LoopTemplateId {
  return (LOOP_TEMPLATE_IDS as readonly string[]).includes(id);
}

export function getLoopTemplate(templateId: string): LoopTemplate {
  if (!isLoopTemplateId(templateId)) {
    throw new RangeError(`Unknown loop template "${templateId}". Valid ids: ${LOOP_TEMPLATE_IDS.join(", ")}`);
  }
  return LOOP_TEMPLATES[templateId];
}

export function expandLoopTemplate(templateId: string): ExpandedLoopTemplate {
  const template = getLoopTemplate(templateId);
  return {
    templateId: template.id,
    title: null,
    schedule: structuredClone(template.defaults.schedule),
    approvalPolicy: template.defaults.approvalPolicy,
    useWorktree: template.defaults.useWorktree,
    limits: structuredClone(template.defaults.limits),
    ...(template.defaults.taskPrompt === undefined ? {} : { taskPrompt: template.defaults.taskPrompt }),
    ...(template.defaults.goalTemplate === undefined ? {} : { goalTemplate: structuredClone(template.defaults.goalTemplate) }),
  };
}

export function resolveLoopTemplateId(value: unknown): LoopTemplateId | undefined {
  return typeof value === "string" && isLoopTemplateId(value) ? value : undefined;
}

function templateBudget(
  maxIterationsPerRun: number,
  maxTokensPerRun: number,
  maxWallClockMinutesPerRun: number,
  maxRunsPerDay: number,
) {
  return {
    maxIterationsPerRun,
    maxTokensPerRun,
    maxWallClockMsPerRun: maxWallClockMinutesPerRun * MINUTE_MS,
    maxRunsPerDay,
    softThresholdRatio: 0.8,
    hardThresholdRatio: 1.0,
  };
}
