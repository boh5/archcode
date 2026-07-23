import { describe, expect, test } from "bun:test";
import { CircleCheck, CirclePause, CircleStop, CircleX, MessageCircleQuestion } from "lucide-react";
import { STATUS_VISUALS, statusVisual, type VisualStatusKind } from "./status-visuals";

const expectedKinds: readonly VisualStatusKind[] = [
  "running",
  "loading",
  "warning",
  "needs_you",
  "pending",
  "paused",
  "blocked",
  "budget_limited",
  "completed",
  "failed",
  "stopped",
  "idle",
  "unknown",
  "enabled",
  "disabled",
];

describe("status visuals", () => {
  test("owns one exhaustive visual mapping without product labels", () => {
    expect(Object.keys(STATUS_VISUALS)).toEqual([...expectedKinds]);
    for (const kind of expectedKinds) {
      const visual = statusVisual(kind);
      expect(visual.glyph).toBeDefined();
      expect(["brand", "info", "signal", "success", "warning", "error", "neutral"]).toContain(visual.tone);
      expect(typeof visual.loops).toBe("boolean");
      expect("label" in visual).toBe(false);
    }
  });

  test("loops only for authoritative activity primitives", () => {
    expect(expectedKinds.filter((kind) => statusVisual(kind).loops)).toEqual(["running", "loading"]);
    expect(statusVisual("running").tone).toBe("signal");
    expect(statusVisual("loading").tone).toBe("signal");
    expect(statusVisual("completed").tone).toBe("success");
    expect(statusVisual("failed").tone).toBe("error");
    expect(statusVisual("stopped").tone).toBe("neutral");
  });

  test("locks the primary workbench status icon identities", () => {
    expect(statusVisual("running").glyph).toBe("activity-arc");
    expect(statusVisual("needs_you").glyph).toBe(MessageCircleQuestion);
    expect(statusVisual("paused").glyph).toBe(CirclePause);
    expect(statusVisual("completed").glyph).toBe(CircleCheck);
    expect(statusVisual("failed").glyph).toBe(CircleX);
    expect(statusVisual("stopped").glyph).toBe(CircleStop);
  });
});
