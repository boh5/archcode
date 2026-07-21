import type {
  AgentDescriptor,
  ToolChildSessionLink,
  ToolChildSessionLinkStatus,
  ToolPart,
} from "@archcode/protocol";
import { resolveAgentDisplayName, type BadgeStatus } from "./agent-constants";

export type DelegationToolStatus = "success" | "error" | "default";
export interface DelegationCardViewModel {
  sessionId: string;
  focusStoreSessionId: string;
  agentType: string;
  agentDisplayName: string;
  profile: string;
  skills: string[];
  taskTitle?: string;
  executionStatus: BadgeStatus;
  depth: number;
  startedAt: number;
  taskSummary: string;
  tools: Array<{ name: string; status: DelegationToolStatus; input?: unknown }>;
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

export function mapDelegationLinkStatusToBadge(status: ToolChildSessionLinkStatus): BadgeStatus {
  switch (status) {
    case "completed": return "completed";
    case "waiting_for_human": return "pending";
    case "running":
    case "linked":
    case "cancelling": return "running";
    case "failed":
    case "timed_out":
    case "cancelled":
    case "interrupted": return "error";
  }
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
  const agentType = link?.childAgentName ?? (parsedInput?.agent_type as string) ?? "unknown";
  const agentDisplayName = resolveAgentDisplayName(agentType, agentDescriptors);
  const profile = link?.childProfile ?? (parsedInput?.profile as string) ?? "unknown";
  const skills = link?.childSkillNames ?? (Array.isArray(parsedInput?.skills) ? parsedInput.skills.filter((skill): skill is string => typeof skill === "string") : []);
  const taskTitle = link?.title ?? (parsedInput?.title as string);
  const taskSummary = typeof parsedInput?.objective === "string" ? parsedInput.objective : "";
  const executionStatus: BadgeStatus = link
    ? mapDelegationLinkStatusToBadge(link.status)
    : part.state === "error" ? "error"
      : part.state === "completed" ? "completed"
        : part.state === "pending" ? "pending"
          : "running";
  const depth = link?.depth ?? 1;
  const startedAt = link?.startedAt
    ?? ("startedAt" in part ? (part as { startedAt: number }).startedAt : part.createdAt);

  return {
    sessionId,
    focusStoreSessionId,
    agentType,
    agentDisplayName,
    profile,
    skills,
    taskTitle,
    executionStatus,
    depth,
    startedAt,
    taskSummary,
    tools: [],
    projectSlug,
    canNavigate: Boolean(link?.childSessionId),
  };
}
