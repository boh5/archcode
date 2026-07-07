import { describe, expect, test } from "bun:test";
import {
  buildAgentDefinition,
  exploreAgentDefinition,
  librarianAgentDefinition,
  orchestratorAgentDefinition,
  planAgentDefinition,
  reviewerAgentDefinition,
} from "./definitions";
import { TOOL_COMPRESS } from "../tools/names";

describe("compress tool access matrix", () => {
  test("core agents can use compress for context management", () => {
    for (const definition of [orchestratorAgentDefinition, planAgentDefinition, buildAgentDefinition, reviewerAgentDefinition]) {
      expect(definition.tools.tools).toContain(TOOL_COMPRESS);
    }
  });

  test("read-only explore and librarian agents do not expose compress", () => {
    expect(exploreAgentDefinition.tools.tools).not.toContain(TOOL_COMPRESS);
    expect(librarianAgentDefinition.tools.tools).not.toContain(TOOL_COMPRESS);
  });
});
