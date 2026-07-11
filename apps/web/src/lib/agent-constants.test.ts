import { describe, expect, test } from "bun:test";
import {
  AGENT_TYPES,
  AGENT_ICON_COLORS,
  AGENT_BADGE_COLORS,
  BADGE_CLASSES,
  BADGE_LABELS,
  resolveAgentAppearance,
  resolveAgentDisplayName,
  resolveAgentInitial,
  isValidAgentType,
  type AgentType,
} from "./agent-constants";

describe("AGENT_TYPES", () => {
  test("contains all expected agent types", () => {
    expect(AGENT_TYPES).toEqual([
      "engineer", "goal_lead", "plan", "build", "reviewer", "explore", "librarian",
    ]);
  });

  test("is a readonly tuple", () => {
    expect(AGENT_TYPES.length).toBe(7);
  });
});

describe("resolveAgentInitial", () => {
  test("derives the initial from the runtime display name", () => {
    expect(resolveAgentInitial("Engineer")).toBe("E");
    expect(resolveAgentInitial("Goal Lead")).toBe("G");
    expect(resolveAgentInitial("Quality Advocate")).toBe("Q");
  });
});

describe("AGENT_ICON_COLORS", () => {
  test("uses semantic Tailwind classes for every agent type", () => {
    for (const type of AGENT_TYPES) {
      const classes = AGENT_ICON_COLORS[type];
      expect(classes).toContain("bg-agent-");
      expect(classes).toContain("text-agent-");
    }
  });

  test("does not use raw hex values", () => {
    for (const type of AGENT_TYPES) {
      const classes = AGENT_ICON_COLORS[type];
      expect(classes).not.toContain("#");
    }
  });

  test("uses /20 opacity modifier for backgrounds", () => {
    for (const type of AGENT_TYPES) {
      const classes = AGENT_ICON_COLORS[type];
      expect(classes).toContain("/20");
    }
  });
});

describe("AGENT_BADGE_COLORS", () => {
  test("is the same as AGENT_ICON_COLORS", () => {
    for (const type of AGENT_TYPES) {
      expect(AGENT_BADGE_COLORS[type]).toBe(AGENT_ICON_COLORS[type]);
    }
  });
});

describe("isValidAgentType", () => {
  test("returns true for valid agent types", () => {
    expect(isValidAgentType("engineer")).toBe(true);
    expect(isValidAgentType("goal_lead")).toBe(true);
    expect(isValidAgentType("plan")).toBe(true);
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
    const value: string = "goal_lead";
    if (isValidAgentType(value)) {
      const typed: AgentType = value;
      expect(typed).toBe("goal_lead");
    }
  });
});

describe("agent catalog presentation", () => {
  const descriptors = [
    { name: "engineer", displayName: "Engineer" },
    { name: "goal_lead", displayName: "Goal Lead" },
  ];

  test("resolves display names from the server catalog", () => {
    expect(resolveAgentDisplayName("engineer", descriptors)).toBe("Engineer");
    expect(resolveAgentDisplayName("goal_lead", descriptors)).toBe("Goal Lead");
  });

  test("preserves an unknown Agent name instead of substituting a known role", () => {
    expect(resolveAgentDisplayName("custom_agent", descriptors)).toBe("custom_agent");
    const appearance = resolveAgentAppearance("custom_agent", "Custom Agent");
    expect(appearance.initial).toBe("C");
    expect(appearance.iconClass).toContain("text-text-muted");
    expect(appearance.iconClass).not.toContain("agent-explore");
  });

  test("uses an explicit loading presentation before Session identity hydrates", () => {
    expect(resolveAgentDisplayName(null, descriptors)).toBe("Loading agent…");
    expect(resolveAgentAppearance(null, null).initial).toBe("?");
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
