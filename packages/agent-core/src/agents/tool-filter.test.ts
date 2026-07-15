import { describe, expect, test } from "bun:test";
import {
  buildAgentDefinition,
  exploreAgentDefinition,
  librarianAgentDefinition,
  engineerAgentDefinition,
  goalLeadAgentDefinition,
  planAgentDefinition,
  reviewerAgentDefinition,
  shaperAgentDefinition,
} from "./definitions";
import { TOOL_COMPRESS } from "../tools/names";

describe("compress tool access matrix", () => {
  test("all agents use autoCompact hooks and expose DCP-style compress for context management", () => {
    for (const definition of [
      engineerAgentDefinition,
      goalLeadAgentDefinition,
      planAgentDefinition,
      buildAgentDefinition,
      reviewerAgentDefinition,
      exploreAgentDefinition,
      librarianAgentDefinition,
      shaperAgentDefinition,
    ]) {
      expect(definition.hooks.autoCompact).toBe(true);
      expect(definition.tools.tools).toContain(TOOL_COMPRESS);
      expect(definition.tools.tools).not.toContain("compact");
    }
  });
});
