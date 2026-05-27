export function formatIsoTime(isoTimestamp: string): string {
  return isoTimestamp.replace("T", " ").replace(/Z$/, "");
}