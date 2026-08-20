import { describe, expect, test } from "bun:test";
import type { AgentTreeNode, AgentTreeProjection } from "@archcode/protocol";
import { storeManager } from "../../store/store";
import { createTestProjectContext } from "../test-project-context";
import { expectTextDraft } from "../test-results";
import type { ToolExecutionContext } from "../types";
import { executeListAgents, ListAgentsInputSchema, listAgentsTool } from "./list-agents";

const workspaceRoot = "/workspace/list-agents";

function node(
  sessionId: string,
  depth: number,
  children: AgentTreeNode[] = [],
  parentSessionId?: string,
): AgentTreeNode {
  return {
    session: {
      sessionId,
      cwd: workspaceRoot,
      rootSessionId: "root",
      ...(parentSessionId === undefined ? {} : { parentSessionId }),
      agentName: depth === 0 ? "lead" : "explore",
      profile: depth === 0 ? "principal" : "fast",
      activeSkillNames: [],
      modelSelection: { revision: 0 },
      title: sessionId,
      createdAt: depth,
      updatedAt: depth,
    },
    depth,
    latestExecutionStatus: depth === 0 ? "running" : "completed",
    activeExecutionId: depth === 0 ? "root-exec" : null,
    linkStatus: depth === 0 ? null : "completed",
    children,
  };
}

function projection(): AgentTreeProjection {
  return {
    root: node("root", 0, [
      node("child", 1, [node("grandchild", 2, [], "child")], "root"),
      node("sibling", 1, [], "root"),
    ]),
    diagnostics: [],
  };
}

function context(
  sessionId = "root",
  tree = projection(),
  projectRoot = workspaceRoot,
): ToolExecutionContext {
  const store = storeManager.create(`list-agents-${sessionId}-${crypto.randomUUID()}`, projectRoot, {
    source: { kind: "direct" },
    agentName: "lead",
  });
  store.setState({ sessionId, rootSessionId: "root" });
  return {
    store,
    storeManager,
    toolName: "list_agents",
    toolCallId: "call",
    input: {},
    step: 0,
    executionId: "execution",
    runOrdinal: 0,
    toolBatchId: "batch",
    abort: new AbortController().signal,
    startedAt: 1,
    allowedTools: new Set(["list_agents"]),
    cwd: projectRoot,
    projectContext: createTestProjectContext(projectRoot),
    getAgentTreeProjection: async () => tree,
  };
}

function resultJson(result: Awaited<ReturnType<typeof executeListAgents>>) {
  return JSON.parse(expectTextDraft(result)) as {
    agents: Array<Record<string, unknown>>;
    next_cursor: string | null;
  };
}

describe("list_agents", () => {
  test("has a strict bounded cursor contract and read-only traits", () => {
    expect(ListAgentsInputSchema.safeParse({ page_size: 101 }).success).toBe(false);
    expect(ListAgentsInputSchema.safeParse({ extra: true }).success).toBe(false);
    expect(listAgentsTool.traits).toEqual({ readOnly: true, destructive: false, concurrencySafe: true });
  });

  test("root sees the complete deterministic depth-first tree with strict node fields", async () => {
    const page = resultJson(await executeListAgents({ page_size: 100 }, context()));

    expect(page.agents.map((agent) => agent.session_id)).toEqual(["root", "child", "grandchild", "sibling"]);
    expect(Object.keys(page.agents[0]).sort()).toEqual([
      "active_execution_id",
      "agent_type",
      "depth",
      "latest_execution_status",
      "link_status",
      "parent_session_id",
      "profile",
      "session_id",
      "title",
    ]);
    expect(page.next_cursor).toBeNull();
  });

  test("an intermediate Agent sees only its own subtree", async () => {
    const page = resultJson(await executeListAgents({ page_size: 100 }, context("child")));
    expect(page.agents.map((agent) => agent.session_id)).toEqual(["child", "grandchild"]);
  });

  test("paginates one captured data identity and rejects tampered cursors", async () => {
    const ctx = context();
    const first = resultJson(await executeListAgents({ page_size: 2 }, ctx));
    expect(first.agents.map((agent) => agent.session_id)).toEqual(["root", "child"]);
    expect(first.next_cursor).not.toBeNull();

    const second = resultJson(await executeListAgents({ page_size: 2, cursor: first.next_cursor! }, ctx));
    expect(second.agents.map((agent) => agent.session_id)).toEqual(["grandchild", "sibling"]);

    const tampered = await executeListAgents({ page_size: 2, cursor: `${first.next_cursor!}x` }, ctx);
    expect(tampered.isError).toBe(true);
    expect(expectTextDraft(tampered)).toContain("cursor is invalid");
  });

  test("round-trips a generated cursor when the workspace path contains dots", async () => {
    const ctx = context("root", projection(), "/workspace/.archcode-qa/project.v1");
    const first = resultJson(await executeListAgents({ page_size: 2 }, ctx));
    expect(first.next_cursor).not.toBeNull();

    const second = resultJson(await executeListAgents({ page_size: 2, cursor: first.next_cursor! }, ctx));
    expect(second.agents.map((agent) => agent.session_id)).toEqual(["grandchild", "sibling"]);
  });

  test("rejects a cursor reused by another caller", async () => {
    const first = resultJson(await executeListAgents({ page_size: 1 }, context()));
    const reused = await executeListAgents({ page_size: 1, cursor: first.next_cursor! }, context("child"));
    expect(reused.isError).toBe(true);
  });

  test("rejects a cursor after the projected dataset changes", async () => {
    const first = resultJson(await executeListAgents({ page_size: 1 }, context()));
    const changed = projection();
    changed.root.children[0] = {
      ...changed.root.children[0],
      latestExecutionStatus: "failed",
      linkStatus: "failed",
    };

    const reused = await executeListAgents(
      { page_size: 1, cursor: first.next_cursor! },
      context("root", changed),
    );
    expect(reused.isError).toBe(true);
  });
});
