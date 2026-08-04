import { describe, expect, test } from "bun:test";
import { TerminalGrant } from "./terminal-grant";

describe("TerminalGrant", () => {
  test("authorizes only the random token embedded in the setup fragment", () => {
    const grant = new TerminalGrant();
    const url = grant.url("http://localhost:4096", "/setup");
    const token = new URL(url).hash.slice("#token=".length);

    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(grant.authorize(`Bearer ${token}`)).toBe(true);
    expect(grant.authorize("Bearer wrong")).toBe(false);
    expect(grant.authorize(`Basic ${token}`)).toBe(false);
  });

  test("cannot be reused after setup commits", () => {
    const grant = new TerminalGrant();
    const token = new URL(grant.url("http://localhost:4096", "/config-recovery")).hash.slice("#token=".length);

    grant.consume();

    expect(grant.authorize(`Bearer ${token}`)).toBe(false);
  });
});
