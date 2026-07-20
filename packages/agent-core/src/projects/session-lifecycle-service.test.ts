import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { SessionDeleteOwnerConflictError } from "../execution/session-deletion";
import { silentLogger } from "../logger";
import { SessionStoreManager } from "../store/session-store-manager";
import { SessionLifecycleService, type SessionLifecycleServiceOptions } from "./session-lifecycle-service";

const TMP_ROOT = join(import.meta.dir, "__test_tmp__", "session-lifecycle-service", crypto.randomUUID());
const ORDINARY_SESSION_ID = "11111111-1111-4111-8111-111111111111";
const TODO_OWNER_ID = "66666666-6666-4666-8666-666666666666";

beforeEach(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
  await mkdir(TMP_ROOT, { recursive: true });
});

afterAll(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
});

describe("SessionLifecycleService", () => {
  test("preflight rejects ProjectTodo ownership without Session metadata", async () => {
    const fixture = createFixture({
      findProjectTodoOwners: mock(async () => [{
        sessionId: ORDINARY_SESSION_ID,
        ownerType: "project_todo" as const,
        ownerId: TODO_OWNER_ID,
      }]),
    });
    fixture.sessions.create(ORDINARY_SESSION_ID, TMP_ROOT, { agentName: "engineer" });
    await fixture.sessions.flushSession(ORDINARY_SESSION_ID, TMP_ROOT);

    await expect(fixture.service.assertDeletable({
      workspaceRoot: TMP_ROOT,
      rootSessionId: ORDINARY_SESSION_ID,
      sessionIds: [ORDINARY_SESSION_ID],
    })).rejects.toMatchObject({
      name: "SessionDeleteOwnerConflictError",
      code: "SESSION_DELETE_OWNER_CONFLICT",
      sessionIds: [ORDINARY_SESSION_ID],
      owners: [{ sessionId: ORDINARY_SESSION_ID, ownerType: "project_todo", ownerId: TODO_OWNER_ID }],
    } satisfies Partial<SessionDeleteOwnerConflictError>);
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
    expect(fixture.findProjectTodoOwners).toHaveBeenCalledWith({
      workspaceRoot: TMP_ROOT,
      rootSessionId: ORDINARY_SESSION_ID,
      sessionIds: [ORDINARY_SESSION_ID],
    });
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
    expect(fixture.deleteToolOutputs).toHaveBeenCalledTimes(1);
    expect(fixture.deleteToolOutputs.mock.calls[0]?.[0]).toEqual({
      workspaceRoot: TMP_ROOT,
      rootSessionId: ORDINARY_SESSION_ID,
      sessionIds: [childSessionId, ORDINARY_SESSION_ID, childSessionId],
    });
  });
});

function createFixture(overrides: Partial<SessionLifecycleServiceOptions> = {}) {
  const sessions = new SessionStoreManager({ logger: silentLogger });
  const cancelSessionToolBatch = mock(async (_sessionId: string, _workspaceRoot: string, _reason: string) => undefined);
  const deleteToolOutputs = mock(overrides.deleteToolOutputs ?? (async () => undefined));
  const findProjectTodoOwners = overrides.findProjectTodoOwners ?? mock(async () => []);
  const service = new SessionLifecycleService({
    storeManager: sessions,
    cancelSessionToolBatch,
    deleteToolOutputs,
    findProjectTodoOwners,
  });
  return { sessions, cancelSessionToolBatch, deleteToolOutputs, findProjectTodoOwners, service };
}
