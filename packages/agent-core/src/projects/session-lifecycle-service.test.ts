import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { SessionDeleteOwnerConflictError } from "../execution/session-deletion";
import { silentLogger } from "../logger";
import { SessionStoreManager } from "../store/session-store-manager";
import { SessionLifecycleService } from "./session-lifecycle-service";

const TMP_ROOT = join(import.meta.dir, "__test_tmp__", "session-lifecycle-service", crypto.randomUUID());
const ORDINARY_SESSION_ID = "11111111-1111-4111-8111-111111111111";
const GOAL_SESSION_ID = "22222222-2222-4222-8222-222222222222";
const GOAL_OWNER_ID = "55555555-5555-4555-8555-555555555555";

beforeEach(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
  await mkdir(TMP_ROOT, { recursive: true });
});

afterAll(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
});

describe("SessionLifecycleService", () => {
  test("preflight only rejects Goal ownership", async () => {
    const fixture = createFixture();
    fixture.sessions.create(GOAL_SESSION_ID, TMP_ROOT, { goalId: GOAL_OWNER_ID, agentName: "goal_lead" });
    await fixture.sessions.flushSession(GOAL_SESSION_ID, TMP_ROOT);

    await expect(fixture.service.assertDeletable({
      workspaceRoot: TMP_ROOT,
      rootSessionId: GOAL_SESSION_ID,
      sessionIds: [GOAL_SESSION_ID],
    })).rejects.toMatchObject({
      name: "SessionDeleteOwnerConflictError",
      code: "SESSION_DELETE_OWNER_CONFLICT",
      sessionIds: [GOAL_SESSION_ID],
      owners: [{ sessionId: GOAL_SESSION_ID, ownerType: "goal", ownerId: GOAL_OWNER_ID }],
    } satisfies Partial<SessionDeleteOwnerConflictError>);
    expect(fixture.cancelSessionToolBatch).not.toHaveBeenCalled();
  });

  test("allows an ordinary Session without consulting HITL state", async () => {
    const fixture = createFixture();
    fixture.sessions.create(ORDINARY_SESSION_ID, TMP_ROOT, { agentName: "engineer" });
    await fixture.sessions.flushSession(ORDINARY_SESSION_ID, TMP_ROOT);

    await expect(fixture.service.assertDeletable({
      workspaceRoot: TMP_ROOT,
      rootSessionId: ORDINARY_SESSION_ID,
      sessionIds: [ORDINARY_SESSION_ID],
    })).resolves.toBeUndefined();
    expect(fixture.cancelSessionToolBatch).not.toHaveBeenCalled();
  });

  test("post-drain preparation cancels each selected Session batch", async () => {
    const fixture = createFixture();
    const childSessionId = "33333333-3333-4333-8333-333333333333";

    await fixture.service.prepareForDeletion({
      workspaceRoot: TMP_ROOT,
      rootSessionId: ORDINARY_SESSION_ID,
      sessionIds: [childSessionId, ORDINARY_SESSION_ID, childSessionId],
    });

    expect(fixture.cancelSessionToolBatch.mock.calls).toEqual([
      [ORDINARY_SESSION_ID, TMP_ROOT, "session_deleted"],
      [childSessionId, TMP_ROOT, "session_deleted"],
    ]);
  });
});

function createFixture() {
  const sessions = new SessionStoreManager({ logger: silentLogger });
  const cancelSessionToolBatch = mock(async (_sessionId: string, _workspaceRoot: string, _reason: string) => undefined);
  const service = new SessionLifecycleService({ storeManager: sessions, cancelSessionToolBatch });
  return { sessions, cancelSessionToolBatch, service };
}
