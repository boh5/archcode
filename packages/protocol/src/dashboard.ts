import type { AutomationStatus, AutomationInvocationStatus } from "./types";
import type { SessionGoal } from "./session-goal";
import type { ExecutionEndEvent } from "./types";

/** The Dashboard is a transient read projection, scoped to all projects or one project. */
export type DashboardScope =
  | { kind: "global" }
  | { kind: "project"; projectSlug: string };

/** Presentation-safe latest execution data for one root Session. */
export interface DashboardExecution {
  id: string;
  status: "running" | ExecutionEndEvent["status"];
  startedAt: number;
  endedAt?: number;
}

/** A root Session together with its owned Goal and latest root Execution. */
export interface DashboardRootSession {
  projectSlug: string;
  projectName: string;
  rootSessionId: string;
  sessionTitle: string | null;
  createdAt: number;
  updatedAt: number;
  goal?: SessionGoal;
  latestExecution?: DashboardExecution;
}

/** Presentation-safe latest Invocation data for one Automation. */
export interface DashboardAutomationInvocation {
  id: string;
  status: AutomationInvocationStatus;
  sessionId?: string;
  createdAt: string;
  completedAt?: string;
}

/** An Automation together with its latest Invocation. */
export interface DashboardAutomation {
  projectSlug: string;
  projectName: string;
  id: string;
  name: string;
  status: AutomationStatus;
  createdAt: string;
  updatedAt: string;
  nextFireAt?: string;
  latestInvocation?: DashboardAutomationInvocation;
}

/** A global-scope read failure isolated to its owning project. */
export interface DashboardProjectError {
  projectSlug: string;
  projectName: string;
  message: string;
}

/**
 * The single read contract consumed by both Home and Project Dashboard.
 * It is rebuilt from authoritative Session and Automation state for each read.
 */
export interface DashboardProjection {
  scope: DashboardScope;
  sessions: DashboardRootSession[];
  automations: DashboardAutomation[];
  errors: DashboardProjectError[];
}
