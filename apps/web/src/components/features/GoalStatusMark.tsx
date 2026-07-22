import { Target } from "lucide-react";
import type { SessionGoalStatus } from "@archcode/protocol";
import { presentSessionGoalStatus } from "../../lib/session-goal-presentation";
import { STATUS_TONE_CLASS } from "../../lib/status-visuals";
import { StatusGlyph } from "../primitives/StatusGlyph";
import { useStatusTransition } from "../primitives/useStatusTransition";

export function GoalStatusMark({
  status,
  identity,
  size = 14,
  label,
}: {
  status: SessionGoalStatus;
  identity: string;
  size?: number;
  label?: string;
}) {
  const presentation = presentSessionGoalStatus(status);
  const accessibleLabel = label ?? presentation.label;
  const transition = useStatusTransition(identity, presentation.kind ?? "idle");
  if (presentation.kind) {
    return <StatusGlyph kind={presentation.kind} label={accessibleLabel} size={size} transition={transition} />;
  }
  return (
    <span
      aria-label={accessibleLabel}
      className={`inline-grid shrink-0 place-items-center ${STATUS_TONE_CLASS.brand}`}
      data-motion="none"
      data-tone="brand"
      data-visual-kind="goal-active"
      role="img"
      style={{ width: size, height: size }}
    >
      <Target aria-hidden="true" size={size} strokeWidth={1.75} />
    </span>
  );
}
