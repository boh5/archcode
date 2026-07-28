import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storeManager } from "../../store/store";
import { createMockStore } from "../../store/test-helpers";
import { createTestProjectContext } from "../test-project-context";
import { createTestToolRegistryFixture } from "../test-registry";
import { expectSettledResult } from "../test-results";
import type { ToolExecutionContext } from "../types";
import { bashTool, runBashCommand } from "./bash";

const ownedRoots = new Set<string>();
const registryFixture = createTestToolRegistryFixture({ descriptors: [bashTool] });

function createWorkspace(label: string): string {
  const workspace = realpathSync.native(mkdtempSync(join(tmpdir(), `bash-${label}-`)));
  ownedRoots.add(workspace);
  return workspace;
}

function executionContext(
  workspace: string,
  overrides: Partial<ToolExecutionContext> = {},
): ToolExecutionContext {
  return {
    store: createMockStore(),
    toolName: "bash",
    toolCallId: "bash_integration",
    input: {},
    step: 1,
    executionId: "test-execution",
    runOrdinal: 0,
    toolBatchId: "test-tool-batch",
    abort: new AbortController().signal,
    startedAt: Date.now(),
    allowedTools: new Set(["bash"]),
    cwd: workspace,
    storeManager,
    projectContext: createTestProjectContext(workspace),
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all([...ownedRoots].map((root) => rm(root, { recursive: true, force: true })));
  ownedRoots.clear();
});

async function executeBash(
  input: Parameters<typeof runBashCommand>[0],
  context: ToolExecutionContext,
) {
  const toolCall = { toolCallId: context.toolCallId, toolName: "bash", input };
  const first = await registryFixture.registry.execute(toolCall, context);
  const outcome = first.kind === "blocked"
    ? await registryFixture.registry.resumeBlocked({
        toolCall,
        request: first.request,
        requestKey: first.requestKey,
        response: { type: "permission_decision", decision: "approve_once" },
        context,
      })
    : first;
  return expectSettledResult(outcome);
}

describe("bash real process integration", () => {
  test("runs with the minimal environment instead of inheriting unrelated variables", async () => {
    const workspace = createWorkspace("env");
    const key = "ARCHCODE_BASH_INTEGRATION_SECRET";
    const previous = Bun.env[key];
    Bun.env[key] = "must-not-leak";

    try {
      const result = await executeBash(
        {
          description: "Inspect the Bash environment",
          command: `printf '%s|%s|%s' "$ARCHCODE_CLI" "\${${key}-unset}" "\${PATH:+set}"`,
        },
        executionContext(workspace),
      );

      expect(result.isError).toBe(false);
      expect(result.output.preview).toContain("STDOUT:\n1|unset|set\nSTDERR:\n\nEXIT_CODE: 0");
    } finally {
      if (previous === undefined) delete Bun.env[key];
      else Bun.env[key] = previous;
    }
  });

  test("resolves structured cwd through bashTool and executes there", async () => {
    const workspace = createWorkspace("cwd");
    const nested = join(workspace, "nested directory");
    await mkdir(nested);

    const result = await executeBash(
      {
        description: "Print the structured working directory",
        command: "pwd",
        cwd: "nested directory",
      },
      executionContext(workspace),
    );

    expect(result.isError).toBe(false);
    expect(result.output.preview).toContain(`STDOUT:\n${realpathSync.native(nested)}\n`);
    expect(result.details?.process?.exitCode).toBe(0);
  });

  test("maps a real signal exit to a structured Bash abort", async () => {
    const workspace = createWorkspace("signal");
    const result = await executeBash(
      {
        description: "Terminate Bash with SIGTERM",
        command: "kill -TERM $$",
      },
      executionContext(workspace),
    );

    expect(result.isError).toBe(true);
    expect(result.details?.error?.code).toBe("TOOL_BASH_ABORTED");
    expect(result.details?.process).toMatchObject({ aborted: true, signal: "SIGTERM", exitCode: 143 });
  });
});

afterAll(async () => {
  await registryFixture.dispose();
});
