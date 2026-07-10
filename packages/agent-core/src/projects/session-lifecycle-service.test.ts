import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { writeSessionHitlCheckpoint } from "../execution/session-hitl-checkpoint";
import { SessionDeleteOwnerConflictError } from "../execution/session-deletion";
import { silentLogger } from "../logger";
import { SessionStoreManager } from "../store/session-store-manager";
import { ProjectContextResolver } from "./context-resolver";
import { SessionLifecycleService } from "./session-lifecycle-service";

const TMP_ROOT = join(import.meta.dir, "__test_tmp__", "session-lifecycle-service");
const ORDINARY_SESSION_ID = "11111111-1111-4111-8111-111111111111";
const GOAL_SESSION_ID = "22222222-2222-4222-8222-222222222222";
const LOOP_SESSION_ID = "33333333-3333-4333-8333-333333333333";
const BLOCKED_SESSION_ID = "44444444-4444-4444-8444-444444444444";

beforeEach(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
  await mkdir(TMP_ROOT, { recursive: true });
});

afterAll(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
});

describe("SessionLifecycleService", () => {
  test("allows deletion of an ordinary Session subtree", async () => {
    const fixture = createFixture();
    fixture.sessions.create(ORDINARY_SESSION_ID, TMP_ROOT);

    await expect(fixture.service.assertDeletable({
      workspaceRoot: TMP_ROOT,
      rootSessionId: ORDINARY_SESSION_ID,
      sessionIds: [ORDINARY_SESSION_ID],
    })).resolves.toBeUndefined();
  });

  test("rejects Goal- and Loop-owned Sessions with stable owner details", async () => {
    const fixture = createFixture();
    fixture.sessions.create(GOAL_SESSION_ID, TMP_ROOT, { goalId: "goal-1" });
    fixture.sessions.create(LOOP_SESSION_ID, TMP_ROOT, { loopId: "loop-1" });

    await expect(fixture.service.assertDeletable({
      workspaceRoot: TMP_ROOT,
      rootSessionId: GOAL_SESSION_ID,
      sessionIds: [GOAL_SESSION_ID, LOOP_SESSION_ID],
    })).rejects.toMatchObject({
      name: "SessionDeleteOwnerConflictError",
      code: "SESSION_DELETE_OWNER_CONFLICT",
      sessionIds: [GOAL_SESSION_ID, LOOP_SESSION_ID],
      owners: [
        { sessionId: GOAL_SESSION_ID, ownerType: "goal", ownerId: "goal-1" },
        { sessionId: LOOP_SESSION_ID, ownerType: "loop", ownerId: "loop-1" },
      ],
    } satisfies Partial<SessionDeleteOwnerConflictError>);
  });

  test("rejects active Session HITL and durable checkpoints", async () => {
    const fixture = createFixture();
    fixture.sessions.create(BLOCKED_SESSION_ID, TMP_ROOT);
    const context = await fixture.resolver.resolve(TMP_ROOT);
    await context.hitl.create({
      owner: { projectSlug: "project", ownerType: "session", ownerId: BLOCKED_SESSION_ID },
      blockingKey: "question-1",
      source: { type: "ask_user", sessionId: BLOCKED_SESSION_ID, toolCallId: "ask-1" },
      displayPayload: {
        title: "Question",
        questions: [{ question: "Continue?", header: "Continue", options: [], custom: true }],
        redacted: true,
      },
      hitlId: "hitl-active",
    });
    await writeSessionHitlCheckpoint({
      version: 1,
      hitlId: "hitl-checkpoint",
      blockingKey: "permission-1",
      source: { type: "tool_permission", sessionId: BLOCKED_SESSION_ID, toolCallId: "write-1", toolName: "file_write" },
      toolCallId: "write-1",
      toolName: "file_write",
      step: 0,
      rawToolInput: {},
      displayInput: {},
      allowedTools: ["file_write"],
      agentSkills: [],
      toolCalls: [{ toolCallId: "write-1", toolName: "file_write", input: {} }],
      completedToolResults: [],
      pendingToolCalls: [{ toolCallId: "write-1", toolName: "file_write", input: {} }],
      blockedToolIndex: 0,
      createdAt: new Date().toISOString(),
      kind: "permission",
      permission: { description: "Write file" },
    }, TMP_ROOT, BLOCKED_SESSION_ID);

    await expect(fixture.service.assertDeletable({
      workspaceRoot: TMP_ROOT,
      rootSessionId: BLOCKED_SESSION_ID,
      sessionIds: [BLOCKED_SESSION_ID],
    })).rejects.toMatchObject({
      owners: [
        { sessionId: BLOCKED_SESSION_ID, ownerType: "session_hitl", hitlIds: ["hitl-active"] },
        { sessionId: BLOCKED_SESSION_ID, ownerType: "session_hitl_checkpoint", hitlIds: ["hitl-checkpoint"] },
      ],
    });
  });
});

function createFixture() {
  const sessions = new SessionStoreManager({ logger: silentLogger });
  const resolver = new ProjectContextResolver({
    projectInfoFactory: () => ({
      slug: "project",
      name: "Project",
      workspaceRoot: TMP_ROOT,
      addedAt: new Date(0).toISOString(),
    }),
    sessionStoreManager: sessions,
  });
  const service = new SessionLifecycleService({ storeManager: sessions, projectContextResolver: resolver });
  return { sessions, resolver, service };
}
