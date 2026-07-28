import { ChevronDown } from "lucide-react";

export function ScrollToLatestButton({
  onClick,
}: {
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="absolute bottom-3 left-1/2 z-[3] flex h-8 w-8 -translate-x-1/2 items-center justify-center rounded-full border border-border-default bg-bg-elevated text-text-secondary shadow-md transition-[background-color,border-color,color] duration-[var(--motion-hover)] hover:border-border-strong hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"
      aria-label="Jump to latest"
      title="Jump to latest"
      data-testid="scroll-to-latest"
      onClick={onClick}
    >
      <ChevronDown size={16} aria-hidden="true" />
    </button>
  );
}
