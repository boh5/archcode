import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import type { SessionHitlCheckpoint } from "@archcode/protocol";

import { silentLogger } from "../logger";
import { SessionStoreManager } from "../store/session-store-manager";
import {
  getSessionHitlCheckpointPath,
  writeSessionHitlCheckpoint,
} from "./session-hitl-checkpoint";
import { SessionFamilyStopService } from "./session-family-stop-service";

const TMP_ROOT = join(import.meta.dir, "__test_tmp__", "session-family-stop-service", crypto.randomUUID());

class FailingClearSessionStoreManager extends SessionStoreManager {
  override async clearHitlBlockers(): Promise<void> {
    throw new Error("simulated session snapshot failure");
  }
}

beforeEach(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
  await mkdir(TMP_ROOT, { recursive: true });
});

afterAll(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
});

describe("SessionFamilyStopService", () => {
  test("keeps the recovery checkpoint when durable blocker clearing fails", async () => {
    const workspaceRoot = join(TMP_ROOT, "workspace");
    await mkdir(workspaceRoot, { recursive: true });
    const sessionId = crypto.randomUUID();
    const hitlId = crypto.randomUUID();
    const sessions = new FailingClearSessionStoreManager({ logger: silentLogger });
    sessions.create(sessionId, workspaceRoot, { agentName: "engineer" });
    await sessions.setHitlBlocker(sessionId, workspaceRoot, blocker(sessionId, hitlId));
    await writeCheckpoint(workspaceRoot, sessionId, hitlId);

    const cancelOwner = mock(async () => []);
    const release = mock(() => undefined);
    const service = new SessionFamilyStopService({
      sessionFamilyController: {
        acquireStop: () => ({
          rootSessionId: sessionId,
          stopAndWait: async () => undefined,
          release,
        }),
      },
      sessionStoreManager: sessions,
      resolveHitlOwner: async () => ({
        projectSlug: "project",
        hitl: { cancelOwner } as never,
      }),
    });

    await expect(service.stop(workspaceRoot, sessionId)).rejects.toThrow("simulated session snapshot failure");

    expect(cancelOwner).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(await Bun.file(getSessionHitlCheckpointPath(workspaceRoot, sessionId)).exists()).toBe(true);
    const coldSessions = new SessionStoreManager({ logger: silentLogger });
    expect((await coldSessions.getOrLoad(sessionId, workspaceRoot)).getState()).toMatchObject({
      blockedByHitlIds: [hitlId],
    });
  });
});

function blocker(sessionId: string, hitlId: string): SessionHitlCheckpoint {
  return {
    version: 1,
    hitlId,
    blockingKey: `session:${sessionId}:ask`,
    source: { type: "ask_user", sessionId, toolCallId: "ask" },
    toolCallId: "ask",
    toolName: "ask_user",
    step: 0,
    displayInput: {},
    blockedAt: new Date().toISOString(),
    reason: "Waiting for answer",
  };
}

async function writeCheckpoint(workspaceRoot: string, sessionId: string, hitlId: string): Promise<void> {
  const createdAt = new Date().toISOString();
  await writeSessionHitlCheckpoint({
    version: 1,
    phase: "paused",
    phaseUpdatedAt: createdAt,
    hitlId,
    blockingKey: `session:${sessionId}:ask`,
    source: { type: "ask_user", sessionId, toolCallId: "ask" },
    request: {
      owner: { projectSlug: "project", ownerType: "session", ownerId: sessionId },
      displayPayload: { title: "Continue?", redacted: true },
      createdAt,
    },
    toolCallId: "ask",
    toolName: "ask_user",
    step: 0,
    rawToolInput: {},
    displayInput: {},
    allowedTools: ["ask_user"],
    agentSkills: [],
    agentName: "engineer",
    toolCalls: [{ toolCallId: "ask", toolName: "ask_user", input: {} }],
    completedToolResults: [],
    pendingToolCalls: [{ toolCallId: "ask", toolName: "ask_user", input: {} }],
    blockedToolIndex: 0,
    createdAt,
    kind: "ask_user",
  }, workspaceRoot, sessionId);
}
