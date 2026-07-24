import { describe, expect, test } from "bun:test";
import { assertRetiredServerPasswordEnvAbsent } from "./legacy-auth-env";

describe("legacy server password environment guard", () => {
  test("fails closed when the retired ARCHCODE_SERVER_PASSWORD is still set", () => {
    expect(() => assertRetiredServerPasswordEnvAbsent({
      ARCHCODE_SERVER_PASSWORD: "legacy-secret",
    })).toThrow("ARCHCODE_SERVER_PASSWORD has been removed");
  });

  test("allows startup when the retired variable is absent", () => {
    expect(() => assertRetiredServerPasswordEnvAbsent({})).not.toThrow();
  });
});
