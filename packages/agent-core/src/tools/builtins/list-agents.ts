import type { AgentTreeNode, AgentTreeProjection, ListedAgentNode } from "@archcode/protocol";
import { Buffer } from "node:buffer";
import { z } from "zod";
import { defineTool } from "../define-tool";
import { createToolErrorResult } from "../errors";
import { createTextToolResult } from "../results";
import type { RawToolResult, ToolExecutionContext } from "../types";
import { createWorkspacePermission } from "../permission/workspace";

const MAX_PAGE_SIZE = 100;
const CURSOR_SECRET = crypto.randomUUID();

export const ListAgentsInputSchema = z.strictObject({
  cursor: z.string().min(1).optional()
    .describe("Exact forward cursor copied unchanged from the previous page. Do not construct or modify it."),
  page_size: z.number().int().min(1).max(MAX_PAGE_SIZE).default(MAX_PAGE_SIZE)
    .describe("Maximum nodes to return, from 1 to 100. Default 100."),
});

export type ListAgentsInput = z.infer<typeof ListAgentsInputSchema>;

interface CursorPayload {
  readonly v: 1;
  readonly workspace: string;
  readonly root: string;
  readonly caller: string;
  readonly dataset: string;
  readonly offset: number;
}

class InvalidListAgentsCursorError extends Error {
  constructor() {
    super("list_agents cursor is invalid for the current workspace, Root, caller, or Agent Tree snapshot");
    this.name = "InvalidListAgentsCursorError";
  }
}

export async function executeListAgents(
  input: ListAgentsInput,
  ctx: ToolExecutionContext,
): Promise<RawToolResult> {
  if (ctx.getAgentTreeProjection === undefined) {
    return createToolErrorResult({
      kind: "execution",
      code: "TOOL_LIST_AGENTS_UNAVAILABLE",
      message: "list_agents is not available in this execution context",
    });
  }

  const state = ctx.store.getState();
  const callerSessionId = state.sessionId;
  const rootSessionId = state.rootSessionId;
  const workspaceRoot = ctx.projectContext.project.workspaceRoot;

  let projection: AgentTreeProjection;
  try {
    projection = await ctx.getAgentTreeProjection(workspaceRoot, rootSessionId);
  } catch (error) {
    const safeError = error instanceof Error ? error : new Error(String(error));
    return createToolErrorResult({
      kind: "execution",
      code: "TOOL_LIST_AGENTS_SNAPSHOT_FAILED",
      name: safeError.name,
      message: safeError.message,
      error: safeError,
    });
  }

  const caller = findNode(projection.root, callerSessionId);
  if (caller === undefined) {
    return createToolErrorResult({
      kind: "execution",
      code: "TOOL_LIST_AGENTS_CALLER_NOT_IN_TREE",
      message: `Calling Session "${callerSessionId}" is not in root "${rootSessionId}"`,
    });
  }

  const agents = flattenListedAgents(caller);
  const dataset = datasetIdentity(agents);
  let offset = 0;
  try {
    if (input.cursor !== undefined) {
      const cursor = decodeCursor(input.cursor);
      if (
        cursor.workspace !== workspaceRoot
        || cursor.root !== rootSessionId
        || cursor.caller !== callerSessionId
        || cursor.dataset !== dataset
        || cursor.offset > agents.length
      ) {
        throw new InvalidListAgentsCursorError();
      }
      offset = cursor.offset;
    }
  } catch (error) {
    const safeError = error instanceof Error ? error : new InvalidListAgentsCursorError();
    return createToolErrorResult({
      kind: "execution",
      code: "TOOL_LIST_AGENTS_INVALID_CURSOR",
      name: safeError.name,
      message: safeError.message,
      error: safeError,
    });
  }

  const page = agents.slice(offset, offset + input.page_size);
  const nextOffset = offset + page.length;
  const nextCursor = nextOffset < agents.length
    ? encodeCursor({
        v: 1,
        workspace: workspaceRoot,
        root: rootSessionId,
        caller: callerSessionId,
        dataset,
        offset: nextOffset,
      })
    : null;

  return createTextToolResult(JSON.stringify({ agents: page, next_cursor: nextCursor }));
}

export function flattenListedAgents(root: AgentTreeNode): ListedAgentNode[] {
  return [
    {
      session_id: root.session.sessionId,
      parent_session_id: root.session.parentSessionId ?? null,
      agent_type: root.session.agentName,
      profile: root.session.profile,
      title: root.session.title,
      depth: root.depth,
      latest_execution_status: root.latestExecutionStatus,
      active_execution_id: root.activeExecutionId,
      link_status: root.linkStatus,
    },
    ...root.children.flatMap(flattenListedAgents),
  ];
}

function findNode(root: AgentTreeNode, sessionId: string): AgentTreeNode | undefined {
  if (root.session.sessionId === sessionId) return root;
  for (const child of root.children) {
    const found = findNode(child, sessionId);
    if (found !== undefined) return found;
  }
  return undefined;
}

function datasetIdentity(agents: readonly ListedAgentNode[]): string {
  return digest(`agent-tree-dataset:v1:${JSON.stringify(agents)}`);
}

function encodeCursor(payload: CursorPayload): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = digest(`agent-tree-cursor:v1:${CURSOR_SECRET}:${encoded}`);
  return `v1.${encoded}.${signature}`;
}

function decodeCursor(value: string): CursorPayload {
  const match = /^v1\.([A-Za-z0-9_-]+)\.([a-f0-9]+)$/.exec(value);
  if (match === null) throw new InvalidListAgentsCursorError();
  const [, encoded, signature] = match;
  if (digest(`agent-tree-cursor:v1:${CURSOR_SECRET}:${encoded}`) !== signature) {
    throw new InvalidListAgentsCursorError();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new InvalidListAgentsCursorError();
  }
  const result = z.strictObject({
    v: z.literal(1),
    workspace: z.string(),
    root: z.string(),
    caller: z.string(),
    dataset: z.string(),
    offset: z.number().int().nonnegative(),
  }).safeParse(parsed);
  if (!result.success) throw new InvalidListAgentsCursorError();
  return result.data;
}

function digest(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

export const listAgentsTool = defineTool({
  name: "list_agents",
  description:
    "List the calling Agent Session and its complete descendant subtree using the canonical Agent Tree snapshot. Returns compact execution and parent-link facts only; it never returns transcripts, reasoning, prompts, tool payloads, or attachments.",
  inputSchema: ListAgentsInputSchema,
  traits: { readOnly: true, destructive: false, concurrencySafe: true },
  outputPolicy: { kind: "inline", previewDirection: "head" },
  permissions: [createWorkspacePermission()],
  execute: executeListAgents,
});
