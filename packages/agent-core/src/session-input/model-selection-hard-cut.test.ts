import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  ExecutionModelBindingSummary,
  MessageModelAudit,
  RequestedModelSelection,
} from "@archcode/protocol";
import { silentLogger } from "../logger";
import { SessionStoreManager } from "../store/session-store-manager";
import { getSessionPath } from "../store/sessions-dir";
import {
  SessionModelSelectionConflictError,
  SessionModelSelectionService,
} from "./model-selection-service";
import { SessionInputService } from "./service";

const WORKSPACE = join(import.meta.dir, "__test_tmp__", crypto.randomUUID());
const SESSION_ID = "00000000-0000-4000-8000-000000000101";
const CHILD_SESSION_ID = "00000000-0000-4000-8000-000000000102";
const requested: RequestedModelSelection = {
  mode: "profile_default",
  selection: { model: "test:model" },
};
const overrideRequested: RequestedModelSelection = {
  mode: "session_override",
  selection: { model: "test:other", variant: "deep" },
};
const binding: ExecutionModelBindingSummary = {
  selection: { model: "test:model" },
  providerId: "test",
  modelId: "model",
  providerDisplayName: "Test",
  modelDisplayName: "Model",
  resolution: "profile_default",
  modelRuntimeRevision: "runtime-1",
};
const audit: MessageModelAudit = { requested, actual: binding.selection };

describe("strict Session model selection protocol", () => {
  let manager: SessionStoreManager;
  let input: SessionInputService;
  let selections: SessionModelSelectionService;

  beforeEach(async () => {
    await mkdir(WORKSPACE, { recursive: true });
    manager = new SessionStoreManager({ logger: silentLogger });
    input = new SessionInputService(manager);
    selections = new SessionModelSelectionService(manager);
    await manager.createSessionFile(WORKSPACE, { agentName: "lead" }, SESSION_ID);
  });

  afterEach(async () => {
    await rm(WORKSPACE, { recursive: true, force: true });
  });

  test("uses revision CAS and Profile default deletes the override", async () => {
    expect(await selections.get(SESSION_ID, WORKSPACE)).toEqual({ revision: 0 });
    expect(await selections.patch({
      sessionId: SESSION_ID,
      workspaceRoot: WORKSPACE,
      expectedRevision: 0,
      requestedModelSelection: overrideRequested,
    })).toEqual({ revision: 1, override: overrideRequested.selection });

    await expect(selections.patch({
      sessionId: SESSION_ID,
      workspaceRoot: WORKSPACE,
      expectedRevision: 0,
      requestedModelSelection: requested,
    })).rejects.toBeInstanceOf(SessionModelSelectionConflictError);

    expect(await selections.patch({
      sessionId: SESSION_ID,
      workspaceRoot: WORKSPACE,
      expectedRevision: 1,
      requestedModelSelection: requested,
    })).toEqual({ revision: 2 });
  });

  test("persists the Session override across a fresh store manager", async () => {
    await selections.patch({
      sessionId: SESSION_ID,
      workspaceRoot: WORKSPACE,
      expectedRevision: 0,
      requestedModelSelection: overrideRequested,
    });

    const restarted = new SessionStoreManager({ logger: silentLogger });
    expect((await restarted.getSessionFile(WORKSPACE, SESSION_ID)).modelSelection).toEqual({
      revision: 1,
      override: overrideRequested.selection,
    });
  });

  test("allows only a root Lead to set or clear a durable override", async () => {
    await manager.createSessionFile(WORKSPACE, {
      agentName: "explore",
      rootSessionId: SESSION_ID,
      parentSessionId: SESSION_ID,
      title: "Inspect model selection",
      activeSkillNames: [],
      delegationRequest: {
        agent_type: "explore",
        profile: "fast",
        title: "Inspect model selection",
        objective: "Inspect the relevant model selection code.",
        skills: [],
        background: false,
      },
    }, CHILD_SESSION_ID);

    for (const requestedModelSelection of [overrideRequested, requested]) {
      await expect(selections.patch({
        sessionId: CHILD_SESSION_ID,
        workspaceRoot: WORKSPACE,
        expectedRevision: 0,
        requestedModelSelection,
      })).rejects.toMatchObject({
        name: "SessionModelSelectionNotAllowedError",
        reason: "not_root_lead",
      });
    }
    expect(await selections.get(CHILD_SESSION_ID, WORKSPACE)).toEqual({ revision: 0 });

    expect(await selections.patch({
      sessionId: SESSION_ID,
      workspaceRoot: WORKSPACE,
      expectedRevision: 0,
      requestedModelSelection: overrideRequested,
    })).toEqual({ revision: 1, override: overrideRequested.selection });
    expect(await selections.patch({
      sessionId: SESSION_ID,
      workspaceRoot: WORKSPACE,
      expectedRevision: 1,
      requestedModelSelection: requested,
    })).toEqual({ revision: 2 });
  });

  test("cold load rejects mutable model selection state on a child Session", async () => {
    await manager.createSessionFile(WORKSPACE, {
      agentName: "explore",
      rootSessionId: SESSION_ID,
      parentSessionId: SESSION_ID,
      title: "Cold child",
      activeSkillNames: [],
      delegationRequest: {
        agent_type: "explore",
        profile: "fast",
        title: "Cold child",
        objective: "Inspect the persisted child identity.",
        skills: [],
        background: false,
      },
    }, CHILD_SESSION_ID);
    const path = getSessionPath(WORKSPACE, CHILD_SESSION_ID);
    const corrupted = JSON.parse(await Bun.file(path).text()) as Record<string, unknown>;
    corrupted.modelSelection = { revision: 1, override: overrideRequested.selection };
    await Bun.write(path, JSON.stringify(corrupted));

    const restarted = new SessionStoreManager({ logger: silentLogger });
    await expect(restarted.getSessionFile(WORKSPACE, CHILD_SESSION_ID)).rejects.toThrow(
      "Child modelSelection must remain initial",
    );
  });

  test("fingerprints the requested selection and commits only an exact contiguous prefix", async () => {
    const accepted = [];
    for (const [clientRequestId, text] of [["request-a", "A"], ["request-b", "B"], ["request-c", "C"]] as const) {
      accepted.push(await input.acceptMessage({
        sessionId: SESSION_ID,
        workspaceRoot: WORKSPACE,
        text,
        clientRequestId,
        source: "user",
        requestedModelSelection: requested,
      }));
    }
    await expect(input.acceptMessage({
      sessionId: SESSION_ID,
      workspaceRoot: WORKSPACE,
      text: "A",
      clientRequestId: "request-a",
      source: "user",
      requestedModelSelection: overrideRequested,
    })).rejects.toMatchObject({ reason: "idempotency" });

    const snapshots = accepted.slice(0, 2).map((acceptance) => ({
      pending: acceptance.message!,
      modelAudit: audit,
    }));
    const result = await input.beginQueueExecution({
      sessionId: SESSION_ID,
      workspaceRoot: WORKSPACE,
      executionId: "execution-1",
      snapshots,
      binding,
      origin: "user_message",
    });

    expect(result.messages.map((message) => message.modelAudit)).toEqual([audit, audit]);
    const file = await manager.getSessionFile(WORKSPACE, SESSION_ID);
    expect(file.pendingMessages.map((message) => message.content)).toEqual(["C"]);
    expect(file.executions[0]).toMatchObject({ id: "execution-1", binding });
  });

  test("rejects a stale resolved snapshot without partially starting an execution", async () => {
    const accepted = await input.acceptMessage({
      sessionId: SESSION_ID,
      workspaceRoot: WORKSPACE,
      text: "A",
      clientRequestId: "request-a",
      source: "user",
      requestedModelSelection: requested,
    });
    await input.editMessage({
      sessionId: SESSION_ID,
      workspaceRoot: WORKSPACE,
      messageId: accepted.messageId,
      expectedRevision: 0,
      text: "edited",
    });
    await expect(input.beginQueueExecution({
      sessionId: SESSION_ID,
      workspaceRoot: WORKSPACE,
      executionId: "execution-stale",
      snapshots: [{ pending: accepted.message!, modelAudit: audit }],
      binding,
      origin: "user_message",
    })).rejects.toMatchObject({ reason: "revision" });
    expect((await manager.getSessionFile(WORKSPACE, SESSION_ID)).executions).toEqual([]);
  });

  test("persists command selection and requires it for message continuation", async () => {
    const command = {
      sessionId: SESSION_ID,
      workspaceRoot: WORKSPACE,
      text: "/skill use test",
      clientRequestId: "command-selection",
      source: "user" as const,
      requestedModelSelection: requested,
    };
    expect(await input.claimCommand(command)).toEqual({ kind: "claimed" });
    expect((await manager.getSessionFile(WORKSPACE, SESSION_ID)).inputRequestReceipts[0])
      .toMatchObject({ requestedModelSelection: requested });
    await expect(input.completeCommandAsMessage({
      ...command,
      text: "continue with Skill",
      requestedModelSelection: overrideRequested,
    })).rejects.toMatchObject({ reason: "idempotency" });
    const acceptance = await input.completeCommandAsMessage({
      ...command,
      text: "continue with Skill",
    });
    expect(acceptance.message?.requestedModelSelection).toEqual(requested);
  });

  test("strictly rejects a legacy modelInfo Session file", async () => {
    const path = getSessionPath(WORKSPACE, SESSION_ID);
    const legacy = JSON.parse(await Bun.file(path).text()) as Record<string, unknown>;
    delete legacy.modelSelection;
    legacy.modelInfo = null;
    await Bun.write(path, JSON.stringify(legacy));
    manager.delete(SESSION_ID, WORKSPACE);
    await expect(manager.getSessionFile(WORKSPACE, SESSION_ID)).rejects.toThrow();
  });
});
