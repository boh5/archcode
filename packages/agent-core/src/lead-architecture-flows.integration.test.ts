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
    await waitForFamilyIdle(
      fixture.runtime,
      fixture.workspaceRoot,
      fixture.projectSlug,
      discussionSessionId!,
    );

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
    await waitForFamilyIdle(
      fixture.runtime,
      fixture.workspaceRoot,
      fixture.projectSlug,
      activationSessionId!,
    );

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

  test("ordinary ask_user confirmation can precede Goal execution", async () => {
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
                questions: [{ header: "Goal", question: "要开始这个长期任务吗？" }],
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
                objective: "Independently review the current Goal result and report any material gaps.",
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
                objective: "Review the remediated result independently and report the evidence and residual risk.",
                skills: ["goal-review"],
                background: false,
              });
            case 7:
              return toolStream("complete-goal", "update_goal", {
                status: "complete",
                reason: "The remediated result passed a fresh independent Goal review.",
              });
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
          ? "The Goal is not complete yet: the first Build needs one correction."
          : "The remediated result satisfies the Goal. Evidence is complete and residual risk is low.");
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
      const pendingQuestionPromise = nextPendingSessionQuestion(
        fixture.runtime,
        root.sessionId,
      );
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

      const pendingQuestion = await pendingQuestionPromise;
      const goalCompleted = nextGoalCompletion(fixture.runtime, root.sessionId);
      await fixture.runtime.respondToHitl({
        slug: fixture.projectSlug,
        workspaceRoot: fixture.workspaceRoot,
        hitlId: pendingQuestion.hitlId,
        response: { type: "question_answer", answers: ["好"] },
      });

      try {
        await goalCompleted;
        await waitForFamilyIdle(
          fixture.runtime,
          fixture.workspaceRoot,
          fixture.projectSlug,
          root.sessionId,
        );
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
  });
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
  const configService = new ServerConfigService({ homeDir: root });
  const activationResult = await configService.activateForStartup();
  if (activationResult.status !== "ready") throw new Error(`Expected ready config, received ${activationResult.status}`);
  const runtime = await createRuntime({
    logger: silentLogger,
    configService,
    activation: activationResult.activation,
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

function waitForFamilyIdle(
  runtime: AgentRuntime,
  workspaceRoot: string,
  projectSlug: string,
  rootSessionId: string,
): Promise<void> {
  return new Promise((resolve) => {
    const unsubscribe = runtime.subscribeSessionRuntimeChanges((event) => {
      if (event.projectSlug !== projectSlug
        || event.rootSessionId !== rootSessionId
        || event.activity !== "idle") return;
      unsubscribe();
      resolve();
    });
    if (runtime.getSessionFamilyActivity(workspaceRoot, rootSessionId) === "idle") {
      unsubscribe();
      resolve();
    }
  });
}

function nextPendingSessionQuestion(
  runtime: AgentRuntime,
  sessionId: string,
): Promise<{ hitlId: string }> {
  return new Promise((resolve) => {
    const unsubscribe = runtime.subscribeHitlEvents((event) => {
      if (event.payload.type !== "hitl.request"
        || event.view.owner.type !== "session"
        || event.view.owner.id !== sessionId
        || event.view.source.type !== "ask_user") return;
      unsubscribe();
      resolve({ hitlId: event.view.hitlId });
    });
  });
}

function nextGoalCompletion(runtime: AgentRuntime, sessionId: string): Promise<void> {
  return new Promise((resolve) => {
    const unsubscribe = runtime.subscribeSessionEvents((event) => {
      if (event.sessionId !== sessionId
        || event.payload.type !== "session.goal_changed"
        || event.payload.status !== "complete") return;
      unsubscribe();
      resolve();
    });
  });
}
