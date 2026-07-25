import { describe, expect, test } from "bun:test";
import { ConversationRail } from "./ConversationRail";

describe("ConversationRail", () => {
  test("fills the available canvas while owning only safe horizontal gutters", () => {
    const rail = ConversationRail({});
    const className = String(rail.props.className);

    expect(rail.props["data-conversation-rail"]).toBe("");
    expect(className).toContain("box-border");
    expect(className).toContain("w-full");
    expect(className).toContain("px-4");
    expect(className).toContain("sm:px-5");
    expect(className).toContain("xl:px-6");
    expect(className).not.toContain("max-w-[");
  });

  test("keeps consumer classes without introducing another width", () => {
    const rail = ConversationRail({ className: "py-[12px]" });
    expect(rail.props.className).toContain("py-[12px]");
  });
});
