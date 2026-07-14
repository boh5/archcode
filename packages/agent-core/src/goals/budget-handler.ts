import type { GoalStateManager } from "./state";
import type { HitlResponse } from "@archcode/protocol";
import type { HitlRecord } from "../hitl/project-queue";

export type GoalBudgetHitlRecord = HitlRecord & {
  readonly owner: { readonly type: "goal"; readonly id: string };
  readonly source: { readonly type: "goal_budget"; readonly approvalPoint: string };
  readonly response: Extract<HitlResponse, { readonly type: "budget_decision" | "cancel" }>;
  readonly status: "answered";
};

export interface GoalBudgetHandlerOptions {
  readonly goalStateManager: GoalStateManager;
  readonly now?: () => Date;
}

/** Applies only a durable goal_budget answer. Queue delivery and execution remain Runtime-owned. */
export class GoalBudgetHandler {
  readonly #goalStateManager: GoalStateManager;
  readonly #now: () => Date;

  constructor(options: GoalBudgetHandlerOptions) {
    this.#goalStateManager = options.goalStateManager;
    this.#now = options.now ?? (() => new Date());
  }

  async apply(record: HitlRecord): Promise<void> {
    assertBudgetRecord(record);
    const goalId = record.owner.id;
    const approved = record.response.type === "budget_decision"
      && record.response.decision === "approved";
    const reason = approved
        ? `Budget warning approved at ${record.source.approvalPoint}`
      : record.response.type === "cancel"
        ? record.response.reason
        : record.response.comment ?? `Budget warning denied at ${record.source.approvalPoint}`;
    await this.#goalStateManager.applyBudgetDecision(goalId, {
      hitlId: record.hitlId,
      approvalPoint: record.source.approvalPoint,
      decision: approved ? "approved" : "denied",
      reason,
      decidedAt: this.#now().toISOString(),
    });
  }
}

function assertBudgetRecord(record: HitlRecord): asserts record is GoalBudgetHitlRecord {
  if (record.owner.type !== "goal") throw new TypeError(`GoalBudgetHandler cannot apply ${record.owner.type} owner`);
  if (record.source.type !== "goal_budget") throw new TypeError(`GoalBudgetHandler cannot apply ${record.source.type}`);
  if (record.status !== "answered" || record.response === undefined) {
    throw new TypeError(`GoalBudgetHandler requires an answered record, got ${record.status}`);
  }
  if (record.response.type !== "budget_decision" && record.response.type !== "cancel") {
    throw new TypeError(`GoalBudgetHandler cannot apply ${record.response.type}`);
  }
}
