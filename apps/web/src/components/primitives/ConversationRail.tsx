import type { HTMLAttributes } from "react";

export type ConversationRailProps = HTMLAttributes<HTMLDivElement>;

/**
 * The single horizontal alignment boundary for the Session conversation.
 * It follows the available Session canvas and owns only safe horizontal gutters.
 * Individual prose surfaces may constrain line length without constraining
 * Work, tools, code, tables, Diffs, or the Composer.
 */
export function ConversationRail({ className = "", ...props }: ConversationRailProps) {
  return (
    <div
      className={`box-border w-full min-w-0 px-4 sm:px-5 xl:px-6 ${className}`}
      data-conversation-rail=""
      {...props}
    />
  );
}
