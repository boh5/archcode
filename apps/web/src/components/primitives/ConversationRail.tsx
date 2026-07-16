import type { HTMLAttributes } from "react";

export type ConversationRailProps = HTMLAttributes<HTMLDivElement>;

/**
 * The single horizontal alignment boundary for the Session conversation.
 * Its max width is border-box: the responsive gutters are part of the 880px rail.
 */
export function ConversationRail({ className = "", ...props }: ConversationRailProps) {
  return (
    <div
      className={`box-border min-w-0 w-full max-w-[880px] mx-auto px-[16px] sm:px-[20px] ${className}`}
      data-conversation-rail=""
      {...props}
    />
  );
}
