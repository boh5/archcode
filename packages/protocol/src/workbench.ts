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

export interface WorkbenchProjectReadError {
  readonly project: WorkbenchProjectRef;
  readonly message: string;
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
