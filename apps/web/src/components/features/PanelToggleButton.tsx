import {
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
} from "lucide-react";

export const WORKBENCH_PANEL_TOGGLE_CLASS =
  "flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-text-tertiary transition-colors duration-[var(--motion-fast)] hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11";

export function PanelToggleButton({
  side,
  expanded,
  label,
  controls,
  onToggle,
  className = WORKBENCH_PANEL_TOGGLE_CLASS,
  iconSize = 16,
}: {
  side: "left" | "right";
  expanded: boolean;
  label: string;
  controls: string;
  onToggle: () => void;
  className?: string;
  iconSize?: number;
}) {
  const Icon = side === "left"
    ? expanded ? PanelLeftClose : PanelLeftOpen
    : expanded ? PanelRightClose : PanelRightOpen;

  return (
    <button
      type="button"
      data-panel-side={side}
      data-state={expanded ? "expanded" : "collapsed"}
      title={label}
      aria-label={label}
      aria-controls={controls}
      aria-expanded={expanded}
      className={className}
      onClick={onToggle}
    >
      <Icon size={iconSize} aria-hidden="true" />
    </button>
  );
}
