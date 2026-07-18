import { afterAll, describe, expect, test } from "bun:test";

import {
  TOOL_GITHUB_CREATE_ISSUE_COMMENT,
  TOOL_GITHUB_GET_PULL_REQUEST,
  TOOL_GITHUB_GET_PULL_REQUEST_CHECKS,
  TOOL_GITHUB_GET_WORKFLOW_RUN,
  TOOL_GITHUB_LIST_ISSUE_COMMENTS,
  TOOL_GITHUB_LIST_PULL_REQUESTS,
  TOOL_GITHUB_LIST_WORKFLOW_RUNS,
  TOOL_GITHUB_RERUN_WORKFLOW_RUN,
} from "@archcode/protocol";
import { silentLogger } from "../logger";
import { createBuiltinToolDescriptors } from "../tools/builtins";
import { createTestToolRegistryFixture, type TestToolRegistryFixture } from "../tools/test-registry";
import { registerBuiltinTools } from "./register-tools";

const fixtures: TestToolRegistryFixture[] = [];

afterAll(async () => {
  await Promise.all(fixtures.map((fixture) => fixture.dispose()));
});

function createRegisteredFixture(): TestToolRegistryFixture {
  const fixture = createTestToolRegistryFixture();
  fixtures.push(fixture);
  registerBuiltinTools(fixture.registry, silentLogger, { github: { enabled: false } });
  return fixture;
}

describe("registerBuiltinTools hard-cut wiring", () => {
  test("every registered descriptor declares one explicit output policy", () => {
    const fixture = createRegisteredFixture();
    expect(fixture.registry.getAll().length).toBeGreaterThan(createBuiltinToolDescriptors().length);
    for (const descriptor of fixture.registry.getAll()) {
      expect(["source", "inline", "artifact"]).toContain(descriptor.outputPolicy.kind);
    }
  });

  test("uses only finalized audit and execution logger global hooks", () => {
    const fixture = createRegisteredFixture();
    expect(fixture.registry.globalHooks.before).toEqual([]);
    expect(fixture.registry.globalHooks.finalized.map((hook) => hook.name)).toEqual([
      "auditAfterHook",
      "executionLoggerAfterHook",
    ]);
  });

  test("registers all eight GitHub descriptors outside the builtin group", () => {
    const fixture = createRegisteredFixture();
    const githubNames = [
      TOOL_GITHUB_GET_PULL_REQUEST,
      TOOL_GITHUB_LIST_PULL_REQUESTS,
      TOOL_GITHUB_GET_PULL_REQUEST_CHECKS,
      TOOL_GITHUB_LIST_ISSUE_COMMENTS,
      TOOL_GITHUB_CREATE_ISSUE_COMMENT,
      TOOL_GITHUB_LIST_WORKFLOW_RUNS,
      TOOL_GITHUB_GET_WORKFLOW_RUN,
      TOOL_GITHUB_RERUN_WORKFLOW_RUN,
    ];
    const builtinNames = new Set(createBuiltinToolDescriptors().map((descriptor) => descriptor.name));
    for (const name of githubNames) {
      expect(fixture.registry.get(name)).toBeDefined();
      expect(builtinNames.has(name)).toBe(false);
    }
  });
});
