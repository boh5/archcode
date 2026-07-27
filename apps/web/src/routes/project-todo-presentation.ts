import {
  Archive,
  CircleCheck,
  CircleDot,
  CirclePlay,
  CircleX,
  Lightbulb,
  type LucideIcon,
} from "lucide-react";
import type { StatusTone } from "../lib/status-visuals";

export type ProjectTodoLane = "idea" | "ready" | "in_progress" | "done";
export type ProjectTodoStatus = ProjectTodoLane | "rejected";

export interface ProjectTodoCardPresentation {
  readonly label: "Idea" | "Ready" | "In Progress" | "Done" | "Rejected" | "Archived";
  readonly Icon: LucideIcon;
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

const CARD_PRESENTATIONS: Readonly<Record<ProjectTodoCardPresentation["label"], ProjectTodoCardPresentation>> = {
  Idea: { label: "Idea", Icon: Lightbulb, tone: "brand" },
  Ready: { label: "Ready", Icon: CircleDot, tone: "neutral" },
  "In Progress": { label: "In Progress", Icon: CirclePlay, tone: "signal" },
  Done: { label: "Done", Icon: CircleCheck, tone: "success" },
  Rejected: { label: "Rejected", Icon: CircleX, tone: "warning" },
  Archived: { label: "Archived", Icon: Archive, tone: "neutral" },
};

export const PROJECT_TODO_LANE_PRESENTATIONS: Readonly<Record<ProjectTodoLane, ProjectTodoLanePresentation>> = {
  idea: { title: "Ideas", hint: "Capture first, shape later", emptyTitle: "No ideas yet", emptyHint: "Capture an idea above.", Icon: Lightbulb, tone: "brand" },
  ready: { title: "Ready", hint: "Clear enough to hand off", emptyTitle: "Nothing ready", emptyHint: "Move an idea here when it is ready.", Icon: CircleDot, tone: "neutral" },
  in_progress: { title: "In Progress", hint: "Work underway", emptyTitle: "No work in progress", emptyHint: "Start work or drag a Todo here.", Icon: CirclePlay, tone: "signal" },
  done: { title: "Done", hint: "Explicitly completed", emptyTitle: "Nothing completed", emptyHint: "Completed Todos stay visible here.", Icon: CircleCheck, tone: "success" },
};

/** Pure display mapping; Todo status is the only lifecycle source of truth. */
export function presentProjectTodoCard(input: {
  readonly status: ProjectTodoStatus;
  readonly archivedAt?: number;
}): ProjectTodoCardPresentation {
  if (input.archivedAt !== undefined) return CARD_PRESENTATIONS.Archived;
  if (input.status === "rejected") return CARD_PRESENTATIONS.Rejected;
  if (input.status === "done") return CARD_PRESENTATIONS.Done;
  if (input.status === "in_progress") return CARD_PRESENTATIONS["In Progress"];
  if (input.status === "ready") return CARD_PRESENTATIONS.Ready;
  return CARD_PRESENTATIONS.Idea;
}
