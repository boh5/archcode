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
import type { ExecutionWorkstreamExecution } from "../../lib/execution-workstream";
import { presentExecutionStatus } from "../../lib/execution-status-presentation";
import { useElapsedTime } from "../primitives/TemporalText";

const TOOLTIP_GAP_PX = 8;
const VIEWPORT_GUTTER_PX = 8;
const RAIL_VISIBLE_PADDING_PX = 12;
const REQUEST_SUMMARY_MAX_CHARACTERS = 120;
const RAIL_MAX_HEIGHT = "min(70vh, 40rem, calc(100% - 16px))";

function firstText(parts: readonly SessionPart[]): string | undefined {
  for (const part of parts) {
    if (part.type !== "text") continue;
    const text = part.text.trim();
    if (text.length > 0) return text;
  }
  return undefined;
}

function executionRequest(execution: ExecutionWorkstreamExecution): string {
  for (const message of execution.userMessages) {
    const text = firstText(message.parts);
    if (text) {
      const normalized = text.replace(/\s+/g, " ");
      if (normalized.length <= REQUEST_SUMMARY_MAX_CHARACTERS) return normalized;
      return `${normalized.slice(0, REQUEST_SUMMARY_MAX_CHARACTERS - 1).trimEnd()}…`;
    }
  }
  switch (execution.record.origin) {
    case "goal_continuation":
      return "Goal continuation";
    case "tool_batch":
      return "Tool batch continuation";
    case "tool_call":
      return "Tool continuation";
    case "user_message":
      return "User request";
  }
}

function ExecutionNavigationMarker({
  execution,
  current,
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
  execution: ExecutionWorkstreamExecution;
  current: boolean;
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
    startedAt: execution.record.startedAt,
    active: execution.record.status === "running",
    durationMs: execution.record.durationMs,
    endedAt: execution.record.endedAt,
  });
  const request = executionRequest(execution);
  const status = presentExecutionStatus(execution.record.status);
  const extraInputs = Math.max(0, execution.userMessages.length - 1);
  const label = [
    `Execution ${execution.number}`,
    request,
    status.label,
    duration,
    extraInputs > 0 ? `${extraInputs} additional inputs` : undefined,
  ].filter(Boolean).join(", ");

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    let direction: "previous" | "next" | "first" | "last" | undefined;
    if (event.key === "ArrowUp") direction = "previous";
    else if (event.key === "ArrowDown") direction = "next";
    else if (event.key === "Home") direction = "first";
    else if (event.key === "End") direction = "last";
    else if (event.key === "Escape") {
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
      data-execution-navigation-id={execution.id}
      onBlur={onTooltipBlur}
      onClick={onNavigate}
      onFocus={onTooltipFocus}
      onKeyDown={handleKeyDown}
      onMouseEnter={onTooltipHover}
      onMouseLeave={onTooltipLeave}
    >
      <span
        className={`h-0.5 rounded-full transition-[width,background-color] duration-[var(--motion-hover)] group-hover:w-5 group-focus-visible:w-5 ${
          current ? "w-4 bg-text-secondary" : "w-2 bg-border-strong"
        }`}
        aria-hidden="true"
      />
    </button>
  );
}

function ExecutionNavigationTooltip({
  execution,
}: {
  execution: ExecutionWorkstreamExecution;
}) {
  const duration = useElapsedTime({
    startedAt: execution.record.startedAt,
    active: execution.record.status === "running",
    durationMs: execution.record.durationMs,
    endedAt: execution.record.endedAt,
  });
  return (
    <>
      <strong className="block font-semibold">Execution {execution.number}</strong>
      <span className="mt-1 block line-clamp-3 text-text-secondary">
        {executionRequest(execution)}
      </span>
      <span className="mt-1 block text-text-tertiary">
        {presentExecutionStatus(execution.record.status).label} · {duration}
      </span>
    </>
  );
}

export function ExecutionNavigationRail({
  executions,
  currentExecutionId,
  left,
  visible,
  onNavigate,
}: {
  executions: readonly ExecutionWorkstreamExecution[];
  currentExecutionId: string | null;
  left: number;
  visible: boolean;
  onNavigate: (executionId: string, behavior: ScrollBehavior) => void;
}) {
  const markerByExecutionIdRef = useRef(new Map<string, HTMLButtonElement>());
  const navigationRef = useRef<HTMLElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const tooltipId = useId();
  const [focusedExecutionId, setFocusedExecutionId] = useState<string | null>(null);
  const [hoveredExecutionId, setHoveredExecutionId] = useState<string | null>(null);
  const [tooltipPosition, setTooltipPosition] = useState<{ left: number; top: number } | null>(null);
  const tooltipExecutionId = focusedExecutionId ?? hoveredExecutionId;
  const currentIndex = Math.max(
    0,
    executions.findIndex((execution) => execution.id === currentExecutionId),
  );
  const tooltipExecution = executions.find((execution) => execution.id === tooltipExecutionId);

  const positionTooltip = useCallback((executionId: string) => {
    if (tooltipRef.current === null) return;
    const marker = markerByExecutionIdRef.current.get(executionId);
    if (!marker) return;
    const markerRect = marker.getBoundingClientRect();
    const tooltipRect = tooltipRef.current.getBoundingClientRect();
    const maximumLeft = Math.max(
      VIEWPORT_GUTTER_PX,
      window.innerWidth - tooltipRect.width - VIEWPORT_GUTTER_PX,
    );
    const nextLeft = Math.min(maximumLeft, markerRect.right + TOOLTIP_GAP_PX);
    const nextTop = Math.min(
      Math.max(VIEWPORT_GUTTER_PX, markerRect.top + markerRect.height / 2 - tooltipRect.height / 2),
      Math.max(VIEWPORT_GUTTER_PX, window.innerHeight - tooltipRect.height - VIEWPORT_GUTTER_PX),
    );
    setTooltipPosition({ left: nextLeft, top: nextTop });
  }, []);

  useLayoutEffect(() => {
    if (!visible || tooltipExecutionId === null) return;
    positionTooltip(tooltipExecutionId);
  }, [positionTooltip, tooltipExecutionId, visible]);

  const keepMarkerVisible = useCallback((executionId: string | null) => {
    const navigation = navigationRef.current;
    const marker = executionId === null
      ? undefined
      : markerByExecutionIdRef.current.get(executionId);
    if (!navigation || !marker) return;
    const navigationRect = navigation.getBoundingClientRect();
    const markerRect = marker.getBoundingClientRect();
    const visibleTop = navigationRect.top + RAIL_VISIBLE_PADDING_PX;
    const visibleBottom = navigationRect.bottom - RAIL_VISIBLE_PADDING_PX;
    if (markerRect.top < visibleTop) {
      navigation.scrollTop -= visibleTop - markerRect.top;
    } else if (markerRect.bottom > visibleBottom) {
      navigation.scrollTop += markerRect.bottom - visibleBottom;
    }
  }, []);

  useLayoutEffect(() => {
    if (!visible) return;
    keepMarkerVisible(currentExecutionId ?? focusedExecutionId);
  }, [currentExecutionId, focusedExecutionId, keepMarkerVisible, visible]);

  useLayoutEffect(() => {
    if (!visible || typeof ResizeObserver === "undefined") return;
    const navigation = navigationRef.current;
    if (!navigation) return;
    const observer = new ResizeObserver(() => {
      keepMarkerVisible(currentExecutionId ?? focusedExecutionId);
      if (tooltipExecutionId !== null) positionTooltip(tooltipExecutionId);
    });
    observer.observe(navigation);
    if (navigation.parentElement) observer.observe(navigation.parentElement);
    return () => observer.disconnect();
  }, [
    currentExecutionId,
    focusedExecutionId,
    keepMarkerVisible,
    positionTooltip,
    tooltipExecutionId,
    visible,
  ]);

  if (!visible) return null;

  const move = (
    executionId: string,
    direction: "previous" | "next" | "first" | "last",
  ) => {
    const index = executions.findIndex((execution) => execution.id === executionId);
    const nextIndex = direction === "first"
      ? 0
      : direction === "last"
        ? executions.length - 1
        : direction === "previous"
          ? Math.max(0, index - 1)
          : Math.min(executions.length - 1, index + 1);
    const target = executions[nextIndex];
    if (!target) return;
    onNavigate(target.id, "smooth");
    requestAnimationFrame(() => markerByExecutionIdRef.current.get(target.id)?.focus({ preventScroll: true }));
  };

  return (
    <>
      <nav
        ref={navigationRef}
        className="absolute top-1/2 z-[2] flex -translate-y-1/2 flex-col overflow-y-auto py-3 [@media(pointer:coarse)]:hidden"
        style={{
          left,
          maxHeight: RAIL_MAX_HEIGHT,
          maskImage: "linear-gradient(to bottom, transparent, black 12px, black calc(100% - 12px), transparent)",
          WebkitMaskImage: "linear-gradient(to bottom, transparent, black 12px, black calc(100% - 12px), transparent)",
        }}
        aria-label="Execution navigation"
        data-testid="execution-navigation-rail"
        onScroll={() => {
          if (tooltipExecutionId !== null) positionTooltip(tooltipExecutionId);
        }}
      >
        {executions.map((execution, index) => (
          <ExecutionNavigationMarker
            key={execution.id}
            execution={execution}
            current={execution.id === currentExecutionId}
            tabIndex={index === currentIndex ? 0 : -1}
            buttonRef={(button) => {
              if (button) markerByExecutionIdRef.current.set(execution.id, button);
              else markerByExecutionIdRef.current.delete(execution.id);
            }}
            onNavigate={() => onNavigate(execution.id, "smooth")}
            onMove={(direction) => move(execution.id, direction)}
            tooltipId={tooltipId}
            tooltipVisible={tooltipExecutionId === execution.id}
            onTooltipFocus={() => {
              setTooltipPosition(null);
              setFocusedExecutionId(execution.id);
            }}
            onTooltipBlur={() => setFocusedExecutionId(null)}
            onTooltipHover={() => {
              setTooltipPosition(null);
              setHoveredExecutionId(execution.id);
            }}
            onTooltipLeave={() => setHoveredExecutionId(null)}
          />
        ))}
      </nav>
      {tooltipExecution && typeof document !== "undefined" && createPortal(
        <div
          ref={tooltipRef}
          id={tooltipId}
          role="tooltip"
          className="pointer-events-none fixed z-[100] max-w-[320px] rounded-md border border-border-default bg-bg-overlay px-3 py-2 text-[11px] leading-4 text-text-primary shadow-md animate-overlay-enter"
          style={tooltipPosition === null
            ? { left: 0, top: 0, visibility: "hidden" }
            : tooltipPosition}
        >
          <ExecutionNavigationTooltip execution={tooltipExecution} />
        </div>,
        document.body,
      )}
    </>
  );
}
