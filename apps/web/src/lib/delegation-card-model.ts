import type {
  AgentDescriptor,
  ToolChildSessionLink,
  ToolChildSessionLinkStatus,
  ToolPart,
} from "@archcode/protocol";
import { resolveAgentDisplayName } from "./agent-constants";
import { childExecutionVisualKind, presentChildExecutionStatus } from "./execution-status-presentation";
import type { VisualStatusKind } from "./status-visuals";

export interface DelegationCardViewModel {
  sessionId: string;
  focusStoreSessionId: string;
  agentDisplayName?: string;
  profile?: string;
  skills: string[];
  taskTitle?: string;
  visualKind: VisualStatusKind;
  executionStatusLabel: string;
  executionStatusDetail?: string;
  startedAt?: number;
  taskSummary?: string;
  background?: boolean;
  projectSlug: string;
  canNavigate?: boolean;
}

export interface DelegationCardModelInput {
  part: ToolPart;
  projectSlug: string;
  focusStoreSessionId: string;
  childSessionLinks: readonly ToolChildSessionLink[];
  agentDescriptors: readonly AgentDescriptor[];
}

export function parseDelegationInput(input: unknown): Record<string, unknown> | null {
  if (!input) return null;
  if (typeof input === "object" && input !== null) return input as Record<string, unknown>;
  if (typeof input === "string") {
    try {
      return JSON.parse(input) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return null;
}

export function formatDelegationLinkStatus(status: ToolChildSessionLinkStatus): string {
  return presentChildExecutionStatus(status).label;
}

export function buildDelegationCardViewModel({
  part,
  projectSlug,
  focusStoreSessionId,
  childSessionLinks,
  agentDescriptors,
}: DelegationCardModelInput): DelegationCardViewModel {
  const parsedInput = parseDelegationInput("input" in part ? part.input : undefined);
  const link = childSessionLinks.find((candidate) => candidate.parentToolCallId === part.toolCallId);

  const sessionId = link?.childSessionId ?? "";
  const agentType = link?.childAgentName
    ?? (typeof parsedInput?.agent_type === "string" ? parsedInput.agent_type : undefined);
  const agentDisplayName = agentType === undefined
    ? undefined
    : resolveAgentDisplayName(agentType, agentDescriptors);
  const profile = link?.childProfile
    ?? (typeof parsedInput?.profile === "string" ? parsedInput.profile : undefined);
  const skills = link?.childSkillNames ?? (Array.isArray(parsedInput?.skills) ? parsedInput.skills.filter((skill): skill is string => typeof skill === "string") : []);
  const taskTitle = link?.title ?? (typeof parsedInput?.title === "string" ? parsedInput.title : undefined);
  const taskSummary = typeof parsedInput?.objective === "string" ? parsedInput.objective : undefined;
  const background = link?.background
    ?? (typeof parsedInput?.background === "boolean" ? parsedInput.background : undefined);
  const visualKind: VisualStatusKind = link
    ? childExecutionVisualKind(link.status)
    : part.state === "error" ? "failed"
      : part.state === "completed" ? "completed"
        : part.state === "pending" ? "pending"
          : "running";
  const executionStatusLabel = link
    ? formatDelegationLinkStatus(link.status)
    : visualKind === "failed" ? "Stopped"
      : visualKind === "completed" ? "Completed"
        : visualKind === "pending" ? "Pending"
          : "Running";
  const executionStatusDetail = link
    ? presentChildExecutionStatus(link.status).detail
    : visualKind === "failed" ? "Error" : undefined;
  const startedAt = link?.startedAt
    ?? ("startedAt" in part ? (part as { startedAt: number }).startedAt : part.createdAt);

  return {
    sessionId,
    focusStoreSessionId,
    agentDisplayName,
    profile,
    skills,
    taskTitle,
    visualKind,
    executionStatusLabel,
    executionStatusDetail,
    startedAt,
    taskSummary,
    background,
    projectSlug,
    canNavigate: Boolean(link?.childSessionId),
  };
}
