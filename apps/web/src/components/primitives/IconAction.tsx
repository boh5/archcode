import {
  type ButtonHTMLAttributes,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

const VIEWPORT_GUTTER = 8;
const TOOLTIP_GAP = 6;

export function IconAction({
  label,
  children,
  danger = false,
  className = "",
  onBlur,
  onFocus,
  onKeyDown,
  onMouseEnter,
  onMouseLeave,
  ...buttonProps
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "children"> & {
  label: string;
  children: ReactNode;
  danger?: boolean;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const tooltipRef = useRef<HTMLSpanElement>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusedRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const tooltipId = useId();

  const cancelHoverTimer = () => {
    if (hoverTimerRef.current !== null) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = null;
  };

  useEffect(() => () => cancelHoverTimer(), []);

  useLayoutEffect(() => {
    if (!open || buttonRef.current === null || tooltipRef.current === null) return;
    const buttonRect = buttonRef.current.getBoundingClientRect();
    const tooltipRect = tooltipRef.current.getBoundingClientRect();
    const maxLeft = Math.max(VIEWPORT_GUTTER, window.innerWidth - tooltipRect.width - VIEWPORT_GUTTER);
    const left = Math.min(maxLeft, Math.max(VIEWPORT_GUTTER, buttonRect.left + buttonRect.width / 2 - tooltipRect.width / 2));
    const above = buttonRect.top - tooltipRect.height - TOOLTIP_GAP;
    const top = above >= VIEWPORT_GUTTER
      ? above
      : Math.min(window.innerHeight - tooltipRect.height - VIEWPORT_GUTTER, buttonRect.bottom + TOOLTIP_GAP);
    setPosition({ left, top });
  }, [open, label]);

  return (
    <>
      <button
        {...buttonProps}
        ref={buttonRef}
        aria-describedby={open ? tooltipId : undefined}
        aria-label={label}
        className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-sm border border-transparent text-text-tertiary transition-[background-color,border-color,color] duration-[var(--motion-hover)] hover:border-border-default hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-50 ${danger ? "hover:text-error focus-visible:text-error" : "hover:text-text-primary"} ${className}`}
        onBlur={(event) => {
          focusedRef.current = false;
          setOpen(false);
          onBlur?.(event);
        }}
        onFocus={(event) => {
          cancelHoverTimer();
          focusedRef.current = true;
          setOpen(true);
          onFocus?.(event);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
          onKeyDown?.(event);
        }}
        onMouseEnter={(event) => {
          cancelHoverTimer();
          hoverTimerRef.current = setTimeout(() => setOpen(true), 350);
          onMouseEnter?.(event);
        }}
        onMouseLeave={(event) => {
          cancelHoverTimer();
          if (!focusedRef.current) setOpen(false);
          onMouseLeave?.(event);
        }}
        type={buttonProps.type ?? "button"}
      >
        {children}
      </button>
      {open && typeof document !== "undefined" && createPortal(
        <span
          ref={tooltipRef}
          id={tooltipId}
          role="tooltip"
          className="pointer-events-none fixed z-[100] whitespace-nowrap rounded-lg border border-border-default bg-bg-overlay px-2 py-1 text-[11px] leading-4 text-text-primary shadow-md animate-overlay-enter"
          style={position === null ? { left: 0, top: 0, visibility: "hidden" } : position}
        >
          {label}
        </span>,
        document.body,
      )}
    </>
  );
}
