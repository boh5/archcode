import { DCP_PARITY_ITEMS } from "./constants";
import type { DcpParityItem } from "./types";

export const DCP_PARITY_CHECKLIST: readonly DcpParityItem[] = DCP_PARITY_ITEMS;

export function isDcpParityContractComplete(entries: readonly DcpParityItem[] = DCP_PARITY_CHECKLIST): boolean {
  const covered = new Set(entries);
  return DCP_PARITY_ITEMS.every((item) => covered.has(item));
}
