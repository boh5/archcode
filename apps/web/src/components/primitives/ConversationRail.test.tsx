import { describe, expect, test } from "bun:test";
import { ConversationRail, SessionThreadColumn } from "./ConversationRail";

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

describe("SessionThreadColumn", () => {
  test("owns the shared visible width for transcript and Composer surfaces", () => {
    const column = SessionThreadColumn({});
    const className = String(column.props.className);

    expect(column.props["data-session-thread-column"]).toBe("");
    expect(className).toContain("mx-auto");
    expect(className).toContain("w-full");
    expect(className).toContain("max-w-[800px]");
    expect(className).toContain("min-w-0");
  });

  test("keeps consumer layout classes", () => {
    const column = SessionThreadColumn({ className: "flex flex-col" });
    expect(column.props.className).toContain("flex flex-col");
  });
});
