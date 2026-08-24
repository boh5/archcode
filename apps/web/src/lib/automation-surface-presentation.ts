import {
  type AutomationInvocation,
  type ProjectAutomationInventoryItem,
  type ProjectSessionInventoryItem,
  type SessionFamilyActivity,
} from "@archcode/protocol";
import {
  automationHitlSessionCount,
  type AutomationHitlAttention,
  type AutomationSessionLink,
} from "./automation-hitl-attention";
import { automationInvocationStatusLabel, automationStatusLabel } from "./automation-status-presentation";
import { formatAutomationScheduleTime, formatAutomationTrigger } from "./automation-trigger-presentation";
import type { VisualStatusKind } from "./status-visuals";

export type AutomationSurfaceGroup = "needs-you" | "scheduled" | "paused" | "inactive";
export type AutomationSurfaceTone = "error" | "attention" | "running" | "neutral";
export type AutomationSurfaceOrbit = "failed" | "attention" | "running" | "scheduled" | "paused";

export interface AutomationSurfacePresentation {
  readonly group: AutomationSurfaceGroup;
  readonly statusLabel: string;
  readonly rowSignal: string;
  readonly tone: AutomationSurfaceTone;
  readonly orbit: AutomationSurfaceOrbit;
  readonly context: string;
  readonly nextRunLabel: string;
  readonly actionLabel: string;
  readonly locationLabel: string;
  readonly bindingLabel: string;
}

export interface AutomationInvocationRowPresentation {
  readonly visualKind: VisualStatusKind;
  readonly statusLabel: string;
  readonly openSessionId?: string;
}

interface AutomationSurfacePresentationInput {
  readonly item: ProjectAutomationInventoryItem;
  readonly attention: AutomationHitlAttention;
  readonly sessionLinks: readonly AutomationSessionLink[];
  readonly targetSession?: ProjectSessionInventoryItem;
  readonly activityBySessionId: ReadonlyMap<string, SessionFamilyActivity>;
  readonly now?: number;
}

export function presentAutomationSurface({
  item,
  attention,
  sessionLinks,
  targetSession,
  activityBySessionId,
  now,
}: AutomationSurfacePresentationInput): AutomationSurfacePresentation {
  const { automation, latestInvocation } = item;
  const definitionGroup = automation.status === "active"
    ? "scheduled"
    : automation.status === "paused"
      ? "paused"
      : "inactive";
  const trigger = formatAutomationTrigger(automation.trigger);
  const definitionLabel = automation.status === "active" ? "Scheduled" : automationStatusLabel(automation.status);
  const nextRunLabel = automation.nextFireAt
    ? formatAutomationScheduleTime(automation.nextFireAt, now)
    : definitionLabel;
  const sourceLabel = automation.origin.kind === "todo"
    ? "Todo"
    : automation.origin.kind === "session"
      ? "Session"
      : "Direct";
  const actionLabel = automation.action.kind === "start_session"
    ? "Start new Lead Session"
    : "Send message";
  const locationLabel = automation.action.kind === "start_session"
    ? automation.action.location === "project" ? "Project checkout" : "Managed worktree"
    : "Existing Session";
  const bindingLabel = automation.action.kind === "start_session"
    ? "Lead · principal"
    : "Existing Session";

  if (latestInvocation?.status === "failed" || latestInvocation?.status === "missed") {
    const label = latestInvocation.status === "failed" ? "Failed" : "Missed";
    return {
      group: "needs-you",
      statusLabel: label,
      rowSignal: label,
      tone: "error",
      orbit: "failed",
      context: `${sourceLabel} · Last Invocation ${label.toLocaleLowerCase()}`,
      nextRunLabel,
      actionLabel,
      locationLabel,
      bindingLabel,
    };
  }

  if (automationHitlSessionCount(attention) > 0) {
    return {
      group: "needs-you",
      statusLabel: "Needs you",
      rowSignal: "Needs you",
      tone: "attention",
      orbit: "attention",
      context: `${sourceLabel} · Linked Session needs a response`,
      nextRunLabel,
      actionLabel,
      locationLabel,
      bindingLabel,
    };
  }

  if (latestInvocation?.status === "pending") {
    return {
      group: definitionGroup,
      statusLabel: "Pending",
      rowSignal: "Pending",
      tone: "neutral",
      orbit: definitionGroup === "scheduled" ? "scheduled" : "paused",
      context: `${sourceLabel} · Dispatch pending`,
      nextRunLabel,
      actionLabel,
      locationLabel,
      bindingLabel,
    };
  }

  const linkedSessions = automation.action.kind === "start_session"
    ? sessionLinks.map((link) => ({ sessionId: link.sessionId, latestExecution: link.latestExecution }))
    : targetSession
      ? [{ sessionId: targetSession.session.sessionId, latestExecution: targetSession.latestExecution }]
      : [];
  const running = linkedSessions.some(({ sessionId, latestExecution }) => {
    const activity = activityBySessionId.get(sessionId);
    return latestExecution?.status === "running" || activity === "running" || activity === "resuming";
  });
  if (running) {
    return {
      group: definitionGroup,
      statusLabel: "Running",
      rowSignal: "Running",
      tone: "running",
      orbit: "running",
      context: `${sourceLabel} · Linked Session running`,
      nextRunLabel,
      actionLabel,
      locationLabel,
      bindingLabel,
    };
  }

  return {
    group: definitionGroup,
    statusLabel: definitionLabel,
    rowSignal: definitionGroup === "scheduled" ? nextRunLabel : definitionLabel,
    tone: "neutral",
    orbit: definitionGroup === "scheduled" ? "scheduled" : "paused",
    context: `${sourceLabel} · ${trigger}`,
    nextRunLabel,
    actionLabel,
    locationLabel,
    bindingLabel,
  };
}

export function presentAutomationInvocationRow(
  invocation: AutomationInvocation,
  linkedSession: ProjectSessionInventoryItem | undefined,
  activity: SessionFamilyActivity | undefined,
): AutomationInvocationRowPresentation {
  const openSessionId = linkedSession?.session.sessionId;
  const withLink = (presentation: Omit<AutomationInvocationRowPresentation, "openSessionId">): AutomationInvocationRowPresentation => ({
    ...presentation,
    ...(openSessionId === undefined ? {} : { openSessionId }),
  });

  if (invocation.status === "failed" || invocation.status === "missed") {
    return withLink({ visualKind: "failed", statusLabel: automationInvocationStatusLabel(invocation.status) });
  }
  if (invocation.status === "cancelled") {
    return withLink({ visualKind: "stopped", statusLabel: "Cancelled" });
  }
  if (invocation.status === "pending") {
    return withLink({ visualKind: "pending", statusLabel: "Pending" });
  }

  if (linkedSession !== undefined) {
    if (activity === "waiting_for_human") return withLink({ visualKind: "pending", statusLabel: "Waiting" });
    if (activity === "running") return withLink({ visualKind: "running", statusLabel: "Running" });
    if (activity === "resuming") return withLink({ visualKind: "running", statusLabel: "Resuming" });
    if (activity === "stopping") return withLink({ visualKind: "running", statusLabel: "Stopping" });

    const executionStatus = linkedSession.latestExecution?.status;
    if (executionStatus === "running") return withLink({ visualKind: "running", statusLabel: "Running" });
    if (executionStatus === "completed") return withLink({ visualKind: "completed", statusLabel: "Completed" });
    if (executionStatus === "failed" || executionStatus === "timed_out" || executionStatus === "max_steps") {
      return withLink({ visualKind: "failed", statusLabel: "Failed" });
    }
    if (executionStatus === "suspended") return withLink({ visualKind: "blocked", statusLabel: "Suspended" });
    if (executionStatus === "aborted" || executionStatus === "cancelled" || executionStatus === "interrupted") {
      const detail = executionStatus === "aborted" ? "Aborted" : executionStatus === "cancelled" ? "Cancelled" : "Interrupted";
      return withLink({ visualKind: "stopped", statusLabel: `Stopped · ${detail}` });
    }
  }

  return withLink({ visualKind: "idle", statusLabel: "Dispatched" });
}
