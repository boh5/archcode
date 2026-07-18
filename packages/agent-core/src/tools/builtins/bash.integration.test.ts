import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { access, mkdir, readFile, rm } from "node:fs/promises";
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
    abort: new AbortController().signal,
    startedAt: Date.now(),
    allowedTools: new Set(["bash"]),
    cwd: workspace,
    storeManager,
    projectContext: createTestProjectContext(workspace),
    ...overrides,
  };
}

async function waitForFile(path: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await Bun.sleep(10);
    }
  }
  throw new Error(`Timed out waiting for Bash fixture file: ${path}`);
}

async function readPid(path: string): Promise<number> {
  await waitForFile(path);
  return Number.parseInt((await readFile(path, "utf8")).trim(), 10);
}

function expectProcessExited(pid: number): void {
  expect(Number.isInteger(pid)).toBe(true);
  expect(() => process.kill(pid, 0)).toThrow();
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

  test("closes stdin so a read observes EOF without hanging", async () => {
    const workspace = createWorkspace("stdin");
    const result = await executeBash(
      {
        description: "Read from closed stdin",
        command: "if IFS= read -r value; then printf 'unexpected:%s' \"$value\"; else printf 'stdin-closed'; fi",
        timeoutMs: 1_000,
      },
      executionContext(workspace),
    );

    expect(result.isError).toBe(false);
    expect(result.output.preview).toContain("STDOUT:\nstdin-closed\nSTDERR:\n\nEXIT_CODE: 0");
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

  test("times out a real Bash process and waits for it to exit", async () => {
    const workspace = createWorkspace("timeout");
    const pidPath = join(workspace, "bash.pid");
    const resultPromise = executeBash(
      {
        description: "Run until the timeout terminates Bash",
        command: "echo $$ > bash.pid; trap 'exit 0' TERM; while :; do :; done",
        timeoutMs: 1_000,
      },
      executionContext(workspace),
    );
    const pid = await readPid(pidPath);
    const result = await resultPromise;

    expect(result.isError).toBe(true);
    expect(result.details?.error?.code).toBe("TOOL_BASH_TIMEOUT");
    expect(result.details?.process).toMatchObject({ timedOut: true });
    expectProcessExited(pid);
  });

  test("aborts a real Bash process and waits for it to exit", async () => {
    const workspace = createWorkspace("abort");
    const pidPath = join(workspace, "bash.pid");
    const abortController = new AbortController();
    const resultPromise = executeBash(
      {
        description: "Run until AbortSignal terminates Bash",
        command: "echo $$ > bash.pid; trap 'exit 0' TERM; while :; do :; done",
      },
      executionContext(workspace, { abort: abortController.signal }),
    );
    const pid = await readPid(pidPath);
    abortController.abort("integration-test");
    const result = await resultPromise;

    expect(result.isError).toBe(true);
    expect(result.details?.error?.code).toBe("TOOL_BASH_ABORTED");
    expect(result.details?.process?.aborted).toBe(true);
    expectProcessExited(pid);
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
