import { describe, expect, test } from "bun:test";
import { ConversationRail } from "./ConversationRail";

describe("ConversationRail", () => {
  test("owns the 800px border-box rail that leaves a 760px desktop reading measure", () => {
    const rail = ConversationRail({});
    const className = String(rail.props.className);

    expect(rail.props["data-conversation-rail"]).toBe("");
    expect(className).toContain("box-border");
    expect(className).toContain("max-w-[800px]");
    expect(className).toContain("px-4");
    expect(className).toContain("sm:px-5");
    expect(className).not.toContain("max-w-[880px]");
  });

  test("keeps consumer classes without introducing another width", () => {
    const rail = ConversationRail({ className: "py-[12px]" });
    expect(rail.props.className).toContain("py-[12px]");
  });
});
