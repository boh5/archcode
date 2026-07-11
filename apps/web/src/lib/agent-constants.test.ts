import { describe, expect, test } from "bun:test";
import {
  AGENT_TYPES,
  AGENT_INITIALS,
  AGENT_DISPLAY_NAMES,
  AGENT_ICON_COLORS,
  AGENT_BADGE_COLORS,
  BADGE_CLASSES,
  BADGE_LABELS,
  isValidAgentType,
  type AgentType,
} from "./agent-constants";

describe("AGENT_TYPES", () => {
  test("contains all expected agent types", () => {
    expect(AGENT_TYPES).toEqual([
      "orchestrator", "plan", "build", "reviewer", "explore", "librarian",
    ]);
  });

  test("is a readonly tuple", () => {
    expect(AGENT_TYPES.length).toBe(6);
  });
});

describe("AGENT_INITIALS", () => {
  test("has an initial for every agent type", () => {
    for (const type of AGENT_TYPES) {
      expect(AGENT_INITIALS[type]).toBeDefined();
      expect(AGENT_INITIALS[type]).toHaveLength(1);
    }
  });

  test("maps specific initials correctly", () => {
    expect(AGENT_INITIALS.orchestrator).toBe("O");
    expect(AGENT_INITIALS.plan).toBe("P");
    expect(AGENT_INITIALS.build).toBe("B");
    expect(AGENT_INITIALS.explore).toBe("E");
  });
});

describe("AGENT_DISPLAY_NAMES", () => {
  test("has a display name for every agent type", () => {
    for (const type of AGENT_TYPES) {
      expect(AGENT_DISPLAY_NAMES[type]).toBeDefined();
      expect(AGENT_DISPLAY_NAMES[type].length).toBeGreaterThan(0);
    }
  });

  test("capitalizes correctly", () => {
    expect(AGENT_DISPLAY_NAMES.orchestrator).toBe("Orchestrator");
    expect(AGENT_DISPLAY_NAMES.plan).toBe("Plan");
    expect(AGENT_DISPLAY_NAMES.build).toBe("Build");
    expect(AGENT_DISPLAY_NAMES.explore).toBe("Explore");
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
    expect(isValidAgentType("orchestrator")).toBe(true);
    expect(isValidAgentType("plan")).toBe(true);
    expect(isValidAgentType("build")).toBe(true);
    expect(isValidAgentType("explore")).toBe(true);
  });

  test("returns false for invalid strings", () => {
    expect(isValidAgentType("unknown")).toBe(false);
    expect(isValidAgentType("builder")).toBe(false);
    expect(isValidAgentType("explorer")).toBe(false);
    expect(isValidAgentType("")).toBe(false);
    expect(isValidAgentType("ORCHESTRATOR")).toBe(false);
  });

  test("narrows the type", () => {
    const value: string = "orchestrator";
    if (isValidAgentType(value)) {
      const typed: AgentType = value;
      expect(typed).toBe("orchestrator");
    }
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
