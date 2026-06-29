import { describe, expect, test } from "bun:test";
import { exploreAgentDefinition } from "../definitions/explore";
import { orchestratorAgentDefinition } from "../definitions/orchestrator";
import {
  TOOL_ARTIFACT_READ,
  TOOL_ARTIFACT_WRITE,
  TOOL_ASK_USER,
  TOOL_AST_GREP_REPLACE,
  TOOL_BASH,
  TOOL_FILE_EDIT,
  TOOL_FILE_WRITE,
  TOOL_TODO_WRITE,
  TOOL_WORKFLOW_CREATE,
  TOOL_WORKFLOW_PROPOSE_INTERACTIONS,
  TOOL_WORKFLOW_REQUEST_INTERACTIONS,
  TOOL_WORKFLOW_UPDATE_STAGE,
} from "../../tools/names";
import { workflowRoleToolPermissions } from "./permissions";

const SOURCE_WRITE_TOOLS = [
  TOOL_FILE_WRITE,
  TOOL_FILE_EDIT,
  TOOL_BASH,
  TOOL_AST_GREP_REPLACE,
] as const;

const ARTIFACT_AUTHOR_ROLES = ["product", "spec", "critic"] as const;

function expectNoSourceWriteTools(tools: readonly string[]) {
  for (const tool of SOURCE_WRITE_TOOLS) {
    expect(tools).not.toContain(tool);
  }
}

describe("workflow role tool permissions", () => {
  test("builder role can read available artifact references before relying on content", () => {
    expect(workflowRoleToolPermissions.builder).toContain(TOOL_ARTIFACT_READ);
  });

  test("explorer agent can read available artifact references before relying on content", () => {
    expect(exploreAgentDefinition.tools.tools).toContain(TOOL_ARTIFACT_READ);
  });

  test("artifact author roles can read and write artifacts without orchestrating stage lifecycle", () => {
    for (const role of ARTIFACT_AUTHOR_ROLES) {
      const tools = workflowRoleToolPermissions[role];

      expect(tools).toContain(TOOL_ARTIFACT_READ);
      expect(tools).toContain(TOOL_ARTIFACT_WRITE);
      expect(tools).toContain(TOOL_WORKFLOW_PROPOSE_INTERACTIONS);
      expect(tools).toContain(TOOL_TODO_WRITE);
      expect(tools).not.toContain(TOOL_ASK_USER);
      expect(tools).not.toContain(TOOL_WORKFLOW_CREATE);
      expect(tools).not.toContain(TOOL_WORKFLOW_REQUEST_INTERACTIONS);
      expect(tools).not.toContain(TOOL_WORKFLOW_UPDATE_STAGE);
    }
  });

  test("orchestrator retains direct and batched user interaction tools", () => {
    expect(orchestratorAgentDefinition.tools.tools).toContain(TOOL_ASK_USER);
    expect(orchestratorAgentDefinition.tools.tools).toContain(TOOL_WORKFLOW_REQUEST_INTERACTIONS);
  });

  test("artifact author roles can write workflow artifacts but cannot mutate source code", () => {
    for (const role of ARTIFACT_AUTHOR_ROLES) {
      const tools = workflowRoleToolPermissions[role];

      expect(tools).toContain(TOOL_ARTIFACT_WRITE);
      expectNoSourceWriteTools(tools);
    }
  });

  test("librarian role remains read-only for source code", () => {
    expect(workflowRoleToolPermissions.librarian).toContain(TOOL_ARTIFACT_READ);
    expect(workflowRoleToolPermissions.librarian).not.toContain(TOOL_ARTIFACT_WRITE);
    expectNoSourceWriteTools(workflowRoleToolPermissions.librarian);
  });

  test("foreman reads artifacts and checks tasks without stage lifecycle tools", () => {
    expect(workflowRoleToolPermissions.foreman).toContain(TOOL_ARTIFACT_READ);
    expect(workflowRoleToolPermissions.foreman).not.toContain(TOOL_ARTIFACT_WRITE);
    expect(workflowRoleToolPermissions.foreman).not.toContain(TOOL_WORKFLOW_UPDATE_STAGE);
  });

  test("builder can read available artifacts and write evidence artifacts", () => {
    expect(workflowRoleToolPermissions.builder).toContain(TOOL_ARTIFACT_READ);
    expect(workflowRoleToolPermissions.builder).toContain(TOOL_ARTIFACT_WRITE);
  });

  test("builder is the source-writing positive control", () => {
    for (const tool of SOURCE_WRITE_TOOLS) {
      expect(workflowRoleToolPermissions.builder).toContain(tool);
    }
  });

  test("product, spec, critic, and reviewer roles include delegation execution tools", () => {
    for (const role of ["product", "spec", "critic", "reviewer"] as const) {
      const tools = workflowRoleToolPermissions[role];
      expect(tools).toContain("delegate");
      expect(tools).toContain("background_output");
      expect(tools).toContain("wait_for_reminder");
      expect(tools).toContain("view_tool_output");
    }
  });
});
