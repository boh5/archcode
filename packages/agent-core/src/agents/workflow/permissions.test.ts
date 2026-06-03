import { describe, expect, test } from "bun:test";
import { exploreAgentDefinition } from "../definitions/explore";
import { TOOL_ARTIFACT_READ } from "../../tools/names";
import { workflowRoleToolPermissions } from "./permissions";

describe("workflow role tool permissions", () => {
  test("builder role can read available artifact references before relying on content", () => {
    expect(workflowRoleToolPermissions.builder).toContain(TOOL_ARTIFACT_READ);
  });

  test("explorer agent can read available artifact references before relying on content", () => {
    expect(exploreAgentDefinition.tools.tools).toContain(TOOL_ARTIFACT_READ);
  });
});
