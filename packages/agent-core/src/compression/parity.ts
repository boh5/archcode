import { DCP_PARITY_ITEMS } from "./constants";
import type { CompressionDcpParityEntry } from "./types";

export const DCP_PARITY_CHECKLIST: CompressionDcpParityEntry[] = DCP_PARITY_ITEMS.map((item) => ({
  item,
  coveredBy: "packages/agent-core/src/compression contract",
  status: "contract_defined",
}));

export function isDcpParityContractComplete(entries: readonly CompressionDcpParityEntry[] = DCP_PARITY_CHECKLIST): boolean {
  const covered = new Set(entries.map((entry) => entry.item));
  return DCP_PARITY_ITEMS.every((item) => covered.has(item));
}
