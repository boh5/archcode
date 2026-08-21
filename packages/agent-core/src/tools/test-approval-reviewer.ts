import type { ApprovalReviewer } from "../approval-review";

/** Explicit deterministic Reviewer used by tests that exercise the pre-existing HITL path. */
export const deferTestApprovalReviewer: ApprovalReviewer = Object.freeze({
  async review() {
    return { outcome: "deferred" as const, reason: "disabled" as const };
  },
});
