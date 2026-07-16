import { describe, expect, test } from "bun:test";
import { ConversationRail } from "./ConversationRail";

describe("ConversationRail", () => {
  test("owns the single 880px border-box rail and explicit responsive gutters", () => {
    const rail = ConversationRail({});
    const className = String(rail.props.className);

    expect(rail.props["data-conversation-rail"]).toBe("");
    expect(className).toContain("box-border");
    expect(className).toContain("max-w-[880px]");
    expect(className).toContain("px-[16px]");
    expect(className).toContain("sm:px-[20px]");
  });

  test("keeps consumer classes without introducing another width", () => {
    const rail = ConversationRail({ className: "py-[12px]" });
    expect(rail.props.className).toContain("py-[12px]");
  });
});
