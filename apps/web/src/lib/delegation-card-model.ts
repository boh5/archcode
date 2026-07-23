import type {
  ToolChildSessionLink,
  ToolPart,
} from "@archcode/protocol";
import { childExecutionVisualKind, presentChildExecutionStatus } from "./execution-status-presentation";
import type { VisualStatusKind } from "./status-visuals";

export interface DelegationCardViewModel {
  sessionId: string;
  focusStoreSessionId: string;
  taskTitle?: string;
  visualKind: VisualStatusKind;
  executionStatusLabel: string;
  executionStatusDetail?: string;
  startedAt?: number;
  hasInput: boolean;
  input?: unknown;
  projectSlug: string;
  canNavigate?: boolean;
}

export interface DelegationCardModelInput {
  part: ToolPart;
  projectSlug: string;
  focusStoreSessionId: string;
  childSessionLinks: readonly ToolChildSessionLink[];
}

export function buildDelegationCardViewModel({
  part,
  projectSlug,
  focusStoreSessionId,
  childSessionLinks,
}: DelegationCardModelInput): DelegationCardViewModel {
  const hasInput = "input" in part;
  const input = hasInput ? part.input : undefined;
  const link = childSessionLinks.find((candidate) => candidate.parentToolCallId === part.toolCallId);

  const sessionId = link?.childSessionId ?? "";
  const taskTitle = link?.title;
  const visualKind: VisualStatusKind = link
    ? childExecutionVisualKind(link.status)
    : part.state === "error" ? "failed"
      : part.state === "completed" ? "completed"
        : part.state === "pending" ? "pending"
          : "running";
  const executionStatusLabel = link
    ? presentChildExecutionStatus(link.status).label
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
    taskTitle,
    visualKind,
    executionStatusLabel,
    executionStatusDetail,
    startedAt,
    hasInput,
    input,
    projectSlug,
    canNavigate: Boolean(link?.childSessionId),
  };
}
