import type { SessionTreeNode } from "@archcode/protocol";

/** Return target subtree IDs in depth-first order, defaulting to the full tree. */
export function collectSessionTreeIds(
  node: SessionTreeNode,
  targetSessionId = node.session.sessionId,
): string[] {
  if (node.session.sessionId === targetSessionId) return flattenTreeIds(node);
  for (const child of node.children) {
    const found = collectSessionTreeIds(child, targetSessionId);
    if (found.length > 0) return found;
  }
  return [];
}

function flattenTreeIds(node: SessionTreeNode): string[] {
  return [node.session.sessionId, ...node.children.flatMap(flattenTreeIds)];
}
