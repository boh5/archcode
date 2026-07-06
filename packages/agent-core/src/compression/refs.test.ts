import { describe, expect, test } from "bun:test";
import { buildMessageRefMap, createEmptyCompressionRefMap, ensureBlockRef, ensureMessageRef } from "./refs";

describe("compression refs", () => {
  test("refs are stable m0001 and b1 without mutating canonical ids", () => {
    const originalMessageId = "msg-a";
    const originalBlockId = "block-a";
    let refMap = createEmptyCompressionRefMap();

    const firstMessage = ensureMessageRef(refMap, originalMessageId);
    refMap = firstMessage.refMap;
    const repeatedMessage = ensureMessageRef(refMap, originalMessageId);
    refMap = repeatedMessage.refMap;
    const firstBlock = ensureBlockRef(refMap, originalBlockId);
    refMap = firstBlock.refMap;
    const repeatedBlock = ensureBlockRef(refMap, originalBlockId);

    expect(firstMessage.ref).toBe("m0001");
    expect(repeatedMessage.ref).toBe("m0001");
    expect(firstBlock.ref).toBe("b1");
    expect(repeatedBlock.ref).toBe("b1");
    expect(originalMessageId).toBe("msg-a");
    expect(refMap.messageRefsById[originalMessageId]).toBe("m0001");
  });

  test("refs stay stable across repeated projections when new messages are appended", () => {
    const firstProjection = buildMessageRefMap(["msg-a", "msg-b"]);
    const secondProjection = buildMessageRefMap(["msg-a", "msg-b", "msg-c"], firstProjection);

    expect(secondProjection.messageRefsById["msg-a"]).toBe("m0001");
    expect(secondProjection.messageRefsById["msg-b"]).toBe("m0002");
    expect(secondProjection.messageRefsById["msg-c"]).toBe("m0003");
  });
});
