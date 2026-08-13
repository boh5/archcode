import type {
  Automation,
  AutomationInvocation,
  RootSessionSummary,
  SessionExecutionTerminalStatus,
} from "./types";
import type { ProjectTodo } from "./project-todos";

export interface LatestExecutionDigest {
  readonly id: string;
  readonly status: "running" | "suspended" | SessionExecutionTerminalStatus;
  readonly startedAt: number;
  readonly endedAt?: number;
}

export interface ProjectSessionInventoryItem {
  readonly session: RootSessionSummary;
  readonly latestExecution: LatestExecutionDigest | null;
}

export interface ProjectSessionInventoryResponse {
  readonly sessions: readonly ProjectSessionInventoryItem[];
}

export interface ProjectAutomationInventoryItem {
  readonly automation: Automation;
  readonly latestInvocation: AutomationInvocation | null;
}

export interface ProjectAutomationInventoryResponse {
  readonly automations: readonly ProjectAutomationInventoryItem[];
}

export interface ProjectTodoRunNowResponse {
  readonly todo: ProjectTodo;
  readonly session: RootSessionSummary;
}

export interface ProjectTodoStartDiscussionResponse {
  readonly todo: ProjectTodo;
  readonly session: RootSessionSummary;
}

export interface WorkbenchProjectRef {
  readonly slug: string;
  readonly name: string;
}

/** Page-specific Home row; this is not a persisted work item or shared workflow state. */
export interface HomeSummaryItem {
  readonly kind: "hitl" | "todo" | "session" | "automation";
  readonly project: WorkbenchProjectRef;
  readonly entityId: string;
  readonly title: string;
  readonly status: string;
  readonly href: string;
  readonly sortAt: number;
  readonly context?: string;
}

export interface WorkbenchProjectReadError {
  readonly project: WorkbenchProjectRef;
  readonly message: string;
}

export interface HomeResponse {
  readonly needsYou: readonly HomeSummaryItem[];
  readonly running: readonly HomeSummaryItem[];
  readonly readyToReview: readonly HomeSummaryItem[];
  readonly upcoming: readonly HomeSummaryItem[];
  readonly projectErrors: readonly WorkbenchProjectReadError[];
}

export interface WorkSearchResult {
  readonly kind: "project" | "todo" | "session" | "automation";
  readonly project: WorkbenchProjectRef;
  readonly entityId: string;
  readonly title: string;
  readonly href: string;
  readonly context?: string;
}

export interface WorkSearchResponse {
  readonly results: readonly WorkSearchResult[];
  readonly truncated: boolean;
  readonly projectErrors: readonly WorkbenchProjectReadError[];
}
