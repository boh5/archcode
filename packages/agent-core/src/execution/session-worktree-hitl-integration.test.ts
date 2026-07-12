import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { HitlRecord, SessionMessage } from "@archcode/protocol";
import type { ArchCodeConfig } from "../config";
import { SessionAgentManager } from "../agents/session-agent-manager";
import type { AgentDefinition } from "../agents/factory-types";
import { GoalStateManager } from "../goals/state";
import { HitlService } from "../hitl/service";
import { ResumeCoordinator } from "../hitl/resume-coordinator";
import { setLlmAdapterForTest } from "../llm";
import { LoopStateManager } from "../loops/state";
import { MemoryFileManager } from "../memory/file-manager";
import { ProjectContextResolver } from "../projects/context-resolver";
import type { ProjectContext } from "../projects/types";
import type { ProviderRegistry } from "../provider";
import { ModelInfo } from "../provider/model";
import { SkillService } from "../skills";
import { SessionStoreManager } from "../store/session-store-manager";
import { getSessionHitlPath } from "../store/sessions-dir";
import { createRegistry } from "../tools";
import { fileReadTool, worktreeEnterTool } from "../tools/builtins";
import { ProjectApprovalManager } from "../tools/permission";
import { createTestProjectContext, createTestProjectContextResolverOptions } from "../tools/test-project-context";
import { WorktreeService } from "../worktrees";
import { silentLogger } from "../logger";
import { SessionHitlResumeAdapter } from "./session-hitl-resume-adapter";
import { SessionExecutionManager } from "./session-execution-manager";
import { SessionExecutionScopeValidator } from "./session-execution-scope-validator";
import { SessionHitlResumeInProgressError } from "../agents/errors";
import { SessionFamilyActiveError } from "./session-family-control";

const TMP_ROOT = join(import.meta.dir, "__test_tmp__", "session-worktree-hitl-integration");
const SKILL_NAME = "worktree-skill";

function identity(record: Pick<HitlRecord, "owner" | "hitlId">) {
  return { owner: record.owner, hitlId: record.hitlId };
}

const testDefinition: AgentDefinition = {
  name: "engineer",
  displayName: "Engineer",
  promptProfileId: "default",
  tools: { tools: ["file_read"] },
  hooks: {
    autoCompact: false,
    autoInjectReminder: false,
    todoStepReminder: false,
    todoQueryLoopContinuation: false,
    transcriptSave: false,
    memoryExtraction: false,
    memoryConsolidation: false,
    titleGeneration: "disabled",
  },
  includeMemoryInPrompt: false,
  skills: [SKILL_NAME],
};

describe("durable Session worktree approval integration", () => {
  afterEach(async () => {
    setLlmAdapterForTest(undefined);
    await rm(TMP_ROOT, { recursive: true, force: true });
  });

  test("rebuilds the Agent from worktree prompt, AGENTS, Skill, and file root", async () => {
    await mkdir(TMP_ROOT, { recursive: true });
    const projectRoot = await mkdtemp(join(TMP_ROOT, "project-"));
    const sessionId = crypto.randomUUID();
    await initializeGitRepo(projectRoot);

    const created = await new WorktreeService({ canonicalRoot: projectRoot }).create({
      owner: { type: "session", id: sessionId },
    });
    await writeFile(join(created.worktreePath, "AGENTS.md"), "# WORKTREE_AGENTS_MARKER\n\nUse only the worktree checkout.\n");
    await writeFile(join(created.worktreePath, "scope.txt"), "WORKTREE_FILE_MARKER\n");
    await writeFile(
      join(created.worktreePath, ".archcode", "skills", SKILL_NAME, "SKILL.md"),
      skillMarkdown("WORKTREE_SKILL_MARKER"),
    );

    const sessions = new SessionStoreManager({ logger: silentLogger });
    const store = sessions.create(sessionId, projectRoot, { agentName: "engineer" });
    const goalState = new GoalStateManager(projectRoot, silentLogger);
    const loopState = new LoopStateManager(projectRoot, silentLogger);
    const hitl = new HitlService({
      workspaceRoot: projectRoot,
      project: { slug: "project", name: "Project" },
      sessions,
      goalState,
      loopState,
    });
    const approvals = new ProjectApprovalManager(silentLogger);
    await approvals.load(projectRoot);
    const projectContext: ProjectContext = {
      ...createTestProjectContext(projectRoot),
      project: { slug: "project", name: "Project", workspaceRoot: projectRoot, addedAt: new Date().toISOString() },
      goalState,
      goalCancellation: { cancel: async (goalId, request) => await goalState.cancel(goalId, request.reason) },
      loopState,
      hitl,
      hitlResumeCoordinator: new ResumeCoordinator({ hitl, adapters: {} }),
      memory: new MemoryFileManager({
        project: join(projectRoot, ".archcode", "memory"),
        user: join(projectRoot, ".archcode", "user-memory"),
      }),
      approvals,
    };
    const resolver = new ProjectContextResolver({
      ...createTestProjectContextResolverOptions(sessions),
      projectInfoFactory: () => projectContext.project,
      goalCancellationFactory: () => projectContext.goalCancellation,
      resumeCoordinatorFactory: () => projectContext.hitlResumeCoordinator,
    });
    resolver.alias(projectRoot, projectContext);
    const executionScopeValidator = new SessionExecutionScopeValidator({
      projectContextResolver: resolver,
      loopExecutionClaimResolver: { resolve: async () => ({ outcome: "allow" as const }) },
    });
    const providerRegistry = makeProviderRegistry();
    const skillService = new SkillService({ builtinSkills: {} });
    const toolRegistry = createRegistry([fileReadTool, worktreeEnterTool]);
    const agents = new SessionAgentManager({
      definitions: [testDefinition],
      providerRegistry,
      toolRegistry,
      skillService,
      storeManager: sessions,
      projectContextResolver: resolver,
      config: {
        provider: {},
        agents: { engineer: { model: providerRegistry.modelIds[0]! } },
      } as unknown as ArchCodeConfig,
      logger: silentLogger,
    });
    const executionManager = new SessionExecutionManager({
      sessionAgentManager: agents,
      createSessionStore: (createdSessionId, workspaceRoot, options) => sessions.create(createdSessionId, workspaceRoot, options),
      flushSessionStore: (createdSessionId, workspaceRoot) => sessions.flushSession(createdSessionId, workspaceRoot),
      getSessionStore: (loadedSessionId, workspaceRoot) => sessions.get(loadedSessionId, workspaceRoot),
      loadSessionStore: (loadedSessionId, workspaceRoot) => sessions.getOrLoad(loadedSessionId, workspaceRoot),
      deleteSessionStore: (deletedSessionId, workspaceRoot, options) => sessions.delete(deletedSessionId, workspaceRoot, options),
      resolveRootSessionId: (resolvedSessionId, workspaceRoot) => sessions.resolveRootSessionId(resolvedSessionId, workspaceRoot),
      buildSessionTree: (workspaceRoot, rootSessionId) => sessions.buildSessionTree(workspaceRoot, rootSessionId),
      listSessionFamilyBlockedHitlIds: (workspaceRoot, rootSessionId) => sessions.listSessionFamilyBlockedHitlIds(workspaceRoot, rootSessionId),
      trackSession: () => undefined,
      untrackSession: () => undefined,
      executionScopeValidator,
      logger: silentLogger,
    });
    agents.setAcquireSessionCwdTransition((workspaceRoot, guardedSessionId) => (
      executionManager.acquireSessionCwdTransition(workspaceRoot, guardedSessionId)
    ));
    const adapter = new SessionHitlResumeAdapter({
      workspaceRoot: projectRoot,
      storeManager: sessions,
      toolRegistry,
      projectContextResolver: resolver,
      executionScopeValidator,
      skillService,
      getAgent: async (workspaceRoot, resumedSessionId) => await agents.getOrCreate(workspaceRoot, resumedSessionId),
      reserveSessionHitlResume: (workspaceRoot, resumedSessionId, rootSessionId, options) => (
        executionManager.reserveSessionHitlResume(workspaceRoot, resumedSessionId, rootSessionId, options)
      ),
    });
    const coordinator = new ResumeCoordinator({ hitl, adapters: { session: adapter } });
    projectContext.hitlResumeCoordinator = coordinator;

    const systemPrompts: string[] = [];
    let signalContinuationStarted!: () => void;
    let finishContinuation!: () => void;
    const continuationStarted = new Promise<void>((resolve) => { signalContinuationStarted = resolve; });
    const continuationFinished = new Promise<void>((resolve) => { finishContinuation = resolve; });
    let modelCall = 0;
    const streamText = mock((options: { system?: string }) => {
      systemPrompts.push(options.system ?? "");
      modelCall += 1;
      if (modelCall === 1) {
        return toolCallStream("worktree-enter", "worktree_enter", { path: created.worktreePath });
      }
      if (modelCall === 2) {
        return toolCallStream("read-scope", "file_read", { path: "scope.txt" });
      }
      return deferredTextStream("done", signalContinuationStarted, continuationFinished);
    });
    setLlmAdapterForTest({ streamText: streamText as never });

    const originalAgent = await agents.getOrCreate(projectRoot, sessionId);
    await originalAgent.run("Enter the worktree selected by the user.");
    const pending = await singlePendingHitl(projectRoot, sessionId);
    expect(pending.source).toMatchObject({
      type: "tool_permission",
      sessionId,
      toolCallId: "worktree-enter",
      toolName: "worktree_enter",
    });

    const response = await coordinator.respond(identity(pending), {
      type: "permission_decision",
      decision: "approve_once",
    });
    expect(response).toMatchObject({ status: "claimed", scheduled: true });
    await continuationStarted;

    await expect(executionManager.startCheckedExecution({
      slug: "project",
      workspaceRoot: projectRoot,
      sessionId,
      userMessage: "must not interleave with durable continuation",
    })).rejects.toThrow(SessionFamilyActiveError);
    expect(() => executionManager.acquireSessionCwdTransition(projectRoot, sessionId))
      .toThrow(SessionHitlResumeInProgressError);

    finishContinuation();
    await waitFor(async () => {
      const found = await hitl.lookup(identity(pending));
      return found.status === "found" && found.record.status === "resolved";
    });

    const rebuiltAgent = agents.get(projectRoot, sessionId);
    expect(rebuiltAgent).toBeDefined();
    expect(rebuiltAgent).not.toBe(originalAgent);
    expect(rebuiltAgent?.cwd).toBe(created.worktreePath);
    expect(store.getState().cwd).toBe(created.worktreePath);
    const releaseAfterResume = executionManager.acquireSessionCwdTransition(projectRoot, sessionId);
    releaseAfterResume();
    expect(systemPrompts).toHaveLength(3);
    expect(systemPrompts[1]).toContain(`Working directory: ${created.worktreePath}`);
    expect(systemPrompts[1]).toContain("Execution mode: worktree");
    expect(systemPrompts[1]).toContain("WORKTREE_AGENTS_MARKER");
    expect(systemPrompts[1]).toContain("WORKTREE_SKILL_MARKER");
    expect(latestToolOutput(store.getState().messages, "read-scope")).toContain("WORKTREE_FILE_MARKER");
  });
});

function makeProviderRegistry(): ProviderRegistry {
  const model = new ModelInfo({
    model: {} as ConstructorParameters<typeof ModelInfo>[0]["model"],
    config: {
      name: "Test Model",
      limit: { context: 128_000, output: 8_192 },
      modalities: { input: ["text"], output: ["text"] },
    },
    providerId: "test",
    modelId: "model",
  });
  return {
    sdkRegistry: {} as ProviderRegistry["sdkRegistry"],
    models: new Map([[model.qualifiedId, model]]),
    modelIds: [model.qualifiedId],
    getModel: () => model,
  } as ProviderRegistry;
}

function toolCallStream(toolCallId: string, toolName: string, input: unknown) {
  const toolCall = { toolCallId, toolName, input };
  return {
    fullStream: (async function* () {
      yield { type: "tool-call" as const, ...toolCall };
    })(),
    finishReason: Promise.resolve("tool-calls"),
    usage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
    text: Promise.resolve(""),
    toolCalls: Promise.resolve([toolCall]),
  };
}

function textStream(text: string) {
  return {
    fullStream: (async function* () {
      yield { type: "text-delta" as const, text };
    })(),
    finishReason: Promise.resolve("stop"),
    usage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
    text: Promise.resolve(text),
    toolCalls: Promise.resolve([]),
  };
}

function deferredTextStream(text: string, onStarted: () => void, waitUntilFinished: Promise<void>) {
  return {
    fullStream: (async function* () {
      onStarted();
      await waitUntilFinished;
      yield { type: "text-delta" as const, text };
    })(),
    finishReason: Promise.resolve("stop"),
    usage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
    text: Promise.resolve(text),
    toolCalls: Promise.resolve([]),
  };
}

async function singlePendingHitl(projectRoot: string, sessionId: string): Promise<HitlRecord> {
  const file = await Bun.file(getSessionHitlPath(projectRoot, sessionId)).json() as { pending: HitlRecord[] };
  expect(file.pending).toHaveLength(1);
  return file.pending[0]!;
}

function latestToolOutput(messages: readonly SessionMessage[], toolCallId: string): string {
  for (const message of [...messages].reverse()) {
    for (const part of [...message.parts].reverse()) {
      if (part.type === "tool" && part.toolCallId === toolCallId && part.state === "completed") return part.output;
    }
  }
  throw new Error(`Missing completed tool part ${toolCallId}`);
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error("condition was not met");
}

async function initializeGitRepo(projectRoot: string): Promise<void> {
  await git(projectRoot, ["init", "--initial-branch=main"]);
  await git(projectRoot, ["config", "user.email", "session-worktree@example.com"]);
  await git(projectRoot, ["config", "user.name", "Session Worktree"]);
  await mkdir(join(projectRoot, ".archcode", "skills", SKILL_NAME), { recursive: true });
  await writeFile(join(projectRoot, "AGENTS.md"), "# CANONICAL_AGENTS\n");
  await writeFile(join(projectRoot, "scope.txt"), "CANONICAL_FILE\n");
  await writeFile(join(projectRoot, ".archcode", "skills", SKILL_NAME, "SKILL.md"), skillMarkdown("CANONICAL_SKILL"));
  await git(projectRoot, ["add", "."]);
  await git(projectRoot, ["commit", "-m", "initial commit"]);
}

function skillMarkdown(description: string): string {
  return [
    "---",
    `name: ${SKILL_NAME}`,
    `description: ${description}`,
    "when_to_use: Use this skill for worktree integration tests.",
    "---",
    "Follow the current checkout instructions.",
    "",
  ].join("\n");
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  const process = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const stderr = await new Response(process.stderr).text();
  if (await process.exited !== 0) throw new Error(stderr);
}
