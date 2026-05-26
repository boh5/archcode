export function scopedKey(workspaceRoot: string, sessionId: string): string {
  return `${workspaceRoot}\0${sessionId}`;
}
