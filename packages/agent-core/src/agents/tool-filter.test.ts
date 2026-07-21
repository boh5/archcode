import { describe, expect, test } from "bun:test";
import {
  buildAgentDefinition,
  exploreAgentDefinition,
  librarianAgentDefinition,
  leadAgentDefinition,
  analystAgentDefinition,
} from "./definitions";
import { TOOL_COMPRESS } from "../tools/names";

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
      expect(definition.tools.tools).toContain(TOOL_COMPRESS);
      expect(definition.tools.tools).not.toContain("compact");
    }
  });
});
