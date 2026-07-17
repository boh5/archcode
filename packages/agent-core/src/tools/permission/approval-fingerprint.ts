import { createHash } from "node:crypto";
import { sortJsonValue } from "@archcode/utils";

/** Returns a stable, non-reversible identity for a permission scope. */
export function approvalFingerprint(scope: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(sortJsonValue(scope)))
    .digest("hex");
}
