import {
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import type { SessionPart } from "@archcode/protocol";
import type { ExecutionWorkstreamSegment } from "../../lib/execution-workstream";
import { useElapsedTime } from "../primitives/TemporalText";

const TOOLTIP_GAP_PX = 8;
const VIEWPORT_GUTTER_PX = 8;
const RAIL_VISIBLE_PADDING_PX = 12;
const REQUEST_SUMMARY_MAX_CHARACTERS = 120;
const RAIL_MAX_HEIGHT = "min(70vh, 40rem, calc(100% - 16px))";

function firstText(parts: readonly SessionPart[]): string | undefined {
  for (const part of parts) {
    if (part.type !== "text") continue;
    const value = part.text.trim();
    if (value) return value;
  }
  return undefined;
}

function segmentRequest(segment: ExecutionWorkstreamSegment): string {
  for (const message of segment.inputMessages) {
    const value = firstText(message.parts);
    if (!value) continue;
    const normalized = value.replace(/\s+/g, " ");
    return normalized.length <= REQUEST_SUMMARY_MAX_CHARACTERS
      ? normalized
      : `${normalized.slice(0, REQUEST_SUMMARY_MAX_CHARACTERS - 1).trimEnd()}…`;
  }
  return "Work in progress";
}

function SegmentMarker({
  segment,
  ordinal,
  current,
  live,
  tabIndex,
  buttonRef,
  onNavigate,
  onMove,
  tooltipId,
  tooltipVisible,
  onTooltipFocus,
  onTooltipBlur,
  onTooltipHover,
  onTooltipLeave,
}: {
  segment: ExecutionWorkstreamSegment;
  ordinal: number;
  current: boolean;
  live: boolean;
  tabIndex: number;
  buttonRef: (button: HTMLButtonElement | null) => void;
  onNavigate: () => void;
  onMove: (direction: "previous" | "next" | "first" | "last") => void;
  tooltipId: string;
  tooltipVisible: boolean;
  onTooltipFocus: () => void;
  onTooltipBlur: () => void;
  onTooltipHover: () => void;
  onTooltipLeave: () => void;
}) {
  const duration = useElapsedTime({
    startedAt: segment.windowStartedAt,
    active: live,
    durationMs: segment.activeDurationMs,
    durationUpdatedAt: segment.windowEndedAt,
    endedAt: segment.windowEndedAt,
  });
  const label = [
    `Message ${ordinal}`,
    segmentRequest(segment),
    duration,
  ]
    .filter(Boolean)
    .join(", ");
  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const direction =
      event.key === "ArrowUp"
        ? "previous"
        : event.key === "ArrowDown"
          ? "next"
          : event.key === "Home"
            ? "first"
            : event.key === "End"
              ? "last"
              : undefined;
    if (event.key === "Escape") {
      onTooltipBlur();
      onTooltipLeave();
      return;
    }
    if (!direction) return;
    event.preventDefault();
    onMove(direction);
  };
  return (
    <button
      ref={buttonRef}
      type="button"
      className="group flex h-6 w-7 shrink-0 items-center justify-start rounded-sm pl-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
      aria-label={label}
      aria-current={current ? "location" : undefined}
      aria-describedby={tooltipVisible ? tooltipId : undefined}
      tabIndex={tabIndex}
      data-execution-navigation-id={segment.id}
      onBlur={onTooltipBlur}
      onClick={onNavigate}
      onFocus={onTooltipFocus}
      onKeyDown={handleKeyDown}
      onMouseEnter={onTooltipHover}
      onMouseLeave={onTooltipLeave}
    >
      <span
        className={`h-0.5 rounded-full transition-[width,background-color] duration-[var(--motion-hover)] group-hover:w-5 group-focus-visible:w-5 ${current ? "w-4 bg-text-secondary" : "w-2 bg-border-strong"}`}
        aria-hidden="true"
      />
    </button>
  );
}

function SegmentTooltip({
  segment,
  ordinal,
  active,
}: {
  segment: ExecutionWorkstreamSegment;
  ordinal: number;
  active: boolean;
}) {
  const duration = useElapsedTime({
    startedAt: segment.windowStartedAt,
    active,
    durationMs: segment.activeDurationMs,
    durationUpdatedAt: segment.windowEndedAt,
    endedAt: segment.windowEndedAt,
  });
  return (
    <>
      <strong className="block font-semibold">
        Message {ordinal}
      </strong>
      <span className="mt-1 block line-clamp-3 text-text-secondary">
        {segmentRequest(segment)}
      </span>
      <span className="mt-1 block text-text-tertiary">
        {active ? "Working for" : "Worked for"} {duration}
      </span>
    </>
  );
}

export function ExecutionNavigationRail({
  segments,
  currentSegmentId,
  running,
  left,
  visible,
  onNavigate,
}: {
  segments: readonly ExecutionWorkstreamSegment[];
  currentSegmentId: string | null;
  running: boolean;
  left: number;
  visible: boolean;
  onNavigate: (segmentId: string, behavior: ScrollBehavior) => void;
}) {
  const markerByIdRef = useRef(new Map<string, HTMLButtonElement>());
  const navigationRef = useRef<HTMLElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const tooltipId = useId();
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [tooltipPosition, setTooltipPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const tooltipSegmentId = focusedId ?? hoveredId;
  const currentIndex = Math.max(
    0,
    segments.findIndex((segment) => segment.id === currentSegmentId),
  );
  const tooltipSegment = segments.find(
    (segment) => segment.id === tooltipSegmentId,
  );
  const positionTooltip = useCallback((segmentId: string) => {
    if (!tooltipRef.current) return;
    const marker = markerByIdRef.current.get(segmentId);
    if (!marker) return;
    const markerRect = marker.getBoundingClientRect();
    const tooltipRect = tooltipRef.current.getBoundingClientRect();
    setTooltipPosition({
      left: Math.min(
        Math.max(
          VIEWPORT_GUTTER_PX,
          window.innerWidth - tooltipRect.width - VIEWPORT_GUTTER_PX,
        ),
        markerRect.right + TOOLTIP_GAP_PX,
      ),
      top: Math.min(
        Math.max(
          VIEWPORT_GUTTER_PX,
          markerRect.top + markerRect.height / 2 - tooltipRect.height / 2,
        ),
        Math.max(
          VIEWPORT_GUTTER_PX,
          window.innerHeight - tooltipRect.height - VIEWPORT_GUTTER_PX,
        ),
      ),
    });
  }, []);
  const keepMarkerVisible = useCallback((segmentId: string | null) => {
    const navigation = navigationRef.current;
    const marker =
      segmentId === null ? undefined : markerByIdRef.current.get(segmentId);
    if (!navigation || !marker) return;
    const navigationRect = navigation.getBoundingClientRect();
    const markerRect = marker.getBoundingClientRect();
    const top = navigationRect.top + RAIL_VISIBLE_PADDING_PX;
    const bottom = navigationRect.bottom - RAIL_VISIBLE_PADDING_PX;
    if (markerRect.top < top) navigation.scrollTop -= top - markerRect.top;
    else if (markerRect.bottom > bottom)
      navigation.scrollTop += markerRect.bottom - bottom;
  }, []);
  useLayoutEffect(() => {
    if (!visible) return;
    keepMarkerVisible(currentSegmentId ?? focusedId);
    if (tooltipSegmentId) positionTooltip(tooltipSegmentId);
  }, [
    currentSegmentId,
    focusedId,
    keepMarkerVisible,
    positionTooltip,
    tooltipSegmentId,
    visible,
  ]);
  useLayoutEffect(() => {
    if (
      !visible ||
      typeof ResizeObserver === "undefined" ||
      !navigationRef.current
    )
      return;
    const navigation = navigationRef.current;
    const observer = new ResizeObserver(() => {
      keepMarkerVisible(currentSegmentId ?? focusedId);
      if (tooltipSegmentId) positionTooltip(tooltipSegmentId);
    });
    observer.observe(navigation);
    if (navigation.parentElement) observer.observe(navigation.parentElement);
    return () => observer.disconnect();
  }, [
    currentSegmentId,
    focusedId,
    keepMarkerVisible,
    positionTooltip,
    tooltipSegmentId,
    visible,
  ]);
  if (!visible) return null;
  const move = (
    id: string,
    direction: "previous" | "next" | "first" | "last",
  ) => {
    const index = segments.findIndex((segment) => segment.id === id);
    const nextIndex =
      direction === "first"
        ? 0
        : direction === "last"
          ? segments.length - 1
          : direction === "previous"
            ? Math.max(0, index - 1)
            : Math.min(segments.length - 1, index + 1);
    const target = segments[nextIndex];
    if (!target) return;
    onNavigate(target.id, "smooth");
    requestAnimationFrame(() =>
      markerByIdRef.current.get(target.id)?.focus({ preventScroll: true }),
    );
  };
  return (
    <>
      <nav
        ref={navigationRef}
        className="absolute top-1/2 z-[2] flex -translate-y-1/2 flex-col overflow-y-auto py-3 [@media(pointer:coarse)]:hidden"
        style={{
          left,
          maxHeight: RAIL_MAX_HEIGHT,
          maskImage:
            "linear-gradient(to bottom, transparent, black 12px, black calc(100% - 12px), transparent)",
          WebkitMaskImage:
            "linear-gradient(to bottom, transparent, black 12px, black calc(100% - 12px), transparent)",
        }}
        aria-label="Message navigation"
        data-testid="execution-navigation-rail"
        onScroll={() => {
          if (tooltipSegmentId) positionTooltip(tooltipSegmentId);
        }}
      >
        {segments.map((segment, index) => (
          <SegmentMarker
            key={segment.id}
            segment={segment}
            ordinal={index + 1}
            current={segment.id === currentSegmentId}
            live={running && index === segments.length - 1}
            tabIndex={index === currentIndex ? 0 : -1}
            buttonRef={(button) => {
              if (button) markerByIdRef.current.set(segment.id, button);
              else markerByIdRef.current.delete(segment.id);
            }}
            onNavigate={() => onNavigate(segment.id, "smooth")}
            onMove={(direction) => move(segment.id, direction)}
            tooltipId={tooltipId}
            tooltipVisible={tooltipSegmentId === segment.id}
            onTooltipFocus={() => {
              setTooltipPosition(null);
              setFocusedId(segment.id);
            }}
            onTooltipBlur={() => setFocusedId(null)}
            onTooltipHover={() => {
              setTooltipPosition(null);
              setHoveredId(segment.id);
            }}
            onTooltipLeave={() => setHoveredId(null)}
          />
        ))}
      </nav>
      {tooltipSegment &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={tooltipRef}
            id={tooltipId}
            role="tooltip"
            className="pointer-events-none fixed z-[100] max-w-[320px] rounded-md border border-border-default bg-bg-overlay px-3 py-2 text-[11px] leading-4 text-text-primary shadow-md animate-overlay-enter"
            style={
              tooltipPosition === null
                ? { left: 0, top: 0, visibility: "hidden" }
                : tooltipPosition
            }
          >
            <SegmentTooltip
              segment={tooltipSegment}
              active={
                running
                && tooltipSegment.id === segments.at(-1)?.id
              }
              ordinal={
                segments.findIndex(
                  (segment) => segment.id === tooltipSegment.id,
                ) + 1
              }
            />
          </div>,
          document.body,
        )}
    </>
  );
}
