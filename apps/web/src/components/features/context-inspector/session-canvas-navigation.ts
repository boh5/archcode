export function buildAgentFocusSearch(
  current: URLSearchParams,
  rootSessionId: string,
  focusedSessionId: string,
): string {
  const next = new URLSearchParams(current);
  next.delete("view");
  next.delete("file");
  if (focusedSessionId === rootSessionId) next.delete("focus");
  else next.set("focus", focusedSessionId);
  return next.toString();
}

export function buildDiffSearch(current: URLSearchParams, path?: string): string {
  const next = new URLSearchParams(current);
  next.delete("focus");
  next.set("view", "diff");
  if (path) next.set("file", path);
  else next.delete("file");
  return next.toString();
}
