import type { HTMLAttributes } from "react";

export type ConversationRailProps = HTMLAttributes<HTMLDivElement>;
export type SessionThreadColumnProps = HTMLAttributes<HTMLDivElement>;

/**
 * The compact lane used by Work summaries and ordinary activity rows. Rich
 * details remain outside this cap so diffs, terminals, and artifacts can use
 * the full Session thread width when expanded.
 */
export const WORK_ACTIVITY_LANE_CLASS = "w-full max-w-[720px] min-w-0";
export const WORK_ACTIVITY_CHILD_LANE_CLASS = "w-full max-w-[696px] min-w-0";
export const WORK_ACTIVITY_NESTED_LANE_CLASS = "w-full max-w-[676px] min-w-0";

/**
 * Owns the responsive safe-area gutters shared by the Session transcript and
 * Composer dock.
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

/**
 * The visible Session thread boundary. Conversation surfaces and Composer
 * controls share this width; prose children may still use a shorter measure.
 */
export function SessionThreadColumn({ className = "", ...props }: SessionThreadColumnProps) {
  return (
    <div
      className={`mx-auto w-full max-w-[800px] min-w-0 ${className}`}
      data-session-thread-column=""
      {...props}
    />
  );
}
