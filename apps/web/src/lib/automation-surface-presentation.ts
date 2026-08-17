import {
  projectTodoContentExcerpt,
  type ProjectAutomationInventoryItem,
  type ProjectSessionInventoryItem,
  type SessionFamilyActivity,
} from "@archcode/protocol";
import {
  automationHitlSessionCount,
  type AutomationHitlAttention,
  type AutomationSessionLink,
} from "./automation-hitl-attention";
import { automationStatusLabel } from "./automation-status-presentation";
import { formatAutomationScheduleTime, formatAutomationTrigger } from "./automation-trigger-presentation";

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

interface AutomationSurfacePresentationInput {
  readonly item: ProjectAutomationInventoryItem;
  readonly attention: AutomationHitlAttention;
  readonly sessionLinks: readonly AutomationSessionLink[];
  readonly targetSession?: ProjectSessionInventoryItem;
  readonly activityBySessionId: ReadonlyMap<string, SessionFamilyActivity>;
  readonly linkedTodoContent?: string;
  readonly now?: number;
}

export function presentAutomationSurface({
  item,
  attention,
  sessionLinks,
  targetSession,
  activityBySessionId,
  linkedTodoContent,
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
  const contextSubject = linkedTodoContent
    ? `linked to ${projectTodoContentExcerpt(linkedTodoContent)}`
    : projectTodoContentExcerpt(automation.action.message);
  const actionLabel = automation.action.kind === "start_session"
    ? `New Session · ${automation.action.location === "project" ? "Project" : "Worktree"}`
    : "Existing Session";
  const locationLabel = automation.action.kind === "start_session"
    ? automation.action.location === "project" ? "Project checkout" : "Fresh worktree"
    : "Target Session workspace";
  const bindingLabel = automation.action.kind === "start_session"
    ? "Lead + principal"
    : "Target Session’s existing Agent + Profile";

  if (latestInvocation?.status === "failed" || latestInvocation?.status === "missed") {
    const label = latestInvocation.status === "failed" ? "Failed" : "Missed";
    return {
      group: "needs-you",
      statusLabel: label,
      rowSignal: label,
      tone: "error",
      orbit: "failed",
      context: `${trigger} · definition ${definitionLabel.toLocaleLowerCase()} · last run ${label.toLocaleLowerCase()}`,
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
      context: `${trigger} · linked Session needs a response`,
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
      context: `${trigger} · dispatch pending`,
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
      context: `${trigger} · linked Session is running`,
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
    context: `${trigger} · ${contextSubject}`,
    nextRunLabel,
    actionLabel,
    locationLabel,
    bindingLabel,
  };
}
