import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
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
  test("Todo Discussion generates and improves its one Markdown Plan through the Plan Skill", async () => {
    const fixture = await runtimeFixture("Todo Plan authoring flow");
    const context = await fixture.runtime.contextResolver.resolve(fixture.workspaceRoot);
    const idea = await context.todos.createTodo({
      content: "Make durable execution visible\n\nExpose execution progress without adding another work item state machine.",
    });

    const planPath = `.archcode/plans/${idea.id}.md`;
    const initialPlan = `# Durable execution visibility Plan

## Goal and background

Make durable execution progress visible while keeping the Project Todo as the only work item.

## Scope and non-goals

- Scope: expose the existing Session execution progress in the Todo detail.
- Non-goal: add a Plan service, Plan status, or another workflow state machine.

## Implementation steps

1. Read the existing Todo and Session projections.
2. Add the smallest Todo-detail projection of existing execution progress.
3. Verify the projection without changing Todo lifecycle transitions.

## Dependencies and order

The Session projection contract must be confirmed before the Web projection is changed.

## Acceptance criteria

- Opening the bound Todo while its Lead Session is running shows the current execution status from the existing Session projection.
- Starting and finishing work leaves the Todo lifecycle transitions identical to the four-state contract.
- Protocol and route schemas contain no Plan entity, Plan status, or Plan-to-Goal identifier.

## Verification

Run the focused protocol, Todo route, and Web Todo tests; then inspect the rendered Todo detail for the running and completed states.

## Risks and open decisions

- Risk: stale Session data could show an outdated execution status; verify SSE invalidation in the focused Web test.
- Open decisions: none.
`;
    const addedCriterion = "- Reloading the Todo detail after completion shows the completed Session status without creating a second Todo or Plan file.";
    let planCalls = 0;
    setLlmAdapterForTest({
      streamText: mock(() => {
        planCalls += 1;
        switch (planCalls) {
          case 1:
            return toolStream("read-plan-skill-1", "skill_read", { name: "plan-work" });
          case 2:
            return toolStream("write-plan", "file_write", {
              path: planPath,
              content: initialPlan,
            });
          case 3:
            return textStream("The Plan has been generated at the unique Todo Plan path.");
          case 4:
            return toolStream("read-plan-skill-2", "skill_read", { name: "plan-work" });
          case 5:
            return toolStream("read-existing-plan", "file_read", { path: planPath });
          case 6:
            return toolStream("improve-plan", "file_edit", {
              path: planPath,
              edits: [{
                oldString: "## Verification",
                newString: `${addedCriterion}\n\n## Verification`,
              }],
            });
          default:
            return textStream("The existing Plan has been improved in place.");
        }
      }) as never,
      generateText: mock(async () => ({ text: "Todo Plan authoring flow" })) as never,
    });

    const discussion = await context.todos.createSession(idea.id, {
      expectedRevision: idea.revision,
      entry: "discussion",
      initialIntent: "plan",
    });
    await waitForFamilyIdle(
      fixture.runtime,
      fixture.workspaceRoot,
      fixture.projectSlug,
      discussion.sessionId,
    );

    await fixture.runtime.acceptSessionMessage({
      slug: fixture.projectSlug,
      workspaceRoot: fixture.workspaceRoot,
      sessionId: discussion.sessionId,
      text: `/skill use plan-work Improve the existing implementation Plan at ${planPath}.`,
      attachmentIds: [],
      clientRequestId: crypto.randomUUID(),
      source: "user",
      requestedModelSelection: {
        mode: "profile_default",
        selection: { model: "local:test" },
      },
    });
    await waitForFamilyIdle(
      fixture.runtime,
      fixture.workspaceRoot,
      fixture.projectSlug,
      discussion.sessionId,
    );

    const session = await fixture.runtime.getSessionFile(
      fixture.workspaceRoot,
      discussion.sessionId,
    );
    expect(toolTrace(session)).toEqual([
      "skill_read",
      "file_write",
      "skill_read",
      "file_read",
      "file_edit",
    ]);
    expect(userTextInputs(session)).toHaveLength(2);
    expect(userTextInputs(session).every((input) =>
      input.startsWith('Use Skill "plan-work" for this request. First call skill_read'),
    )).toBe(true);
    expect(session.messages.flatMap((message) => message.role === "user" ? message.parts : [])
      .filter((part) => part.type === "system-notice")
      .map((part) => part.notice)).toEqual([
      'Activating skill "plan-work"...',
      'Activating skill "plan-work"...',
    ]);
    expect(await readFile(join(fixture.workspaceRoot, planPath), "utf8"))
      .toBe(initialPlan.replace("## Verification", `${addedCriterion}\n\n## Verification`));
    expect(await readdir(join(fixture.workspaceRoot, ".archcode", "plans")))
      .toEqual([`${idea.id}.md`]);
    expect(await context.todos.readTodo(idea.id)).toMatchObject({
      status: "idea",
      revision: idea.revision,
    });
    expect(session.goal).toBeUndefined();
    expect(planCalls).toBe(7);
  });

  test("Todo Discussion reaches Ready and starts a fresh ordinary Lead Session", async () => {
    const fixture = await runtimeFixture("Todo architecture flow");
    const context = await fixture.runtime.contextResolver.resolve(fixture.workspaceRoot);
    const idea = await context.todos.createTodo({
      content: "Clarify the durable execution UX\n\nAgree the outcome before implementation.",
    });

    const discussion = await context.todos.createSession(idea.id, {
      expectedRevision: idea.revision,
      entry: "discussion",
    });
    const discussionSessionId = discussion.sessionId;
    await waitForFamilyIdle(
      fixture.runtime,
      fixture.workspaceRoot,
      fixture.projectSlug,
      discussionSessionId,
    );

    const discussionSession = await fixture.runtime.getSessionFile(fixture.workspaceRoot, discussionSessionId);
    expect(discussionSession).toMatchObject({
      sessionId: discussionSessionId,
      rootSessionId: discussionSessionId,
      agentName: "discussion",
      source: { kind: "todo", todoId: idea.id, entry: "discussion" },
    });
    expect(discussionSession.parentSessionId).toBeUndefined();

    const ready = await context.todos.updateFromDiscussion({
      authorization: {
        sessionId: discussionSessionId,
        rootSessionId: discussionSessionId,
        agentName: "discussion",
        projectSlug: fixture.projectSlug,
        source: discussionSession.source,
      },
      expectedRevision: discussion.todo.revision,
      patch: {
        content: "Clarify the durable execution UX\n\nThe outcome and acceptance boundary are confirmed.",
        status: "ready",
      },
    });
    expect(ready.status).toBe("ready");

    const work = await context.todos.createSession(ready.id, {
      expectedRevision: ready.revision,
      entry: "work",
    });
    const workSessionId = work.sessionId;
    expect(workSessionId).not.toBe(discussionSessionId);
    await waitForFamilyIdle(
      fixture.runtime,
      fixture.workspaceRoot,
      fixture.projectSlug,
      workSessionId,
    );

    const workSession = await fixture.runtime.getSessionFile(fixture.workspaceRoot, workSessionId);
    expect(workSession).toMatchObject({
      sessionId: workSessionId,
      rootSessionId: workSessionId,
      agentName: "lead",
      source: { kind: "todo", todoId: ready.id, entry: "work" },
    });
    expect(workSession.parentSessionId).toBeUndefined();
    const acceptedWorkInputs = [
      ...workSession.pendingMessages.map((message) => message.content),
      ...workSession.messages.flatMap((message) => (
        message.role === "user"
          ? message.parts.flatMap((part) => part.type === "text" ? [part.text] : [])
          : []
      )),
    ];
    expect(acceptedWorkInputs.some((text) => text.startsWith("Implement the following Project Todo")))
      .toBe(true);
    expect(workSession.goal).toBeUndefined();
  });

  test("Start Work reads execute-plan and the Plan before continuing without a Goal", async () => {
    const fixture = await runtimeFixture("Plan execution without Goal");
    const context = await fixture.runtime.contextResolver.resolve(fixture.workspaceRoot);
    const idea = await context.todos.createTodo({
      content: "Execute a reviewed Plan without Goal\n\nThe user wants an ordinary execution after reviewing the Plan.",
    });
    const ready = await context.todos.updateTodo(idea.id, {
      expectedRevision: idea.revision,
      status: "ready",
    });
    const planPath = `.archcode/plans/${ready.id}.md`;
    await mkdir(join(fixture.workspaceRoot, ".archcode", "plans"), { recursive: true });
    await writeFile(join(fixture.workspaceRoot, planPath), executablePlan());

    let rootCalls = 0;
    setLlmAdapterForTest({
      streamText: mock(() => {
        rootCalls += 1;
        switch (rootCalls) {
          case 1:
            return toolStream("read-execute-plan-skill-no-goal", "skill_read", {
              name: "execute-plan",
            });
          case 2:
            return toolStream("read-plan-no-goal", "file_read", { path: planPath });
          case 3:
            return toolStream("ask-goal-no", "ask_user", {
              questions: [{
                header: "Goal",
                question: "Create a Goal for this Plan execution?",
              }],
            });
          default:
            return textStream("Continue as an ordinary Lead execution without a Goal.");
        }
      }) as never,
      generateText: mock(async () => ({ text: "Plan execution without Goal" })) as never,
    });
    const pendingQuestionPromise = nextPendingQuestion(fixture.runtime);
    const work = await context.todos.createSession(ready.id, {
      expectedRevision: ready.revision,
      entry: "work",
    });
    const pendingQuestion = await pendingQuestionPromise;
    expect(pendingQuestion.sessionId).toBe(work.sessionId);

    await fixture.runtime.respondToHitl({
      slug: fixture.projectSlug,
      workspaceRoot: fixture.workspaceRoot,
      hitlId: pendingQuestion.hitlId,
      response: {
        type: "question_answer",
        answers: ["Continue ordinary execution without a Goal."],
      },
    });
    await waitForFamilyIdle(
      fixture.runtime,
      fixture.workspaceRoot,
      fixture.projectSlug,
      work.sessionId,
    );

    const session = await fixture.runtime.getSessionFile(fixture.workspaceRoot, work.sessionId);
    expect(session.agentName).toBe("lead");
    expect(session.goal).toBeUndefined();
    expect(toolTrace(session)).toEqual(["skill_read", "file_read", "ask_user"]);
    expect(rootCalls).toBe(4);
  });

  test("Start Work reads execute-plan and the Plan before creating the approved Goal", async () => {
    const fixture = await runtimeFixture("Plan execution with Goal");
    const context = await fixture.runtime.contextResolver.resolve(fixture.workspaceRoot);
    const idea = await context.todos.createTodo({
      content: "Execute a reviewed Plan with Goal\n\nThe user wants durable Goal supervision for the Plan.",
    });
    const ready = await context.todos.updateTodo(idea.id, {
      expectedRevision: idea.revision,
      status: "ready",
    });
    const planPath = `.archcode/plans/${ready.id}.md`;
    const objective = [
      "Deliver the bound Todo through the existing Lead execution path.",
      "The focused tests must pass with zero failures, the Todo must remain the sole work item,",
      "and no Plan entity or Plan-to-Goal link may be persisted.",
    ].join(" ");
    await mkdir(join(fixture.workspaceRoot, ".archcode", "plans"), { recursive: true });
    await writeFile(join(fixture.workspaceRoot, planPath), executablePlan());

    let rootCalls = 0;
    setLlmAdapterForTest({
      streamText: mock(() => {
        rootCalls += 1;
        switch (rootCalls) {
          case 1:
            return toolStream("read-execute-plan-skill-goal", "skill_read", {
              name: "execute-plan",
            });
          case 2:
            return toolStream("read-plan-goal", "file_read", { path: planPath });
          case 3:
            return toolStream("ask-goal-yes", "ask_user", {
              questions: [{
                header: "Goal",
                question: "Create a Goal from the Plan objective and acceptance criteria?",
              }],
            });
          case 4:
            return toolStream("create-approved-goal", "create_goal", { objective });
          default:
            return textStream("The approved Goal is active and execution can proceed.");
        }
      }) as never,
      generateText: mock(async () => ({ text: "Plan execution with Goal" })) as never,
    });
    const pendingQuestionPromise = nextPendingQuestion(fixture.runtime);
    const work = await context.todos.createSession(ready.id, {
      expectedRevision: ready.revision,
      entry: "work",
    });
    const pendingQuestion = await pendingQuestionPromise;
    expect(pendingQuestion.sessionId).toBe(work.sessionId);

    await fixture.runtime.respondToHitl({
      slug: fixture.projectSlug,
      workspaceRoot: fixture.workspaceRoot,
      hitlId: pendingQuestion.hitlId,
      response: {
        type: "question_answer",
        answers: ["Yes, create the Goal from the Plan."],
      },
    });
    await waitForFamilyIdle(
      fixture.runtime,
      fixture.workspaceRoot,
      fixture.projectSlug,
      work.sessionId,
    );

    const session = await fixture.runtime.getSessionFile(fixture.workspaceRoot, work.sessionId);
    expect(session.agentName).toBe("lead");
    expect(session.goal).toMatchObject({ status: "active", objective });
    expect(toolTrace(session)).toEqual([
      "skill_read",
      "file_read",
      "ask_user",
      "create_goal",
    ]);
    expect(rootCalls).toBe(5);
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
      source: { kind: "direct" },
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
        attachmentIds: [],
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
          tools: current.messages.flatMap((message) => message.role === "assistant" ? message.parts : [])
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
      const id = crypto.randomUUID();
      yield { type: "text-start", id };
      yield { type: "text-delta", id, text };
      yield { type: "text-end", id };
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

function nextPendingQuestion(
  runtime: AgentRuntime,
): Promise<{ hitlId: string; sessionId: string }> {
  return new Promise((resolve) => {
    const unsubscribe = runtime.subscribeHitlEvents((event) => {
      if (event.payload.type !== "hitl.request"
        || event.view.owner.type !== "session"
        || event.view.source.type !== "ask_user") return;
      unsubscribe();
      resolve({
        hitlId: event.view.hitlId,
        sessionId: event.view.owner.id,
      });
    });
  });
}

function toolTrace(session: Awaited<ReturnType<AgentRuntime["getSessionFile"]>>): string[] {
  return session.messages.flatMap((message) => message.role === "assistant" ? message.parts : [])
    .filter((part) => part.type === "tool")
    .map((part) => part.toolName);
}

function userTextInputs(session: Awaited<ReturnType<AgentRuntime["getSessionFile"]>>): string[] {
  return session.messages.flatMap((message) => message.role === "user" ? message.parts : [])
    .filter((part) => part.type === "text")
    .map((part) => part.text);
}

function executablePlan(): string {
  return `# Reviewed execution Plan

## Goal and background

Deliver the Todo through the existing Lead execution path.

## Scope and non-goals

- Scope: implement the bound Todo.
- Non-goal: create a Plan service or Plan-to-Goal link.

## Implementation steps

1. Read the affected code.
2. Implement the scoped change.
3. Run the named verification.

## Dependencies and order

Inspect current behavior before editing, then verify after implementation.

## Acceptance criteria

- The focused tests pass with zero failures.
- The Todo remains the sole work item and no Plan entity is persisted.

## Verification

Run the focused test command and inspect the final diff.

## Risks and open decisions

- Risk: implementation may expose an unrelated regression; the full test suite is the final check.
- Open decisions: none.
`;
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
