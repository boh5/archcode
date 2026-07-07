import type { ToolTraits } from "../tools/types";

export const COMPRESS_TOOL_TRAITS: ToolTraits = {
  readOnly: false,
  destructive: false,
  concurrencySafe: false,
};

export function assertCompressToolTraits(traits: ToolTraits): void {
  if (traits.readOnly !== false || traits.destructive !== false || traits.concurrencySafe !== false) {
    throw new Error("compress tool traits must be readOnly=false, destructive=false, concurrencySafe=false");
  }
}
