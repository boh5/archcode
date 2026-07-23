import type { HTMLAttributes } from "react";

export type ConversationRailProps = HTMLAttributes<HTMLDivElement>;

/**
 * The single horizontal alignment boundary for the Session conversation.
 * Its max width is border-box: 20px desktop gutters leave the approved 760px
 * editorial reading measure.
 */
export function ConversationRail({ className = "", ...props }: ConversationRailProps) {
  return (
    <div
      className={`box-border mx-auto w-full min-w-0 max-w-[800px] px-4 sm:px-5 ${className}`}
      data-conversation-rail=""
      {...props}
    />
  );
}
