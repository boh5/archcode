import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { silentLogger } from "../logger";
import { SessionStoreManager } from "../store/session-store-manager";
import { SessionFamilyStopService } from "./session-family-stop-service";
import type { DelegationRequest } from "@archcode/protocol";

const TMP_ROOT = join(import.meta.dir, "__test_tmp__", "session-family-stop-service", crypto.randomUUID());

beforeEach(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
  await mkdir(TMP_ROOT, { recursive: true });
});

afterAll(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
});

describe("SessionFamilyStopService", () => {
  test("drains the family before cancelling each Session tool batch", async () => {
    const sessions = new SessionStoreManager({ logger: silentLogger });
    const rootSessionId = crypto.randomUUID();
    const childSessionId = crypto.randomUUID();
    const delegationRequest: DelegationRequest = {
      agent_type: "explore",
      title: "Inspect family stop",
      objective: "Provide a durable child identity for family-stop cleanup.",
      owned_scope: [],
      skills: [],
      background: false,
    };
    sessions.create(rootSessionId, TMP_ROOT, { agentName: "engineer" });
    sessions.create(childSessionId, TMP_ROOT, {
      agentName: "explore",
      rootSessionId,
      parentSessionId: rootSessionId,
      delegationRequest,
    });
    await Promise.all([
      sessions.flushSession(rootSessionId, TMP_ROOT),
      sessions.flushSession(childSessionId, TMP_ROOT),
    ]);
    const events: string[] = [];
    const release = mock(() => { events.push("release"); });
    const cancelSessionToolBatch = mock(async (sessionId: string, workspaceRoot: string, reason: string) => {
      events.push(`cancel:${sessionId}`);
      expect(workspaceRoot).toBe(TMP_ROOT);
      expect(reason).toBe("session_family_stopped");
    });
    const service = new SessionFamilyStopService({
      sessionFamilyController: {
        acquireStop: () => ({
          rootSessionId,
          stopAndWait: async () => { events.push("drained"); },
          release,
        }),
      },
      sessionStoreManager: sessions,
      cancelSessionToolBatch,
    });

    await service.stop(TMP_ROOT, rootSessionId);

    expect(events).toEqual([
      "drained",
      `cancel:${rootSessionId}`,
      `cancel:${childSessionId}`,
      "release",
    ]);
    expect(cancelSessionToolBatch).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(1);
  });

  test("releases the stop lease when batch cancellation fails", async () => {
    const sessions = new SessionStoreManager({ logger: silentLogger });
    const rootSessionId = crypto.randomUUID();
    sessions.create(rootSessionId, TMP_ROOT, { agentName: "engineer" });
    await sessions.flushSession(rootSessionId, TMP_ROOT);
    const release = mock(() => undefined);
    const service = new SessionFamilyStopService({
      sessionFamilyController: {
        acquireStop: () => ({ rootSessionId, stopAndWait: async () => undefined, release }),
      },
      sessionStoreManager: sessions,
      cancelSessionToolBatch: async () => { throw new Error("batch cleanup failed"); },
    });

    await expect(service.stop(TMP_ROOT, rootSessionId)).rejects.toThrow("batch cleanup failed");
    expect(release).toHaveBeenCalledTimes(1);
  });
});
