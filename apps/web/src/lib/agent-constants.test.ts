import { describe, expect, test } from "bun:test";
import {
  AGENT_TYPES,
  BADGE_CLASSES,
  BADGE_LABELS,
  resolveAgentDisplayName,
  isValidAgentType,
  type AgentType,
} from "./agent-constants";

describe("AGENT_TYPES", () => {
  test("contains all expected agent types", () => {
    expect(AGENT_TYPES).toEqual([
      "lead", "analyst", "build", "explore", "librarian",
    ]);
  });

  test("is a readonly tuple", () => {
    expect(AGENT_TYPES.length).toBe(5);
  });
});

describe("isValidAgentType", () => {
  test("returns true for valid agent types", () => {
    expect(isValidAgentType("lead")).toBe(true);
    expect(isValidAgentType("analyst")).toBe(true);
    expect(isValidAgentType("build")).toBe(true);
    expect(isValidAgentType("explore")).toBe(true);
  });

  test("returns false for invalid strings", () => {
    expect(isValidAgentType("unknown")).toBe(false);
    expect(isValidAgentType("builder")).toBe(false);
    expect(isValidAgentType("explorer")).toBe(false);
    expect(isValidAgentType("")).toBe(false);
    expect(isValidAgentType("coordinator")).toBe(false);
    expect(isValidAgentType("ENGINEER")).toBe(false);
  });

  test("narrows the type", () => {
    const value: string = "lead";
    if (isValidAgentType(value)) {
      const typed: AgentType = value;
      expect(typed).toBe("lead");
    }
  });
});

describe("agent catalog presentation", () => {
  const descriptors = [
    { name: "lead", displayName: "Lead" },
  ];

  test("resolves display names from the server catalog", () => {
    expect(resolveAgentDisplayName("lead", descriptors)).toBe("Lead");
  });

  test("preserves an unknown Agent name instead of substituting a known role", () => {
    expect(resolveAgentDisplayName("custom_agent", descriptors)).toBe("custom_agent");
  });

  test("uses an explicit loading presentation before Session identity hydrates", () => {
    expect(resolveAgentDisplayName(null, descriptors)).toBe("Loading agent…");
  });
});

describe("BADGE_CLASSES", () => {
  test("has classes for all badge statuses", () => {
    expect(BADGE_CLASSES.running).toContain("bg-success");
    expect(BADGE_CLASSES.completed).toContain("bg-accent");
    expect(BADGE_CLASSES.pending).toContain("bg-bg-active");
    expect(BADGE_CLASSES.error).toContain("bg-error");
  });
});

describe("BADGE_LABELS", () => {
  test("has labels for all badge statuses", () => {
    expect(BADGE_LABELS.running).toBe("Running");
    expect(BADGE_LABELS.completed).toBe("Completed");
    expect(BADGE_LABELS.pending).toBe("Pending");
    expect(BADGE_LABELS.error).toBe("Error");
  });
});
