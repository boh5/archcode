import { describe, expect, test } from "bun:test";
import {
  buildAgentDefinition,
  exploreAgentDefinition,
  librarianAgentDefinition,
  leadAgentDefinition,
  analystAgentDefinition,
} from "./definitions";
import { TOOL_COMPRESS } from "../tools/names";
import {
  AgentDefinitionValidationError,
  filterToolsByDepth,
  validateAgentDefinition,
} from "./tool-filter";
import type { AgentDefinition } from "./factory-types";

describe("compress tool access matrix", () => {
  test("all agents use autoCompact hooks and expose DCP-style compress for context management", () => {
    for (const definition of [
      leadAgentDefinition,
      analystAgentDefinition,
      buildAgentDefinition,
      exploreAgentDefinition,
      librarianAgentDefinition,
    ]) {
      expect(definition.hooks.autoCompact).toBe(true);
      expect(definition.tools.authorized).toContain(TOOL_COMPRESS);
      expect(definition.tools.authorized).not.toContain("compact");
    }
  });

  test("removes every delegation control at the terminal depth", () => {
    expect(filterToolsByDepth(
      ["grep", "delegate", "resume_session", "grep"],
      leadAgentDefinition,
      2,
    )).toEqual(["grep", "delegate", "resume_session"]);
    expect(filterToolsByDepth(
      ["grep", "delegate", "resume_session", "grep"],
      leadAgentDefinition,
      3,
    )).toEqual(["grep"]);
  });

  test("rejects role authority that violates the definition contract", () => {
    const invalid = {
      ...leadAgentDefinition,
      tools: {
        authorized: leadAgentDefinition.tools.authorized.filter((tool) => tool !== "file_read"),
        core: ["file_read"],
      },
    } as AgentDefinition;

    expect(() => validateAgentDefinition(invalid)).toThrow(AgentDefinitionValidationError);
    expect(() => validateAgentDefinition(invalid)).toThrow(/required capability is not authorized: file_read/);
  });
});
