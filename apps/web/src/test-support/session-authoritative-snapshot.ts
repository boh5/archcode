import { createEmptySessionStats } from "@archcode/protocol";
import type { SessionAuthoritativeSnapshot } from "../store/session-store";

export type SessionAuthoritativeSnapshotFixture =
  & Partial<Omit<SessionAuthoritativeSnapshot, "eventCursor">>
  & Pick<SessionAuthoritativeSnapshot, "eventCursor">;

const fixtureModelBinding = {
  selection: { model: "test:model" },
  providerId: "test",
  modelId: "model",
  providerDisplayName: "Test",
  modelDisplayName: "Test Model",
  resolution: "profile_default" as const,
  modelRuntimeRevision: "m1",
};

export function sessionAuthoritativeSnapshot(
  sessionId: string,
  fixture: SessionAuthoritativeSnapshotFixture,
): SessionAuthoritativeSnapshot {
  return {
    sessionId,
    messages: [],
    pendingMessages: [],
    steps: [],
    todos: [],
    reminders: [],
    childSessionLinks: [],
    title: null,
    createdAt: 1,
    updatedAt: 1,
    cwd: "/workspace",
    rootSessionId: sessionId,
    agentName: "lead",
    profile: "principal",
    activeSkillNames: [],
    stats: createEmptySessionStats(),
    executions: [],
    executionCount: 0,
    isRunning: false,
    isStreamingModel: false,
    currentExecutionId: undefined,
    currentAssistantMessageId: undefined,
    modelSelection: { revision: 0 },
    nextModelSelection: {
      requested: {
        mode: "profile_default",
        selection: fixtureModelBinding.selection,
      },
      resolved: fixtureModelBinding,
    },
    ...fixture,
  };
}
