import { describe, expect, test } from "bun:test";
import { DCP_PARITY_ITEMS } from "./constants";
import { DCP_PARITY_CHECKLIST, isDcpParityContractComplete } from "./parity";

describe("compression DCP parity contract", () => {
  test("checklist covers every required DCP parity item", () => {
    expect(DCP_PARITY_CHECKLIST).toHaveLength(DCP_PARITY_ITEMS.length);
    expect(isDcpParityContractComplete()).toBe(true);
  });
});
