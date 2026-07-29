import { PanelToggleButton, WORKBENCH_PANEL_TOGGLE_CLASS } from "./PanelToggleButton";

export function InspectorToggleButton({
  expanded,
  onToggle,
  className = WORKBENCH_PANEL_TOGGLE_CLASS,
  iconSize = 16,
}: {
  expanded: boolean;
  onToggle: () => void;
  className?: string;
  iconSize?: number;
}) {
  const label = expanded ? "Collapse context inspector" : "Expand context inspector";
  return (
    <PanelToggleButton
      side="right"
      expanded={expanded}
      label={label}
      controls="context-inspector mobile-context-inspector"
      className={className}
      iconSize={iconSize}
      onToggle={onToggle}
    />
  );
}
