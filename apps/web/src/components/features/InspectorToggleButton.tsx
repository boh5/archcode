import { PanelRightClose, PanelRightOpen } from "lucide-react";

export function InspectorToggleButton({
  expanded,
  onToggle,
  className = "flex h-8 w-8 shrink-0 items-center justify-center rounded-sm border border-border-default text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary max-[799px]:hidden",
  iconSize = 15,
}: {
  expanded: boolean;
  onToggle: () => void;
  className?: string;
  iconSize?: number;
}) {
  const label = expanded ? "Collapse context inspector" : "Expand context inspector";
  return (
    <button
      type="button"
      data-state={expanded ? "expanded" : "collapsed"}
      title={label}
      aria-label={label}
      aria-controls="context-inspector mobile-context-inspector"
      aria-expanded={expanded}
      className={className}
      onClick={onToggle}
    >
      {expanded
        ? <PanelRightClose size={iconSize} aria-hidden="true" />
        : <PanelRightOpen size={iconSize} aria-hidden="true" />}
    </button>
  );
}
