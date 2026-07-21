import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ServerConfigService, resolveServerConfigPath } from "./config";
import { setLlmAdapterForTest } from "./llm";
import { silentLogger } from "./logger";
import type { McpManager } from "./mcp";
import { ProjectRegistry } from "./projects/registry";
import { createRuntime, type AgentRuntime } from "./runtime";
import { createTestTempRoot } from "./testing/test-temp-root";

const testTempRoot = createTestTempRoot("lead-architecture-flows");
let activeRuntime: AgentRuntime | undefined;

beforeEach(async () => {
  await testTempRoot.cleanup();
  await mkdir(testTempRoot.path, { recursive: true });
  setLlmAdapterForTest(stoppedLlmAdapter());
});

afterEach(async () => {
  activeRuntime?.notifyRuntimeShutdown("test cleanup");
  await activeRuntime?.shutdown();
  activeRuntime = undefined;
  setLlmAdapterForTest(undefined);
});

afterAll(async () => {
  await testTempRoot.cleanup();
});

describe("Lead architecture full-runtime flows", () => {
  test("Todo Discussion reaches Ready and activates a fresh ordinary Lead Session", async () => {
    const fixture = await runtimeFixture("Todo architecture flow");
    const context = await fixture.runtime.contextResolver.resolve(fixture.workspaceRoot);
    const idea = await context.todos.createTodo({
      title: "Clarify the durable execution UX",
      body: "Agree the outcome before implementation.",
    });

    const discussion = await context.todos.discussTodo(idea.id, idea.revision);
    const discussionSessionId = discussion.discussionSessionId;
    expect(discussionSessionId).toBeString();
    await waitForIdle(fixture.runtime, fixture.workspaceRoot, discussionSessionId!);

    const discussionSession = await fixture.runtime.getSessionFile(fixture.workspaceRoot, discussionSessionId!);
    expect(discussionSession).toMatchObject({
      sessionId: discussionSessionId,
      rootSessionId: discussionSessionId,
      agentName: "lead",
    });
    expect(discussionSession.parentSessionId).toBeUndefined();
    expect(await context.todos.state.findByDiscussionSessionId(discussionSessionId!)).toMatchObject({ id: idea.id });

    const ready = await context.todos.updateFromDiscussion({
      authorization: {
        sessionId: discussionSessionId!,
        rootSessionId: discussionSessionId!,
        agentName: "lead",
        projectSlug: fixture.projectSlug,
      },
      expectedRevision: discussion.revision,
      patch: {
        body: "The outcome and acceptance boundary are confirmed.",
        status: "ready",
      },
    });
    expect(ready.status).toBe("ready");

    const activated = await context.todos.activateTodo(ready.id, {
      expectedRevision: ready.revision,
      kind: "session",
    });
    const activationSessionId = activated.activation?.sourceSessionId;
    expect(activationSessionId).toBeString();
    expect(activationSessionId).not.toBe(discussionSessionId);
    await waitForIdle(fixture.runtime, fixture.workspaceRoot, activationSessionId!);

    const activationSession = await fixture.runtime.getSessionFile(fixture.workspaceRoot, activationSessionId!);
    expect(activationSession).toMatchObject({
      sessionId: activationSessionId,
      rootSessionId: activationSessionId,
      agentName: "lead",
    });
    expect(activationSession.parentSessionId).toBeUndefined();
    expect(await context.todos.state.findByDiscussionSessionId(activationSessionId!)).toBeUndefined();
    expect(activationSession.messages.some((message) => message.role === "user"
      && message.parts.some((part) => part.type === "text" && part.text.startsWith("Implement the following Project Todo"))))
      .toBe(true);
  });

  test("ask_user Goal authorization drives Build, remediation, fresh review, and completion", async () => {
    const objective = "Complete the migration and make every relevant test green.";
    const analystSessionIds: string[] = [];
    let rootCalls = 0;
    let buildCalls = 0;
    let analystCalls = 0;
    setLlmAdapterForTest({
      streamText: mock((options: { tools?: Record<string, unknown> }) => {
        const tools = Object.keys(options.tools ?? {});
        if (tools.includes("create_goal")) {
          rootCalls += 1;
          switch (rootCalls) {
            case 1:
              return toolStream("authorize-goal", "ask_user", {
              questions: [{
                header: "Goal",
                question: objective,
                custom: false,
                preset: "goal_authorization",
              }],
              });
            case 2:
              return toolStream("create-goal", "create_goal", { objective });
            case 3:
              return toolStream("initial-build", "delegate", {
                agent_type: "build",
                profile: "deep",
                title: "Implement the migration",
                objective: "Implement and verify the first complete migration attempt.",
                skills: ["safe-refactor"],
                background: false,
              });
            case 4:
              return toolStream("first-review", "delegate", {
                agent_type: "analyst",
                profile: "deep",
                title: "Review the migration",
                objective: "Independently review the current Goal result and return the strict verdict.",
                skills: ["goal-review"],
                background: false,
              });
            case 5:
              return toolStream("remediation-build", "delegate", {
                agent_type: "build",
                profile: "deep",
                title: "Fix review findings",
                objective: "Fix the requested change and verify the corrected result.",
                skills: ["safe-refactor"],
                background: false,
              });
            case 6:
              return toolStream("fresh-review", "delegate", {
                agent_type: "analyst",
                profile: "deep",
                title: "Fresh final Goal review",
                objective: "Review the remediated result independently and return the strict verdict.",
                skills: ["goal-review"],
                background: false,
              });
            case 7: {
              const approvedReviewSessionId = analystSessionIds[1];
              if (approvedReviewSessionId === undefined) throw new Error("Fresh approved Analyst Session was not observed");
              return toolStream("complete-goal", "update_goal", {
                status: "complete",
                reason: "The remediated result passed a fresh independent Goal review.",
                review_session_id: approvedReviewSessionId,
              });
            }
            default:
              return textStream("Goal completed after fresh approval.");
          }
        }
        if (tools.includes("file_write")) {
          buildCalls += 1;
          switch (buildCalls) {
            case 1:
              return toolStream("write-initial-result", "file_write", {
                path: "migration-result.txt",
                content: "initial\n",
              });
            case 2:
              return textStream("Initial Build result is ready for independent review.");
            case 3:
              return toolStream("read-before-remediation", "file_read", {
                path: "migration-result.txt",
              });
            case 4:
              return toolStream("write-remediation", "file_edit", {
                path: "migration-result.txt",
                edits: [{ oldString: "initial", newString: "remediated" }],
              });
            default:
              return textStream("Review findings fixed and verification rerun.");
          }
        }
        analystCalls += 1;
        return textStream(analystCalls === 1
          ? "VERDICT: CHANGES_REQUESTED\nThe first Build needs one correction."
          : "VERDICT: APPROVED\nThe remediated result satisfies the Goal.");
      }) as never,
      generateText: mock(async () => ({ text: "Goal architecture flow" })) as never,
    });
    const fixture = await runtimeFixture("Goal architecture flow");
    const root = await fixture.runtime.createSession(fixture.workspaceRoot, {
      agentName: "lead",
      title: "Goal architecture flow",
    });
    const unsubscribe = fixture.runtime.subscribeSessionEvents((event) => {
      if (event.payload.type !== "tool-child-session-link") return;
      const link = event.payload.link;
      if (link.parentSessionId !== root.sessionId || link.childAgentName !== "analyst") return;
      if (!analystSessionIds.includes(link.childSessionId)) analystSessionIds.push(link.childSessionId);
    });

    try {
      await fixture.runtime.acceptSessionMessage({
        slug: fixture.projectSlug,
        workspaceRoot: fixture.workspaceRoot,
        sessionId: root.sessionId,
        text: "Propose durable execution for the migration, but ask me before starting it.",
        clientRequestId: crypto.randomUUID(),
        source: "user",
        requestedModelSelection: {
          mode: "profile_default",
          selection: { model: "local:test" },
        },
      });

      const projectContext = await fixture.runtime.contextResolver.resolve(fixture.workspaceRoot);
      const pendingQuestion = await waitFor(async () => (
        (await projectContext.hitl.list({ statuses: ["pending"] }))
          .find((record) => record.owner.type === "session"
            && record.owner.id === root.sessionId
            && record.source.type === "ask_user")
      ));
      await fixture.runtime.respondToHitl({
        slug: fixture.projectSlug,
        workspaceRoot: fixture.workspaceRoot,
        hitlId: pendingQuestion.hitlId,
        response: { type: "question_answer", answers: ["Start Goal (Recommended)"] },
      });

      try {
        await waitForCondition(async () => {
          const session = await fixture.runtime.getSessionFile(fixture.workspaceRoot, root.sessionId);
          return session.goal?.status === "complete"
            && fixture.runtime.getSessionFamilyActivity(fixture.workspaceRoot, root.sessionId) === "idle";
        }, 10_000);
      } catch (error) {
        const current = await fixture.runtime.getSessionFile(fixture.workspaceRoot, root.sessionId);
        throw new Error(JSON.stringify({
          rootCalls,
          buildCalls,
          analystCalls,
          analystSessionIds,
          activity: fixture.runtime.getSessionFamilyActivity(fixture.workspaceRoot, root.sessionId),
          goal: current.goal,
          executions: current.executions.map(({ id, status, origin }) => ({ id, status, origin })),
          toolBatches: current.toolBatches.map((batch) => ({
            executionId: batch.executionId,
            calls: batch.calls.map((call) => ({
              toolName: call.toolName,
              state: call.state,
              input: call.input,
              response: call.blocker?.response,
            })),
          })),
          tools: current.messages.flatMap((message) => message.parts)
            .filter((part) => part.type === "tool")
            .map((part) => ({
              toolName: part.toolName,
              state: part.state,
              ...(part.state === "completed" || part.state === "error"
                ? { preview: part.result.output.preview }
                : {}),
            })),
        }), { cause: error });
      }

      const session = await fixture.runtime.getSessionFile(fixture.workspaceRoot, root.sessionId);
      const tree = await fixture.runtime.listSessionTree(fixture.workspaceRoot, root.sessionId);
      expect(session.goal).toMatchObject({ status: "complete", objective });
      expect(tree.diagnostics).toEqual([]);
      expect(tree.root.children.map(({ session: child }) => ({
        agentName: child.agentName,
        profile: child.profile,
        skills: child.activeSkillNames,
      }))).toEqual([
        { agentName: "build", profile: "deep", skills: ["safe-refactor"] },
        { agentName: "analyst", profile: "deep", skills: ["goal-review"] },
        { agentName: "build", profile: "deep", skills: ["safe-refactor"] },
        { agentName: "analyst", profile: "deep", skills: ["goal-review"] },
      ]);
      expect(analystSessionIds).toHaveLength(2);
      expect(buildCalls).toBe(5);
      expect(analystCalls).toBe(2);
      expect(await readFile(join(fixture.workspaceRoot, "migration-result.txt"), "utf8")).toBe("remediated\n");
    } finally {
      unsubscribe();
    }
  }, 15_000);
});

async function runtimeFixture(projectName: string): Promise<{
  runtime: AgentRuntime;
  workspaceRoot: string;
  projectSlug: string;
}> {
  const root = testTempRoot.path;
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(join(root, ".archcode"), { recursive: true });
  await writeFile(resolveServerConfigPath(root), JSON.stringify(config()));
  const registry = new ProjectRegistry({ homeDir: root, logger: silentLogger });
  const project = await registry.add({ workspaceRoot, name: projectName });
  const runtime = await createRuntime({
    logger: silentLogger,
    configService: new ServerConfigService({ homeDir: root }),
    projectRegistryHomeDir: root,
    mcpManagerFactory: () => mcpManager(),
  });
  activeRuntime = runtime;
  return { runtime, workspaceRoot, projectSlug: project.slug };
}

function config(): Record<string, unknown> {
  return {
    provider: {
      local: {
        npm: "@ai-sdk/openai-compatible",
        name: "Local",
        options: { baseURL: "http://localhost:8090/v1", apiKey: "test-secret" },
        models: {
          test: {
            name: "Test",
            limit: { context: 128_000, output: 8_192 },
            modalities: { input: ["text"], output: ["text"] },
          },
        },
      },
    },
    profiles: {
      principal: { model: "local:test" },
      deep: { model: "local:test" },
      fast: { model: "local:test" },
    },
    mcp: { servers: {} },
  };
}

function stoppedLlmAdapter() {
  return {
    streamText: mock(() => textStream("Done.")) as never,
    generateText: mock(async () => ({ text: "Lead architecture flow" })) as never,
  };
}

function textStream(text: string): unknown {
  return {
    fullStream: (async function* () {
      yield { type: "text-delta", text };
    })(),
    finishReason: Promise.resolve("stop"),
    usage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
    text: Promise.resolve(text),
    toolCalls: Promise.resolve([]),
  };
}

function toolStream(toolCallId: string, toolName: string, input: unknown): unknown {
  const toolCall = { toolCallId, toolName, input };
  return {
    fullStream: (async function* () {
      yield { type: "tool-input-start", id: toolCallId, toolName };
      yield { type: "tool-call", ...toolCall };
    })(),
    finishReason: Promise.resolve("tool-calls"),
    usage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
    text: Promise.resolve(""),
    toolCalls: Promise.resolve([toolCall]),
  };
}

function mcpManager(): McpManager {
  return {
    discover: mock(async () => ({ descriptors: [], warnings: [] })),
    closeAll: mock(async () => []),
    getStatus: mock(() => new Map()),
    onStatusChange: mock(() => () => {}),
    startBackgroundDiscovery: mock(() => {}),
  } as unknown as McpManager;
}

async function waitForIdle(runtime: AgentRuntime, workspaceRoot: string, rootSessionId: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (runtime.getSessionFamilyActivity(workspaceRoot, rootSessionId) === "idle") return;
    await Bun.sleep(5);
  }
  throw new Error(`Timed out waiting for Session family ${rootSessionId} to become idle`);
}

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await Bun.sleep(5);
  }
  throw new Error("Timed out waiting for full-runtime flow evidence");
}

async function waitForCondition(read: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await read()) return;
    await Bun.sleep(5);
  }
  throw new Error("Timed out waiting for full-runtime flow completion");
}
