import type { SessionStoreState } from "../store/types";
import { hasBashMutationWithinRoots } from "../tools/security/bash";

const ARTIFACT_WRITE_TOOLS = new Set(["file_write", "file_edit", "ast_grep_replace"]);

/** Runtime-known artifact freshness only; this intentionally makes no claim about external editors. */
export function hasKnownArtifactWriteAfter(
  state: Pick<SessionStoreState, "cwd" | "messages">,
  after: number,
  workspaceRoot: string,
): boolean {
  for (const message of state.messages) {
    for (const part of message.parts) {
      if (part.type !== "tool" || part.state !== "completed" || part.endedAt < after) continue;
      if (ARTIFACT_WRITE_TOOLS.has(part.toolName) || isKnownWorkspaceMutation(part, state.cwd, workspaceRoot)) {
        return true;
      }
    }
  }
  return false;
}

function isKnownWorkspaceMutation(
  part: Extract<SessionStoreState["messages"][number]["parts"][number], { type: "tool"; state: "completed" }>,
  sessionCwd: string,
  workspaceRoot: string,
): boolean {
  if (part.toolName !== "bash" || typeof part.input !== "object" || part.input === null) return false;
  const input = part.input as { command?: unknown; cwd?: unknown };
  if (typeof input.command !== "string") return false;
  return hasBashMutationWithinRoots(input.command, {
    workspaceRoot: sessionCwd,
    ...(typeof input.cwd === "string" ? { cwd: input.cwd } : {}),
  }, [sessionCwd, workspaceRoot]);
}
