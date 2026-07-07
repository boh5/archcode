import type { SystemCompressionInput, SystemCompressionResult } from "./hard-limit";
import { prepareSystemCompression } from "./hard-limit";
import { EMERGENCY_COMPACT_RATIO } from "./constants";

export async function prepareEmergencyCompression(input: SystemCompressionInput): Promise<SystemCompressionResult> {
  return prepareSystemCompression({
    ...input,
    strategy: "emergency-hard-limit",
    trigger: "emergency_threshold",
    summaryBudget: "tight",
  });
}

export { EMERGENCY_COMPACT_RATIO };
