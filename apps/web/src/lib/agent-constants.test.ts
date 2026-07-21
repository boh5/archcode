import { describe, expect, test } from "bun:test";
import {
  AGENT_TYPES,
  AGENT_ICON_COLORS,
  AGENT_BADGE_COLORS,
  AGENT_BORDER_CLASS,
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
      "lead", "analyst", "build", "explore", "librarian",
    ]);
  });

  test("is a readonly tuple", () => {
    expect(AGENT_TYPES.length).toBe(5);
  });
});

describe("resolveAgentInitial", () => {
  test("derives the initial from the runtime display name", () => {
    expect(resolveAgentInitial("Lead")).toBe("L");
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

describe("AGENT_BORDER_CLASS", () => {
  test("preserves the semantic border token for every built-in Agent", () => {
    expect(AGENT_BORDER_CLASS).toEqual({
      lead: "border-agent-lead",
      analyst: "border-agent-analyst",
      build: "border-agent-build",
      explore: "border-agent-explore",
      librarian: "border-agent-librarian",
    });
  });

  test("appearance retains identity icons and borders without message-header fields", () => {
    for (const type of AGENT_TYPES) {
      const appearance = resolveAgentAppearance(type, type);
      expect(appearance.borderClass).toBe(AGENT_BORDER_CLASS[type]);
      expect(appearance).not.toHaveProperty("dotClass");
      expect(appearance).not.toHaveProperty("nameClass");
    }
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
