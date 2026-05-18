export interface Project {
  slug: string;
  name: string;
  workspaceRoot: string;
  lastOpened?: string;
}

export interface SessionSummary {
  sessionId: string;
  title?: string | null;
  createdAt: number;
  lastUpdatedAt?: number;
}

export type SessionPart =
  | {
      type: "text";
      id: string;
      text: string;
      createdAt: number;
      completedAt?: number;
    }
  | {
      type: "reasoning";
      id: string;
      text: string;
      createdAt: number;
      completedAt?: number;
    }
  | {
      type: "tool";
      id: string;
      state: "pending" | "running" | "completed" | "error";
      toolCallId: string;
      toolName: string;
      input?: unknown;
      output?: string;
      errorMessage?: string;
      createdAt: number;
      startedAt?: number;
      endedAt?: number;
      meta?: Record<string, unknown>;
    }
  | {
      type: "compaction";
      id: string;
      summary: string;
      tailStartId: string;
      compactedAt: number;
    }
  | {
      type: "system-notice";
      id: string;
      notice: string;
      createdAt: number;
      completedAt?: number;
    };

export interface SessionMessage {
  id: string;
  role: "user" | "assistant";
  parts: SessionPart[];
  createdAt: number;
  completedAt?: number;
  runId?: string;
  compacted?: boolean;
}

export interface SessionStep {
  id: string;
  step: number;
  runId?: string;
  startedAt: number;
  completedAt?: number;
  finishReason?: string;
  usage?: unknown;
  error?: string;
}

export interface SessionTodo {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  createdAt?: number;
  updatedAt?: number;
}

export interface Session {
  id: string;
  sessionId?: string;
  title?: string | null;
  createdAt: number;
  updatedAt?: number;
  lastUpdatedAt?: number;
  messages?: SessionMessage[];
  steps?: SessionStep[];
  todos?: SessionTodo[];
  reminders?: unknown[];
  childSessionIds?: string[];
  parentSessionId?: string;
  subAgentDescriptions?: [string, string][];
}

export interface WorkflowState {
  id: string;
  status: "active" | "paused" | "completed" | "failed" | string;
  sessionIds: Record<string, string>;
  taskSessionIds: Record<string, string>;
  currentStep?: string;
  stage?: string;
  artifacts?: Record<string, string | string[] | undefined>;
  agentIds?: Record<string, string>;
  createdAt?: string;
  updatedAt?: string;
  retryCount?: number;
  maxRetries?: number;
  lastError?: string;
}

export type DiffLineType = "context" | "add" | "delete";

export interface DiffLine {
  type: DiffLineType;
  content: string;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string;
  status?: "modified" | "created" | "deleted";
  additions?: number;
  deletions?: number;
  hunks: DiffHunk[];
}

export interface PermissionRequest {
  id: string;
  sessionId: string;
  toolName: string;
  toolCallId: string;
  input: unknown;
  description: string;
  reason?: string;
  approval?: unknown;
  agentName?: string;
  currentDepth?: number;
  decisionDisplay?: string;
  ruleId?: string;
}

export interface QuestionRequest {
  id: string;
  sessionId: string;
  toolName: string;
  toolCallId: string;
  questions: unknown[];
}

export interface CommandResult {
  success: boolean;
  message: string;
}

export type PermissionDecision = "approve_once" | "approve_always" | "deny";

export type QuestionAnswerBody =
  | { answers: string[][] }
  | { isError: true; reason: string };
