import type { StatusTone, VisualStatusKind } from "../../lib/status-visuals";
import { STATUS_TONE_CLASS, statusVisual } from "../../lib/status-visuals";
import { ActivityArc } from "./ActivityArc";

export function StatusGlyph({
  kind,
  label,
  size = 14,
  tone,
  transition,
  className = "",
}: {
  kind: VisualStatusKind;
  label?: string;
  size?: number;
  tone?: StatusTone;
  transition?: "attention" | "complete";
  className?: string;
}) {
  const spec = statusVisual(kind);
  const resolvedTone = tone ?? spec.tone;

  if (spec.glyph === "activity-arc") {
    return <ActivityArc size={size} tone={resolvedTone} label={label} />;
  }

  const Glyph = spec.glyph;
  const transitionClass = transition === "attention"
    ? "animate-status-attention"
    : transition === "complete"
      ? "animate-status-complete"
      : "";
  const loopClass = spec.loops ? "animate-activity" : "";

  return (
    <span
      className={`inline-grid shrink-0 place-items-center ${STATUS_TONE_CLASS[resolvedTone]} ${transitionClass} ${className}`}
      data-motion={spec.loops ? "loop" : transition ?? "none"}
      data-tone={resolvedTone}
      data-visual-kind={kind}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={{ width: size, height: size }}
    >
      <Glyph className={loopClass} size={size} strokeWidth={1.75} aria-hidden="true" />
    </span>
  );
}
