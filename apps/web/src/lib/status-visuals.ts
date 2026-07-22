import {
  Calendar,
  Ban,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CirclePause,
  CircleStop,
  CircleX,
  Clock3,
  Gauge,
  LoaderCircle,
  MessageCircleQuestion,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";

export type StatusTone = "brand" | "info" | "success" | "warning" | "error" | "neutral";

export type VisualStatusKind =
  | "running"
  | "loading"
  | "warning"
  | "needs_you"
  | "pending"
  | "paused"
  | "blocked"
  | "budget_limited"
  | "completed"
  | "failed"
  | "stopped"
  | "idle"
  | "unknown"
  | "enabled"
  | "disabled";

export type StatusGlyphSource = LucideIcon | "activity-arc";

export interface StatusVisualSpec {
  readonly glyph: StatusGlyphSource;
  readonly tone: StatusTone;
  readonly loops: boolean;
}

export const STATUS_VISUALS: Readonly<Record<VisualStatusKind, StatusVisualSpec>> = {
  running: { glyph: "activity-arc", tone: "info", loops: true },
  loading: { glyph: LoaderCircle, tone: "info", loops: true },
  warning: { glyph: TriangleAlert, tone: "warning", loops: false },
  needs_you: { glyph: MessageCircleQuestion, tone: "warning", loops: false },
  pending: { glyph: Clock3, tone: "neutral", loops: false },
  paused: { glyph: CirclePause, tone: "warning", loops: false },
  blocked: { glyph: CircleAlert, tone: "warning", loops: false },
  budget_limited: { glyph: Gauge, tone: "warning", loops: false },
  completed: { glyph: CircleCheck, tone: "success", loops: false },
  failed: { glyph: CircleX, tone: "error", loops: false },
  stopped: { glyph: CircleStop, tone: "neutral", loops: false },
  idle: { glyph: Circle, tone: "neutral", loops: false },
  unknown: { glyph: CircleDashed, tone: "neutral", loops: false },
  enabled: { glyph: Calendar, tone: "info", loops: false },
  disabled: { glyph: Ban, tone: "neutral", loops: false },
};

export const STATUS_TONE_CLASS: Readonly<Record<StatusTone, string>> = {
  brand: "text-brand",
  info: "text-info",
  success: "text-success",
  warning: "text-warning",
  error: "text-error",
  neutral: "text-neutral",
};

export const STATUS_SUBTLE_CLASS: Readonly<Record<StatusTone, string>> = {
  brand: "bg-brand-subtle",
  info: "bg-info-muted",
  success: "bg-success-muted",
  warning: "bg-warning-muted",
  error: "bg-error-muted",
  neutral: "bg-neutral-muted",
};

export function statusVisual(kind: VisualStatusKind): StatusVisualSpec {
  return STATUS_VISUALS[kind];
}
