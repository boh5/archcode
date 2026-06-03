import { describe, expect, test } from "bun:test";
import { exploreAgentDefinition } from "../definitions/explore";
import {
  TOOL_ARTIFACT_READ,
  TOOL_ARTIFACT_WRITE,
  TOOL_WORKFLOW_COMPLETE,
  TOOL_WORKFLOW_CREATE,
  TOOL_WORKFLOW_RECORD_COMPLETION,
  TOOL_WORKFLOW_UPDATE_STAGE,
} from "../../tools/names";
import { workflowRoleToolPermissions } from "./permissions";

describe("workflow role tool permissions", () => {
  test("builder role can read available artifact references before relying on content", () => {
    expect(workflowRoleToolPermissions.builder).toContain(TOOL_ARTIFACT_READ);
  });

  test("explorer agent can read available artifact references before relying on content", () => {
    expect(exploreAgentDefinition.tools.tools).toContain(TOOL_ARTIFACT_READ);
  });

  test("artifact author roles can read and write artifacts without orchestrating stage lifecycle", () => {
    for (const role of ["product", "spec", "critic"] as const) {
      const tools = workflowRoleToolPermissions[role];

      expect(tools).toContain(TOOL_ARTIFACT_READ);
      expect(tools).toContain(TOOL_ARTIFACT_WRITE);
      expect(tools).not.toContain(TOOL_WORKFLOW_CREATE);
      expect(tools).not.toContain(TOOL_WORKFLOW_UPDATE_STAGE);
      expect(tools).not.toContain(TOOL_WORKFLOW_COMPLETE);
      expect(tools).not.toContain(TOOL_WORKFLOW_RECORD_COMPLETION);
    }
  });

  test("foreman reads artifacts and checks tasks without stage lifecycle tools", () => {
    expect(workflowRoleToolPermissions.foreman).toContain(TOOL_ARTIFACT_READ);
    expect(workflowRoleToolPermissions.foreman).not.toContain(TOOL_ARTIFACT_WRITE);
    expect(workflowRoleToolPermissions.foreman).not.toContain(TOOL_WORKFLOW_UPDATE_STAGE);
    expect(workflowRoleToolPermissions.foreman).not.toContain(TOOL_WORKFLOW_COMPLETE);
    expect(workflowRoleToolPermissions.foreman).not.toContain(TOOL_WORKFLOW_RECORD_COMPLETION);
  });

  test("builder can read available artifacts and write evidence artifacts", () => {
    expect(workflowRoleToolPermissions.builder).toContain(TOOL_ARTIFACT_READ);
    expect(workflowRoleToolPermissions.builder).toContain(TOOL_ARTIFACT_WRITE);
  });
});
