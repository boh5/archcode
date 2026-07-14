import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import { GoalStateManager } from "../goals/state";
import { silentLogger } from "../logger";
import { SessionStoreManager } from "../store/session-store-manager";
import { HitlService } from "./service";

const TMP_ROOT = join(import.meta.dir, "__test_tmp__", "aggregation", crypto.randomUUID());

describe("HITL aggregation", () => {
  beforeEach(async () => {
    await rm(TMP_ROOT, { recursive: true, force: true });
    await mkdir(TMP_ROOT, { recursive: true });
  });

  afterAll(async () => {
    await rm(TMP_ROOT, { recursive: true, force: true });
  });

  test("session tree read failures abort project aggregation", async () => {
    const workspaceRoot = await mkdtemp(join(TMP_ROOT, "workspace-"));
    const sessions = new SessionStoreManager({ logger: silentLogger });
    const sessionId = crypto.randomUUID();
    sessions.create(sessionId, workspaceRoot, { agentName: "engineer" });
    await sessions.flushSession(sessionId, workspaceRoot);
    sessions.buildSessionTree = mock(async () => { throw new Error("corrupt session tree"); });
    const service = new HitlService({
      workspaceRoot,
      project: { slug: "archcode", name: "ArchCode" },
      sessions,
      goalState: new GoalStateManager(workspaceRoot, silentLogger),
    });

    await expect(service.list({ scope: "project" })).rejects.toThrow("corrupt session tree");
  });
});
