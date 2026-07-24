import { describe, expect, test } from "bun:test";
import { SetupGrant } from "./setup-grant";

describe("SetupGrant", () => {
  test("authorizes only the random token embedded in the setup fragment", () => {
    const grant = new SetupGrant();
    const url = grant.setupUrl("http://localhost:4096");
    const token = new URL(url).hash.slice("#token=".length);

    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(grant.authorize(`Bearer ${token}`)).toBe(true);
    expect(grant.authorize("Bearer wrong")).toBe(false);
    expect(grant.authorize(`Basic ${token}`)).toBe(false);
  });

  test("cannot be reused after setup commits", () => {
    const grant = new SetupGrant();
    const token = new URL(grant.setupUrl("http://localhost:4096")).hash.slice("#token=".length);

    grant.consume();

    expect(grant.authorize(`Bearer ${token}`)).toBe(false);
  });
});
