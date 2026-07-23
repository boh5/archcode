import {
  Archive,
  Ban,
  Calendar,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CirclePause,
  CircleX,
  Clock3,
  Lightbulb,
  LoaderCircle,
  MessageCircle,
  Play,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import type { SessionFamilyActivity } from "@archcode/protocol";
import type { StatusTone } from "../lib/status-visuals";

export type ProjectTodoLane = "idea" | "ready" | "in_progress" | "done";
export type ProjectTodoStatus = "idea" | "ready" | "done" | "rejected";
export type ProjectTodoActivationKind = "session" | "automation";
export type ProjectTodoAutomationStatus = "active" | "paused" | "disabled";
export type ProjectTodoGlyph = LucideIcon | "activity-arc";

export interface ProjectTodoCardPresentation {
  readonly label: "Idea" | "Ready" | "In Progress" | "Done" | "Rejected" | "Archived";
  readonly Icon: ProjectTodoGlyph;
  readonly tone: StatusTone;
}

export interface ProjectTodoLanePresentation {
  readonly title: string;
  readonly hint: string;
  readonly emptyTitle: string;
  readonly emptyHint: string;
  readonly Icon: LucideIcon;
  readonly tone: StatusTone;
}

export interface ProjectTodoAssociationPresentation {
  readonly Icon: ProjectTodoGlyph;
  readonly tone: StatusTone;
  readonly motion: "none" | "loop";
}

const CARD_PRESENTATIONS: Readonly<Record<ProjectTodoCardPresentation["label"], ProjectTodoCardPresentation>> = {
  Idea: { label: "Idea", Icon: Lightbulb, tone: "brand" },
  Ready: { label: "Ready", Icon: CircleDot, tone: "neutral" },
  "In Progress": { label: "In Progress", Icon: Play, tone: "neutral" },
  Done: { label: "Done", Icon: CircleCheck, tone: "success" },
  Rejected: { label: "Rejected", Icon: CircleX, tone: "warning" },
  Archived: { label: "Archived", Icon: Archive, tone: "neutral" },
};

export const PROJECT_TODO_LANE_PRESENTATIONS: Readonly<Record<ProjectTodoLane, ProjectTodoLanePresentation>> = {
  idea: {
    title: "Ideas",
    hint: "Capture first, shape later",
    emptyTitle: "No ideas yet",
    emptyHint: "Capture an idea above.",
    Icon: Lightbulb,
    tone: "brand",
  },
  ready: {
    title: "Ready",
    hint: "Clear enough to hand off",
    emptyTitle: "Nothing ready",
    emptyHint: "Shape an idea to move it here.",
    Icon: CircleDot,
    tone: "neutral",
  },
  in_progress: {
    title: "In Progress",
    hint: "Connected to active work",
    emptyTitle: "No active work",
    emptyHint: "Start a ready Todo to link work.",
    Icon: Play,
    tone: "signal",
  },
  done: {
    title: "Done",
    hint: "Explicitly completed",
    emptyTitle: "Nothing completed",
    emptyHint: "Completed Todos stay visible here.",
    Icon: CircleCheck,
    tone: "success",
  },
};

/**
 * Presentation-only precedence. This intentionally does not group, mutate, or
 * reinterpret a Project Todo's persisted lifecycle.
 */
export function presentProjectTodoCard(input: {
  readonly status: ProjectTodoStatus;
  readonly archivedAt?: number;
  readonly hasActivation: boolean;
}): ProjectTodoCardPresentation {
  if (input.archivedAt !== undefined) return CARD_PRESENTATIONS.Archived;
  if (input.status === "rejected") return CARD_PRESENTATIONS.Rejected;
  if (input.status === "done") return CARD_PRESENTATIONS.Done;
  if (input.hasActivation) return CARD_PRESENTATIONS["In Progress"];
  if (input.status === "ready") return CARD_PRESENTATIONS.Ready;
  return CARD_PRESENTATIONS.Idea;
}

/**
 * Animation eligibility is based only on authoritative query/runtime facts
 * supplied by the route. An Activation itself is never evidence of running.
 */
export function presentProjectTodoAssociation(input: {
  readonly resourceLoading: boolean;
  readonly runtimeInitialized: boolean;
  readonly sessionActivity?: SessionFamilyActivity;
  readonly resourceId?: string;
  readonly resourceAvailable?: boolean;
  readonly automationStatus?: ProjectTodoAutomationStatus;
}): ProjectTodoAssociationPresentation {
  if (input.resourceId !== undefined && input.resourceLoading) return { Icon: LoaderCircle, tone: "neutral", motion: "loop" };
  if (input.sessionActivity === "running") return { Icon: "activity-arc", tone: "signal", motion: "loop" };
  if (input.sessionActivity === "stopping") return { Icon: "activity-arc", tone: "warning", motion: "loop" };
  if (input.resourceId === undefined) return { Icon: Clock3, tone: "neutral", motion: "none" };
  if (input.resourceAvailable === false) return { Icon: TriangleAlert, tone: "warning", motion: "none" };
  if (!input.runtimeInitialized) return { Icon: CircleDashed, tone: "neutral", motion: "none" };
  if (input.automationStatus === "active") return { Icon: Calendar, tone: "brand", motion: "none" };
  if (input.automationStatus === "paused") return { Icon: CirclePause, tone: "warning", motion: "none" };
  if (input.automationStatus === "disabled") return { Icon: Ban, tone: "neutral", motion: "none" };
  return { Icon: CircleDot, tone: "neutral", motion: "none" };
}

export const PROJECT_TODO_DISCUSSION_PRESENTATION = {
  Icon: MessageCircle,
  tone: "brand",
} as const satisfies { readonly Icon: LucideIcon; readonly tone: StatusTone };
