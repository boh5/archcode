import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ServerConfigService, resolveServerConfigPath } from "./config";
import { setLlmAdapterForTest } from "./llm";
import { silentLogger } from "./logger";
import { ProjectRegistry } from "./projects/registry";
import { createRuntime, type AgentRuntime } from "./runtime";
import { createTestTempRoot } from "./testing/test-temp-root";
import { createTestMcpRuntime } from "./testing/test-mcp-runtime";

const testTempRoot = createTestTempRoot("multi-agent-control-plane");
const activeRuntimes = new Set<AgentRuntime>();

beforeEach(async () => {
  await testTempRoot.cleanup();
  await mkdir(testTempRoot.path, { recursive: true });
});

afterEach(async () => {
  for (const runtime of activeRuntimes) {
    runtime.notifyRuntimeShutdown("test cleanup");
    await runtime.shutdown();
  }
  activeRuntimes.clear();
  setLlmAdapterForTest(undefined);
});

afterAll(async () => {
  await testTempRoot.cleanup();
});

describe("multi-Agent delegation control plane", () => {
  test("steers a background Analyst and drains two queued messages through one linked continuation", async () => {
    const fixture = await runtimeFixture("Analyst queue chain");
    const root = await fixture.runtime.createSession(fixture.workspaceRoot, {
      agentName: "lead",
      source: { kind: "direct" },
      title: "Control-plane Lead",
    });
    let analystSessionId: string | undefined;
    let analystExecutionId: string | undefined;
    let buildSessionId: string | undefined;
    let markSteerClaimed!: () => void;
    const steerClaimed = new Promise<void>((resolve) => {
      markSteerClaimed = resolve;
    });
    const unsubscribe = fixture.runtime.subscribeSessionEvents((event) => {
      if (
        event.payload.type === "session.message_steer_claimed"
        && event.payload.message.content.startsWith("STEER:")
      ) {
        markSteerClaimed();
        return;
      }
      if (event.payload.type !== "tool-child-session-link") return;
      const link = event.payload.link;
      if (link.parentSessionId !== root.sessionId || link.toolName !== "delegate") return;
      if (link.childAgentName === "analyst") {
        analystSessionId = link.childSessionId;
        analystExecutionId = link.childExecutionId;
      } else if (link.childAgentName === "build") {
        buildSessionId = link.childSessionId;
      }
    });

    let leadCalls = 0;
    let analystCalls = 0;
    let analystSteerModelInput = "";
    let analystQueueModelInput = "";
    let releaseAnalystAfterQueues!: () => void;
    const analystQueuesAccepted = new Promise<void>((resolve) => {
      releaseAnalystAfterQueues = resolve;
    });
    setLlmAdapterForTest({
      streamText: mock((options: LlmOptions) => {
        const tools = Object.keys(options.tools ?? {});
        if (tools.includes("create_goal")) {
          leadCalls += 1;
          switch (leadCalls) {
            case 1:
              return toolStream("delegate-analyst", "delegate", {
                agent_type: "analyst",
                profile: "deep",
                title: "Analyze the control plane",
                objective: "Inspect the control-plane evidence and incorporate parent steering.",
                skills: [],
                background: true,
              });
            case 2:
              return toolStream("delegate-build", "delegate", {
                agent_type: "build",
                profile: "deep",
                title: "Build sibling",
                objective: "Provide an independent completed sibling result.",
                skills: [],
                background: true,
              });
            case 3:
              return toolStream("list-running-tree", "list_agents", { page_size: 100 });
            case 4:
              return toolStream("steer-analyst", "send_message", {
                session_id: required(analystSessionId, "analyst Session"),
                expected_execution_id: required(analystExecutionId, "analyst Execution"),
                message: "STEER: inspect the admission boundary before answering.",
                delivery: "steer",
              });
            case 5:
              return toolStream("queue-analyst-one", "send_message", {
                session_id: required(analystSessionId, "analyst Session"),
                expected_execution_id: required(analystExecutionId, "analyst Execution"),
                message: "QUEUE-ONE: verify all links for the continuation.",
                delivery: "queue",
              });
            case 6:
              return toolStream("queue-analyst-two", "send_message", {
                session_id: required(analystSessionId, "analyst Session"),
                expected_execution_id: required(analystExecutionId, "analyst Execution"),
                message: "QUEUE-TWO: report the chain-tail reminder.",
                delivery: "queue",
              });
            case 7:
              // Reaching the next Lead model boundary proves both preceding
              // send_message Queue calls settled durably.
              releaseAnalystAfterQueues();
              return toolStream("wait-analyst-tail", "wait_for_reminder", {
                session_ids: [required(analystSessionId, "analyst Session")],
                condition: "all",
                timeout_ms: 10_000,
              });
            case 8:
              return toolStream("read-analyst-tail", "background_output", {
                session_id: required(analystSessionId, "analyst Session"),
                block: true,
                timeout_ms: 10_000,
                full_session: false,
                include_tool_results: false,
                include_reasoning: false,
              });
            default:
              return textStream("Lead integrated the Analyst queue-chain result and Build sibling result.");
          }
        }

        if (tools.includes("file_write")) {
          return textStream("Build sibling completed independently.");
        }

        analystCalls += 1;
        if (analystCalls === 1) {
          const currentModelInput = JSON.stringify(options.messages ?? []);
          if (currentModelInput.includes("STEER: inspect the admission boundary")) {
            analystSteerModelInput = currentModelInput;
            return toolStream("analyst-list-tree", "list_agents", { page_size: 100 });
          }
          return deferredToolStream(
            async () => await steerClaimed,
            "analyst-list-tree",
            "list_agents",
            { page_size: 100 },
          );
        }
        if (analystCalls === 2) {
          analystSteerModelInput = JSON.stringify(options.messages ?? []);
          return deferredTextStream(async () => {
            await analystQueuesAccepted;
          }, "Analyst incorporated the current-Execution steer.");
        }
        analystQueueModelInput = JSON.stringify(options.messages ?? []);
        return textStream("Analyst queue chain completed with both queued requests.");
      }) as never,
      generateText: mock(async () => ({ text: "Control plane" })) as never,
    });

    try {
      await fixture.runtime.acceptSessionMessage({
        slug: fixture.projectSlug,
        workspaceRoot: fixture.workspaceRoot,
        sessionId: root.sessionId,
        text: "Run the complete background Analyst and Build control-plane scenario.",
        attachmentIds: [],
        clientRequestId: crypto.randomUUID(),
        source: "user",
        requestedModelSelection,
      });
      await waitForFamilyIdle(fixture, root.sessionId);

      const analystId = required(analystSessionId, "analyst Session");
      const initialExecutionId = required(analystExecutionId, "analyst Execution");
      expect(buildSessionId).toBeString();
      let rootFile = await fixture.runtime.getSessionFile(fixture.workspaceRoot, root.sessionId);
      expect(completedToolPreview(rootFile, "wait_for_reminder")).toContain('"status":"success"');
      let analystTerminalDiagnostic: unknown;
      await waitUntil(async () => {
        const currentRoot = await fixture.runtime.getSessionFile(fixture.workspaceRoot, root.sessionId);
        const currentAnalyst = await fixture.runtime.getSessionFile(fixture.workspaceRoot, analystId);
        const links = currentRoot.childSessionLinks.filter((link) => link.childSessionId === analystId);
        analystTerminalDiagnostic = {
          links: links.map((link) => ({
            toolName: link.toolName,
            status: link.status,
            childExecutionId: link.childExecutionId,
          })),
          executions: currentAnalyst.executions.map((execution) => ({
            id: execution.id,
            status: execution.status,
          })),
        };
        return links.length === 4
          && links.every((link) => link.status === "completed")
          && currentAnalyst.executions.length === 2
          && currentAnalyst.executions.at(-1)?.status === "completed";
      }).catch((error: unknown) => {
        throw new Error(`${error instanceof Error ? error.message : String(error)}: ${JSON.stringify(analystTerminalDiagnostic)}`);
      });
      rootFile = await fixture.runtime.getSessionFile(fixture.workspaceRoot, root.sessionId);
      const analystFile = await fixture.runtime.getSessionFile(fixture.workspaceRoot, analystId);
      const tree = await fixture.runtime.listSessionTree(fixture.workspaceRoot, root.sessionId);

      expect(tree.root.children.map((child) => child.session.agentName)).toEqual(["analyst", "build"]);
      const listAgentsPreview = completedToolPreview(rootFile, "list_agents");
      expect(listAgentsPreview).toContain(root.sessionId);
      expect(listAgentsPreview).toContain(analystId);
      expect(listAgentsPreview).toContain(required(buildSessionId, "build Session"));
      expect(listAgentsPreview).not.toContain("messages");

      expect(analystSteerModelInput).toContain("STEER: inspect the admission boundary");
      expect(analystQueueModelInput).toContain("QUEUE-ONE: verify all links");
      expect(analystQueueModelInput).toContain("QUEUE-TWO: report the chain-tail reminder");
      const parentInputs = analystFile.messages
        .filter((message) => message.role === "user")
        .filter((message) => message.inputSource === "parent_agent");
      expect(parentInputs.map(messageText)).toEqual([
        "STEER: inspect the admission boundary before answering.",
        "QUEUE-ONE: verify all links for the continuation.",
        "QUEUE-TWO: report the chain-tail reminder.",
      ]);
      expect(parentInputs[0]?.executionId).toBe(initialExecutionId);
      expect(parentInputs[1]?.executionId).toBe(parentInputs[2]?.executionId);
      expect(parentInputs[1]?.executionId).not.toBe(initialExecutionId);
      expect(parentInputs.every((message) => message.parentAgentProvenance?.senderSessionId === root.sessionId)).toBe(true);

      const analystLinks = rootFile.childSessionLinks.filter((link) => link.childSessionId === analystId);
      expect(analystLinks).toHaveLength(4);
      expect(analystLinks.every((link) => link.status === "completed")).toBe(true);
      expect(analystLinks.map((link) => link.toolName)).toEqual([
        "delegate",
        "send_message",
        "send_message",
        "send_message",
      ]);
      expect(analystLinks[1]?.childExecutionId).toBe(initialExecutionId);
      expect(new Set(analystLinks.slice(2).map((link) => link.childExecutionId)).size).toBe(1);
      const continuationExecutionId = required(analystLinks[2]?.childExecutionId, "Analyst continuation Execution");
      expect(continuationExecutionId).toBe(required(analystFile.executions.at(-1)?.id, "latest Analyst Execution"));
      expect(analystFile.executions).toHaveLength(2);

      const analystReminders = rootFile.reminders.filter((reminder) => reminder.sessionId === analystId);
      expect(analystReminders).toHaveLength(1);
      expect(analystReminders[0]).toMatchObject({
        source: {
          type: "subagent_completed",
          sessionId: analystId,
          childExecutionId: continuationExecutionId,
        },
        consumedAt: expect.any(Number),
      });
      expect(completedToolPreview(rootFile, "wait_for_reminder")).toContain(continuationExecutionId);
      expect(completedToolPreview(rootFile, "background_output")).toContain(
        "Analyst queue chain completed with both queued requests.",
      );
    } finally {
      unsubscribe();
    }
  }, 30_000);

  test("races Explore queue acceptance with subtree cancellation, then atomically resumes after restart", async () => {
    const fixture = await runtimeFixture("Explore cancel and restart");
    const root = await fixture.runtime.createSession(fixture.workspaceRoot, {
      agentName: "lead",
      source: { kind: "direct" },
      title: "Restart Lead",
    });
    let buildSessionId: string | undefined;
    let buildExecutionId: string | undefined;
    let exploreSessionId: string | undefined;
    let exploreExecutionId: string | undefined;
    let enterRacingPersist!: () => void;
    const racingPersistEntered = new Promise<void>((resolve) => {
      enterRacingPersist = resolve;
    });
    let releaseRacingPersist!: () => void;
    const racingPersistReleased = new Promise<void>((resolve) => {
      releaseRacingPersist = resolve;
    });
    let racingPersistBlocked = false;
    let cancelToolAttempted = false;
    const restoreBunWrite = interceptBunWrite(async (destination, content) => {
      if (
        racingPersistBlocked
        || exploreSessionId === undefined
        || !destination.includes(`/sessions/${exploreSessionId}/`)
        || !content.includes("RACING-QUEUE: overlap durable acceptance with cancellation.")
      ) return;
      racingPersistBlocked = true;
      enterRacingPersist();
      await racingPersistReleased;
    });
    const unsubscribe = fixture.runtime.subscribeSessionEvents((event) => {
      if (
        event.sessionId === root.sessionId
        && event.payload.type === "tool-attempt"
        && event.payload.toolName === "cancel_session"
      ) {
        // The real Queue save remains pending until cancel_session has entered
        // the Registry execution boundary, so acceptance and cancellation race
        // without blocking the Tree snapshot that cancel itself requires.
        cancelToolAttempted = true;
        releaseRacingPersist();
      }
      if (event.payload.type !== "tool-child-session-link") return;
      const link = event.payload.link;
      if (link.childAgentName === "build" && link.parentSessionId === root.sessionId) {
        buildSessionId = link.childSessionId;
        buildExecutionId = link.childExecutionId;
      }
      if (link.childAgentName === "explore") {
        exploreSessionId = link.childSessionId;
        exploreExecutionId = link.childExecutionId;
      }
    });

    let leadCalls = 0;
    let buildCalls = 0;
    setLlmAdapterForTest({
      streamText: mock((options: LlmOptions) => {
        const tools = Object.keys(options.tools ?? {});
        if (tools.includes("create_goal")) {
          leadCalls += 1;
          if (leadCalls === 1) {
            return toolStream("delegate-build", "delegate", {
              agent_type: "build",
              profile: "deep",
              title: "Build with Explore child",
              objective: "Delegate a bounded Explore check and preserve its queued follow-up across cancellation.",
              skills: [],
              background: true,
            });
          }
          if (leadCalls === 2) {
            return deferredToolStream(
              async () => {
                await withTimeout(racingPersistEntered, 5_000, "racing Queue persistence did not reach the barrier");
              },
              "cancel-explore-subtree",
              "cancel_session",
              { session_id: () => required(exploreSessionId, "Explore Session") },
            );
          }
          if (leadCalls === 3) {
            return toolStream("read-build-result", "background_output", {
              session_id: required(buildSessionId, "Build Session"),
              block: true,
              timeout_ms: 10_000,
              full_session: false,
              include_tool_results: false,
              include_reasoning: false,
            });
          }
          return textStream("Lead captured the cancelled-subtree result.");
        }

        if (tools.includes("file_write")) {
          buildCalls += 1;
          if (buildCalls === 1) {
            return toolStream("delegate-explore", "delegate", {
              agent_type: "explore",
              profile: "fast",
              title: "Explore cancellation target",
              objective: "Hold the inspection boundary until the parent decides whether to continue.",
              skills: [],
              background: true,
            });
          }
          if (buildCalls === 2) {
            return toolStream("queue-explore", "send_message", {
              session_id: required(exploreSessionId, "Explore Session"),
              expected_execution_id: required(exploreExecutionId, "Explore Execution"),
              message: "RETAINED-QUEUE: inspect after restart.",
              delivery: "queue",
            });
          }
          if (buildCalls === 3) {
            return toolStream("race-queue-explore", "send_message", {
              session_id: required(exploreSessionId, "Explore Session"),
              expected_execution_id: required(exploreExecutionId, "Explore Execution"),
              message: "RACING-QUEUE: overlap durable acceptance with cancellation.",
              delivery: "queue",
            });
          }
          return textStream("Build observed the queued Explore cancellation.");
        }

        return abortableStream(options.abortSignal);
      }) as never,
      generateText: mock(async () => ({ text: "Cancel and restart" })) as never,
    });

    try {
      await fixture.runtime.acceptSessionMessage({
        slug: fixture.projectSlug,
        workspaceRoot: fixture.workspaceRoot,
        sessionId: root.sessionId,
        text: "Exercise cancellation and restart recovery for the nested Explore child.",
        attachmentIds: [],
        clientRequestId: crypto.randomUUID(),
        source: "user",
        requestedModelSelection,
      });
      await withTimeout(
        waitForFamilyIdle(fixture, root.sessionId),
        10_000,
        "cancelled family did not become idle",
      );
      restoreBunWrite();

      const buildId = required(buildSessionId, "Build Session");
      const exploreId = required(exploreSessionId, "Explore Session");
      const beforeRestart = await fixture.runtime.getSessionFile(fixture.workspaceRoot, exploreId);
      const retained = beforeRestart.pendingMessages.filter((message) => message.state === "queued");
      const retainedContents = retained.map((message) => message.content);
      expect(beforeRestart.executions.at(-1)?.status).toBe("cancelled");
      expect(beforeRestart.queueDispatchBarrierAt).toBeNumber();
      expect(retainedContents[0]).toBe("RETAINED-QUEUE: inspect after restart.");
      expect(retainedContents).toSatisfy((contents: string[]) => (
        contents.length === 1
        || (
          contents.length === 2
          && contents[1] === "RACING-QUEUE: overlap durable acceptance with cancellation."
        )
      ));
      expect(racingPersistBlocked).toBe(true);
      expect(cancelToolAttempted).toBe(true);
      expect(fixture.runtime.getSessionFamilyActivity(fixture.workspaceRoot, root.sessionId)).toBe("idle");
      expect(completedToolPreview(
        await fixture.runtime.getSessionFile(fixture.workspaceRoot, root.sessionId),
        "cancel_session",
      )).toContain('"status":"cancelled"');

      const stableMessage = retained.find((message) => message.content.startsWith("RETAINED-QUEUE:"));
      const racingMessage = retained.find((message) => message.content.startsWith("RACING-QUEUE:"));
      expect(stableMessage).toBeDefined();
      expect(beforeRestart.inputRequestReceipts.filter((receipt) =>
        receipt.kind === "message" && receipt.messageId === stableMessage?.id
      )).toHaveLength(1);
      expect(beforeRestart.inputRequestReceipts.filter((receipt) =>
        receipt.kind === "message" && receipt.messageId === racingMessage?.id
      ).length).toBeLessThanOrEqual(1);
      const buildBeforeRestart = await fixture.runtime.getSessionFile(fixture.workspaceRoot, buildId);
      const racingToolParts = buildBeforeRestart.messages
        .flatMap((message) => message.role === "assistant" ? message.parts : [])
        .filter((part) => part.type === "tool")
        .filter((part) => part.toolCallId === "race-queue-explore");
      expect(racingToolParts).toHaveLength(1);
      expect(racingToolParts[0]?.state).toSatisfy((state) => state === "completed" || state === "error");
      if (racingToolParts[0]?.state === "completed") {
        expect(racingToolParts[0].result.output.preview).toContain('"delivery":"queued"');
        expect(racingMessage).toBeDefined();
      } else {
        expect(racingMessage).toBeUndefined();
      }

      const cancelledExecutionCount = beforeRestart.executions.length;
      await Bun.sleep(25);
      const quiescentAfterCancel = await fixture.runtime.getSessionFile(fixture.workspaceRoot, exploreId);
      expect(quiescentAfterCancel.executions).toHaveLength(cancelledExecutionCount);
      expect(quiescentAfterCancel.executions.at(-1)?.status).toBe("cancelled");
      expect(quiescentAfterCancel.pendingMessages
        .filter((message) => message.state === "queued")
        .map((message) => message.content)).toEqual(retainedContents);

      const identityBefore = {
        agentName: beforeRestart.agentName,
        profile: beforeRestart.profile,
        activeSkillNames: beforeRestart.activeSkillNames,
        delegationRequest: beforeRestart.delegationRequest,
      };
      const executionCountBeforeRestart = cancelledExecutionCount;
      fixture.runtime.notifyRuntimeShutdown("restart boundary");
      await fixture.runtime.shutdown();
      activeRuntimes.delete(fixture.runtime);

      const restarted = await restartRuntime(fixture);
      await restarted.runtime.recoverSessionContinuations();
      await Bun.sleep(25);
      const recovered = await restarted.runtime.getSessionFile(fixture.workspaceRoot, exploreId);
      expect(recovered.executions).toHaveLength(executionCountBeforeRestart);
      expect(recovered.pendingMessages.filter((message) => message.state === "queued").map((message) => message.content))
        .toEqual(retainedContents);
      expect(recovered.inputRequestReceipts.filter((receipt) =>
        receipt.kind === "message"
        && retained.some((message) => message.id === receipt.messageId)
      )).toHaveLength(retained.length);
      expect(restarted.runtime.getSessionFamilyActivity(fixture.workspaceRoot, root.sessionId)).toBe("idle");

      let restartedLeadCalls = 0;
      let restartedBuildCalls = 0;
      setLlmAdapterForTest({
        streamText: mock((options: LlmOptions) => {
          const tools = Object.keys(options.tools ?? {});
          if (tools.includes("create_goal")) {
            restartedLeadCalls += 1;
            if (restartedLeadCalls === 1) {
              return toolStream("resume-build", "resume_session", {
                session_id: buildId,
                instruction: "Resume the same Build responsibility and recover the retained Explore queue.",
                background: false,
              });
            }
            return textStream("Lead verified the restart-resumed subtree.");
          }
          if (tools.includes("file_write")) {
            restartedBuildCalls += 1;
            if (restartedBuildCalls === 1) {
              return toolStream("resume-explore", "resume_session", {
                session_id: exploreId,
                instruction: "RESUME-INSTRUCTION: finish the retained inspection.",
                background: false,
              });
            }
            return textStream("Build integrated the resumed Explore result.");
          }
          return textStream("Explore resumed after restart with its retained queue.");
        }) as never,
        generateText: mock(async () => ({ text: "Restart continuation" })) as never,
      });

      await restarted.runtime.acceptSessionMessage({
        slug: fixture.projectSlug,
        workspaceRoot: fixture.workspaceRoot,
        sessionId: root.sessionId,
        text: "Resume the stopped Build and its retained Explore work.",
        attachmentIds: [],
        clientRequestId: crypto.randomUUID(),
        source: "user",
        requestedModelSelection,
      });
      await waitForFamilyIdle(restarted, root.sessionId);

      const afterResume = await restarted.runtime.getSessionFile(fixture.workspaceRoot, exploreId);
      expect({
        agentName: afterResume.agentName,
        profile: afterResume.profile,
        activeSkillNames: afterResume.activeSkillNames,
        delegationRequest: afterResume.delegationRequest,
      }).toEqual(identityBefore);
      expect(afterResume.queueDispatchBarrierAt).toBeUndefined();
      expect(afterResume.pendingMessages.filter((message) => message.state === "queued")).toEqual([]);
      expect(afterResume.executions).toHaveLength(executionCountBeforeRestart + 1);
      expect(afterResume.executions.at(-1)?.status).toBe("completed");
      const resumedExecutionId = afterResume.executions.at(-1)!.id;
      const resumedInputs = afterResume.messages
        .filter((message) => message.role === "user")
        .filter((message) =>
          message.inputSource === "parent_agent"
          && message.executionId === resumedExecutionId
        );
      expect(resumedInputs.map(messageText)).toEqual([
        ...retainedContents,
        "RESUME-INSTRUCTION: finish the retained inspection.",
      ]);
      const initialBuildExecutionId = required(buildExecutionId, "initial Build Execution");
      expect(resumedInputs.slice(0, retainedContents.length).every(
        (message) => message.parentAgentProvenance?.senderExecutionId === initialBuildExecutionId,
      )).toBe(true);
      expect(resumedInputs.at(-1)?.parentAgentProvenance?.senderExecutionId).not.toBe(initialBuildExecutionId);
      expect(resumedInputs.every((message) => message.parentAgentProvenance?.senderSessionId === buildId)).toBe(true);
    } finally {
      releaseRacingPersist();
      restoreBunWrite();
      unsubscribe();
    }
  }, 30_000);
});

interface RuntimeFixture {
  readonly runtime: AgentRuntime;
  readonly workspaceRoot: string;
  readonly projectSlug: string;
  readonly homeDir: string;
  readonly projectRegistry: ProjectRegistry;
}

interface LlmOptions {
  readonly tools?: Record<string, unknown>;
  readonly messages?: unknown[];
  readonly abortSignal: AbortSignal;
}

const requestedModelSelection = {
  mode: "profile_default" as const,
  selection: { model: "local:test" },
};

async function runtimeFixture(projectName: string): Promise<RuntimeFixture> {
  const homeDir = testTempRoot.path;
  const workspaceRoot = join(homeDir, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(join(homeDir, ".archcode"), { recursive: true });
  await writeFile(resolveServerConfigPath(homeDir), JSON.stringify(config()));
  const projectRegistry = new ProjectRegistry({ homeDir, logger: silentLogger });
  const project = await projectRegistry.add({ workspaceRoot, name: projectName });
  const runtime = await createReadyRuntime(homeDir, projectRegistry);
  return { runtime, workspaceRoot, projectSlug: project.slug, homeDir, projectRegistry };
}

async function restartRuntime(fixture: RuntimeFixture): Promise<RuntimeFixture> {
  const runtime = await createReadyRuntime(fixture.homeDir, fixture.projectRegistry);
  return { ...fixture, runtime };
}

async function createReadyRuntime(homeDir: string, projectRegistry: ProjectRegistry): Promise<AgentRuntime> {
  const configService = new ServerConfigService({ homeDir });
  const activationResult = await configService.activateForStartup();
  if (activationResult.status !== "ready") {
    throw new Error(`Expected ready config, received ${activationResult.status}`);
  }
  const runtime = await createRuntime({
    logger: silentLogger,
    configService,
    activation: activationResult.activation,
    projectRegistry,
    runtimeStorageHomeDir: homeDir,
    mcpRuntimeFactory: () => createTestMcpRuntime(),
  });
  activeRuntimes.add(runtime);
  return runtime;
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

function deferredTextStream(beforeOutput: () => Promise<void>, text: string): unknown {
  return {
    fullStream: (async function* () {
      await beforeOutput();
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

function deferredToolStream(
  beforeCall: () => Promise<void>,
  toolCallId: string,
  toolName: string,
  input: Record<string, unknown>,
): unknown {
  const ready = beforeCall();
  const resolveInput = (): Record<string, unknown> => Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key, typeof value === "function" ? value() : value]),
  );
  return {
    fullStream: (async function* () {
      await ready;
      const resolved = resolveInput();
      yield { type: "tool-input-start", id: toolCallId, toolName };
      yield { type: "tool-call", toolCallId, toolName, input: resolved };
    })(),
    finishReason: Promise.resolve("tool-calls"),
    usage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
    text: Promise.resolve(""),
    toolCalls: (async () => {
      await ready;
      return [{ toolCallId, toolName, input: resolveInput() }];
    })(),
  };
}

function abortableStream(abortSignal: AbortSignal): unknown {
  return {
    fullStream: (async function* () {
      if (!abortSignal.aborted) {
        await new Promise<void>((resolve) => abortSignal.addEventListener("abort", () => resolve(), { once: true }));
      }
    })(),
    finishReason: Promise.resolve("stop"),
    usage: Promise.resolve({ inputTokens: 1, outputTokens: 0, totalTokens: 1 }),
    text: Promise.resolve(""),
    toolCalls: Promise.resolve([]),
  };
}

function waitForFamilyIdle(fixture: Pick<RuntimeFixture, "runtime" | "workspaceRoot" | "projectSlug">, rootSessionId: string): Promise<void> {
  return new Promise((resolve) => {
    const unsubscribe = fixture.runtime.subscribeSessionRuntimeChanges((event) => {
      if (event.projectSlug !== fixture.projectSlug
        || event.rootSessionId !== rootSessionId
        || event.activity !== "idle") return;
      unsubscribe();
      resolve();
    });
    if (fixture.runtime.getSessionFamilyActivity(fixture.workspaceRoot, rootSessionId) === "idle") {
      unsubscribe();
      resolve();
    }
  });
}

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for integration-test control-plane state");
    await Bun.sleep(5);
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return await Promise.race([
    promise,
    Bun.sleep(timeoutMs).then(() => {
      throw new Error(message);
    }),
  ]);
}

function interceptBunWrite(
  beforeWrite: (destination: string, content: string) => Promise<void>,
): () => void {
  type LooseBunWrite = (...args: unknown[]) => Promise<number>;
  const bunRuntime = Bun as unknown as { write: LooseBunWrite };
  const originalWrite = bunRuntime.write.bind(Bun);
  let restored = false;
  bunRuntime.write = async (...args: unknown[]) => {
    const destination = typeof args[0] === "string" ? args[0] : String(args[0]);
    const content = typeof args[1] === "string" ? args[1] : "";
    await beforeWrite(destination, content);
    return await originalWrite(...args);
  };
  return () => {
    if (restored) return;
    restored = true;
    bunRuntime.write = originalWrite;
  };
}

function completedToolPreview(
  session: Awaited<ReturnType<AgentRuntime["getSessionFile"]>>,
  toolName: string,
): string {
  const part = session.messages.flatMap((message) => message.role === "assistant" ? message.parts : [])
    .find((candidate) => candidate.type === "tool" && candidate.toolName === toolName && candidate.state === "completed");
  if (part === undefined || part.type !== "tool" || part.state !== "completed") {
    throw new Error(`Completed ${toolName} result not found`);
  }
  return part.result.output.preview;
}

function messageText(message: { readonly parts: readonly { readonly type: string; readonly text?: string }[] }): string {
  return message.parts.flatMap((part) => part.type === "text" && part.text !== undefined ? [part.text] : []).join("\n");
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`${label} was not captured`);
  return value;
}
