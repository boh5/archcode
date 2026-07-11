import { useRef, type KeyboardEvent, type PointerEvent } from "react";

export interface ResizeHandleProps {
  label: string;
  controls: string;
  value: number;
  min: number;
  max: number;
  direction: 1 | -1;
  onChange: (value: number) => void;
}

export function ResizeHandle({ label, controls, value, min, max, direction, onChange }: ResizeHandleProps) {
  const dragStart = useRef<{ x: number; value: number } | null>(null);

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    dragStart.current = { x: event.clientX, value };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (dragStart.current === null) return;
    onChange(dragStart.current.value + ((event.clientX - dragStart.current.x) * direction));
  };

  const handlePointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    dragStart.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 40 : 10;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      onChange(value - (step * direction));
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      onChange(value + (step * direction));
    } else if (event.key === "Home") {
      event.preventDefault();
      onChange(min);
    } else if (event.key === "End") {
      event.preventDefault();
      onChange(max);
    }
  };

  return (
    <div
      role="separator"
      aria-label={label}
      aria-controls={controls}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={`${value} pixels`}
      tabIndex={0}
      className="group relative z-30 h-full w-2 shrink-0 cursor-col-resize touch-none bg-transparent outline-none focus:bg-accent/30"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      onKeyDown={handleKeyDown}
    >
      <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border-subtle transition-colors group-hover:bg-accent group-focus:bg-accent" />
    </div>
  );
}
