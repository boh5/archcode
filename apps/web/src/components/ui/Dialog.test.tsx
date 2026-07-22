import { describe, expect, test } from "bun:test";
import { DialogContent } from "./Dialog";

describe("DialogContent", () => {
  test("owns its fixed viewport positioning", () => {
    const portal = DialogContent({ children: null, className: "relative" });
    const children = portal.props.children;
    expect(Array.isArray(children)).toBe(true);
    const content = children[1];

    expect(content.props.className).toContain("!fixed");
    expect(content.props.className).toContain("bg-bg-overlay");
    expect(content.props.className).toContain("data-[state=open]:animate-overlay-enter");
    expect(content.props.className).toContain("data-[state=closed]:animate-overlay-exit");
    expect(content.props.className).not.toContain("zoom-");
  });
});
