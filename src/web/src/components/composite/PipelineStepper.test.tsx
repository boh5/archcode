import { describe, expect, it } from "bun:test";
import { getStepStatuses } from "./PipelineStepper";

describe("getStepStatuses", () => {
  it("maps idle to all pending", () => {
    expect(getStepStatuses("idle")).toEqual([
      "pending",
      "pending",
      "pending",
      "pending",
      "pending",
      "pending",
    ]);
  });

  it("maps product_drafting to P current, rest pending", () => {
    expect(getStepStatuses("product_drafting")).toEqual([
      "current",
      "pending",
      "pending",
      "pending",
      "pending",
      "pending",
    ]);
  });

  it("maps critic_prd_review to P completed, C current, rest pending", () => {
    expect(getStepStatuses("critic_prd_review")).toEqual([
      "completed",
      "current",
      "pending",
      "pending",
      "pending",
      "pending",
    ]);
  });

  it("maps spec_drafting to P and C completed, S current, rest pending", () => {
    expect(getStepStatuses("spec_drafting")).toEqual([
      "completed",
      "completed",
      "current",
      "pending",
      "pending",
      "pending",
    ]);
  });

  it("maps critic_spec_review to P, C, S completed, C(spec) current, rest pending", () => {
    expect(getStepStatuses("critic_spec_review")).toEqual([
      "completed",
      "completed",
      "completed",
      "current",
      "pending",
      "pending",
    ]);
  });

  it("maps awaiting_user_approval to P, C, S, C completed, F current, ✓ pending", () => {
    expect(getStepStatuses("awaiting_user_approval")).toEqual([
      "completed",
      "completed",
      "completed",
      "completed",
      "current",
      "pending",
    ]);
  });

  it("maps foreman_executing same as awaiting_user_approval (F current)", () => {
    expect(getStepStatuses("foreman_executing")).toEqual([
      "completed",
      "completed",
      "completed",
      "completed",
      "current",
      "pending",
    ]);
  });

  it("maps final_review to all but ✓ completed, ✓ current", () => {
    expect(getStepStatuses("final_review")).toEqual([
      "completed",
      "completed",
      "completed",
      "completed",
      "completed",
      "current",
    ]);
  });

  it("maps complete to all completed", () => {
    expect(getStepStatuses("complete")).toEqual([
      "completed",
      "completed",
      "completed",
      "completed",
      "completed",
      "completed",
    ]);
  });

  it("maps failed to all completed (component renders ✗ instead of ✓)", () => {
    expect(getStepStatuses("failed")).toEqual([
      "completed",
      "completed",
      "completed",
      "completed",
      "completed",
      "completed",
    ]);
  });

  it("maps unknown stage to all pending", () => {
    expect(getStepStatuses("unknown_stage")).toEqual([
      "pending",
      "pending",
      "pending",
      "pending",
      "pending",
      "pending",
    ]);
  });
});