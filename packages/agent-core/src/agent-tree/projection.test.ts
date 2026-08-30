import { describe, expect, test } from "bun:test";
import type {
  SessionExecutionRecord,
  SessionSummary,
  SessionTreeNode,
  ToolChildSessionLink,
} from "@archcode/protocol";
import {
  AgentTreeProjectionError,
  projectAgentTree,
  type AgentTreeDurableSnapshot,
} from "./projection";
import {
  testExecutionLoadedToolRefs,
  testExecutionToolAuthorizationSnapshot,
} from "../testing/test-execution-fixtures";

const memoryPolicy = {
  policy: { useMemory: true, autoLearning: true },
  epoch: { bootId: "boot", generation: 1 },
};

function summary(
  sessionId: string,
  parentSessionId?: string,
  createdAt = 1,
): SessionSummary {
  return {
    sessionId,
    cwd: "/workspace",
    rootSessionId: "root",
    ...(parentSessionId === undefined ? {} : { parentSessionId }),
    agentName: parentSessionId === undefined ? "lead" : "explore",
    profile: parentSessionId === undefined ? "principal" : "fast",
    activeSkillNames: [],
    modelSelection: { revision: 0 },
    title: sessionId,
    createdAt,
    updatedAt: createdAt,
  };
}

function execution(id: string, status: SessionExecutionRecord["status"]): SessionExecutionRecord {
  const base = {
    id,
    startedAt: 1,
    origin: "user_message" as const,
    maxSteps: 50,
    durationMs: 0,
    runs: [],
    executionSkills: [],
    memoryPolicy,
    toolAuthorizationSnapshot: testExecutionToolAuthorizationSnapshot,
    loadedToolRefs: testExecutionLoadedToolRefs,
  };
  if (status === "running") return { ...base, status };
  if (status === "suspended") {
    return {
      ...base,
      status,
      suspension: { kind: "hitl", toolBatchId: "batch", blockerIds: ["hitl-1"] },
    };
  }
  return {
    ...base,
    status,
    endedAt: 2,
    terminalSettlement: { key: `terminal:${id}`, goalInstanceId: null },
  };
}

function link(
  childExecutionId: string,
  status: ToolChildSessionLink["status"],
  parentToolCallId = "call-1",
): ToolChildSessionLink {
  return {
    parentSessionId: "root",
    parentToolCallId,
    toolName: "delegate",
    childSessionId: "child",
    childExecutionId,
    childAgentName: "explore",
    childProfile: "fast",
    childSkillNames: [],
    title: "child",
    depth: 1,
    background: true,
    status,
    createdAt: 1,
  };
}

function snapshot(input?: {
  childExecutions?: SessionExecutionRecord[];
  links?: ToolChildSessionLink[];
}): AgentTreeDurableSnapshot {
  const root: SessionTreeNode = {
    session: summary("root"),
    children: [{ session: summary("child", "root", 2), children: [] }],
  };
  return {
    rootSessionId: "root",
    revision: "revision-1",
    tree: { root, diagnostics: [] },
    files: new Map([
      ["root", { executions: [execution("root-exec", "completed")], childSessionLinks: input?.links ?? [link("child-exec", "running")] }],
      ["child", { executions: input?.childExecutions ?? [execution("child-exec", "running")], childSessionLinks: [] }],
    ]),
  };
}

describe("projectAgentTree", () => {
  test("projects deterministic topology with canonical durable and active facts", () => {
    const projected = projectAgentTree(snapshot(), new Map([["child", "child-exec"]]));

    expect(projected.root.depth).toBe(0);
    expect(projected.root.latestExecutionStatus).toBe("completed");
    expect(projected.root.activeExecutionId).toBeNull();
    expect(projected.root.linkStatus).toBeNull();
    expect(projected.root.children[0]).toMatchObject({
      depth: 1,
      latestExecutionStatus: "running",
      activeExecutionId: "child-exec",
      linkStatus: "running",
    });
  });

  test("uses only links for the latest child Execution", () => {
    const projected = projectAgentTree(snapshot({
      childExecutions: [execution("old-exec", "completed"), execution("child-exec", "completed")],
      links: [link("old-exec", "failed", "old-call"), link("child-exec", "completed")],
    }), new Map());

    expect(projected.root.children[0].linkStatus).toBe("completed");
  });

  test("rejects inconsistent statuses across links for the same latest Execution", () => {
    expect(() => projectAgentTree(snapshot({
      childExecutions: [execution("child-exec", "completed")],
      links: [link("child-exec", "completed", "call-1"), link("child-exec", "failed", "call-2")],
    }), new Map())).toThrow(AgentTreeProjectionError);
    try {
      projectAgentTree(snapshot({
        childExecutions: [execution("child-exec", "completed")],
        links: [link("child-exec", "completed", "call-1"), link("child-exec", "failed", "call-2")],
      }), new Map());
    } catch (error) {
      expect(error).toMatchObject({ name: "AgentTreeProjectionError", reason: "link_status_conflict" });
    }
  });

  test("rejects durable running state without the matching active identity", () => {
    expect(() => projectAgentTree(snapshot(), new Map())).toThrow(AgentTreeProjectionError);
  });

  test("rejects an active identity that does not match latest durable Execution", () => {
    expect(() => projectAgentTree(snapshot(), new Map([["child", "other-exec"]]))).toThrow(AgentTreeProjectionError);
  });

  test("projects suspended durable state without a live active identity", () => {
    const projected = projectAgentTree(snapshot({
      childExecutions: [execution("child-exec", "suspended")],
      links: [link("child-exec", "waiting_for_human")],
    }), new Map());

    expect(projected.root.children[0]).toMatchObject({
      latestExecutionStatus: "suspended",
      activeExecutionId: null,
      linkStatus: "waiting_for_human",
    });
  });

  test("rejects a live active identity for suspended durable state", () => {
    expect(() => projectAgentTree(snapshot({
      childExecutions: [execution("child-exec", "suspended")],
      links: [link("child-exec", "waiting_for_human")],
    }), new Map([["child", "child-exec"]]))).toThrow(AgentTreeProjectionError);
  });

  test("rejects active identities outside the captured family", () => {
    expect(() => projectAgentTree(snapshot({
      childExecutions: [execution("child-exec", "completed")],
      links: [link("child-exec", "completed")],
    }), new Map([["other", "other-exec"]]))).toThrow(AgentTreeProjectionError);
  });

  for (const status of ["running", "suspended"] as const) {
    test(`rejects a non-latest durable ${status} Execution`, () => {
      try {
        projectAgentTree(snapshot({
          childExecutions: [execution("stale-exec", status), execution("child-exec", "completed")],
          links: [link("child-exec", "completed")],
        }), new Map());
        throw new Error("Expected Agent Tree projection to reject invalid durable ordering");
      } catch (error) {
        expect(error).toMatchObject({
          name: "AgentTreeProjectionError",
          reason: "nonterminal_execution_not_latest",
        });
      }
    });
  }
});
