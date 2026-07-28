import { describe, expect, mock, test } from "bun:test";
import type { AttachmentDescriptor } from "@archcode/protocol";
import type { ModelMessage } from "ai";
import {
  renderAttachmentMarker,
  type AttachmentMarkerPart,
  type AttachmentProjectionSlot,
} from "../store/projection";
import { getAttachmentContentPath } from "./paths";
import {
  SessionAttachmentModelProjector,
  type AttachmentContentReader,
} from "./model-projector";

const WORKSPACE_ROOT = "/tmp/archcode-attachment-projector";
const ROOT_SESSION_ID = "root-session";

function descriptor(
  overrides: Partial<AttachmentDescriptor> = {},
): AttachmentDescriptor {
  return {
    id: crypto.randomUUID(),
    name: "diagram.png",
    mediaType: "image/png",
    sizeBytes: 4,
    kind: "image",
    ...overrides,
  };
}

function projectionFixture(
  attachment: AttachmentDescriptor,
): {
  messages: ModelMessage[];
  markerPart: AttachmentMarkerPart;
  slots: AttachmentProjectionSlot[];
} {
  const markerPart: AttachmentMarkerPart = {
    type: "text",
    text: renderAttachmentMarker(attachment),
  };
  return {
    messages: [{ role: "user", content: [markerPart] }],
    markerPart,
    slots: [{ markerPart, descriptor: attachment }],
  };
}

function readerFor(
  attachment: AttachmentDescriptor,
  bytes = Uint8Array.of(0x89, 0x50, 0x4e, 0x47),
): AttachmentContentReader & {
  resolveReadPath: ReturnType<typeof mock>;
  readVerified: ReturnType<typeof mock>;
} {
  return {
    resolveReadPath: mock(async (input: { attachmentId: string }) => getAttachmentContentPath(
      WORKSPACE_ROOT,
      ROOT_SESSION_ID,
      input.attachmentId,
    )),
    readVerified: mock(async () => ({
      descriptor: attachment,
      contentPath: getAttachmentContentPath(
        WORKSPACE_ROOT,
        ROOT_SESSION_ID,
        attachment.id,
      ),
      bytes,
    })),
  };
}

describe("SessionAttachmentModelProjector", () => {
  test("adds the exact path and original bytes for an image-capable binding", async () => {
    const attachment = descriptor();
    const fixture = projectionFixture(attachment);
    const bytes = Uint8Array.of(0x89, 0x50, 0x4e, 0x47);
    const reader = readerFor(attachment, bytes);
    const projector = new SessionAttachmentModelProjector(reader);

    await projector.project({
      messages: fixture.messages,
      attachmentSlots: fixture.slots,
      workspaceRoot: WORKSPACE_ROOT,
      rootSessionId: ROOT_SESSION_ID,
      supportsImages: true,
    });

    const content = fixture.messages[0]!.content;
    expect(Array.isArray(content)).toBe(true);
    expect((content as Array<{ type: string; text?: string }>)[0]!.text).toContain(
      `<path>${getAttachmentContentPath(WORKSPACE_ROOT, ROOT_SESSION_ID, attachment.id)}</path>`,
    );
    const image = (content as Array<{ type: string; image?: Uint8Array; mediaType?: string }>)[1]!;
    expect(image).toMatchObject({ type: "image", mediaType: "image/png" });
    expect(image.image).toBe(bytes);
    expect(reader.readVerified).toHaveBeenCalledTimes(1);
  });

  test("never reads binary content for text-only bindings or generic files", async () => {
    const image = descriptor();
    const generic = descriptor({
      id: crypto.randomUUID(),
      name: "archive.zip",
      mediaType: "application/zip",
      kind: "file",
    });
    const imageFixture = projectionFixture(image);
    const genericFixture = projectionFixture(generic);
    const reader = readerFor(image);
    const projector = new SessionAttachmentModelProjector(reader);

    await projector.project({
      messages: imageFixture.messages,
      attachmentSlots: imageFixture.slots,
      workspaceRoot: WORKSPACE_ROOT,
      rootSessionId: ROOT_SESSION_ID,
      supportsImages: false,
    });
    await projector.project({
      messages: genericFixture.messages,
      attachmentSlots: genericFixture.slots,
      workspaceRoot: WORKSPACE_ROOT,
      rootSessionId: ROOT_SESSION_ID,
      supportsImages: true,
    });

    expect(reader.readVerified).not.toHaveBeenCalled();
    expect(reader.resolveReadPath).toHaveBeenCalledTimes(2);
    for (const [attachment, fixture] of [
      [image, imageFixture],
      [generic, genericFixture],
    ] as const) {
      expect(JSON.stringify(fixture.messages)).toContain(
        getAttachmentContentPath(WORKSPACE_ROOT, ROOT_SESSION_ID, attachment.id),
      );
      expect(JSON.stringify(fixture.messages)).not.toContain('"type":"image"');
    }
  });

  test("follows the marker object after reordering and skips replacement or forged marker text", async () => {
    const attachment = descriptor();
    const fixture = projectionFixture(attachment);
    const forged: AttachmentMarkerPart = {
      type: "text",
      text: renderAttachmentMarker(attachment),
    };
    const content = (fixture.messages[0] as Extract<ModelMessage, { role: "user" }>).content;
    if (typeof content === "string") throw new Error("Expected array content");
    content.unshift({ type: "text", text: "before" }, forged);
    const reader = readerFor(attachment);
    const projector = new SessionAttachmentModelProjector(reader);

    await projector.project({
      messages: fixture.messages,
      attachmentSlots: fixture.slots,
      workspaceRoot: WORKSPACE_ROOT,
      rootSessionId: ROOT_SESSION_ID,
      supportsImages: true,
    });

    expect(content.findIndex((part) => part === fixture.markerPart)).toBe(2);
    expect(content[3]).toMatchObject({ type: "image" });
    expect(forged.text).toBe(renderAttachmentMarker(attachment));

    const replacedMessages: ModelMessage[] = [{
      role: "user",
      content: [{ ...fixture.markerPart }],
    }];
    await projector.project({
      messages: replacedMessages,
      attachmentSlots: fixture.slots,
      workspaceRoot: WORKSPACE_ROOT,
      rootSessionId: ROOT_SESSION_ID,
      supportsImages: true,
    });
    expect(reader.readVerified).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(replacedMessages)).not.toContain('"type":"image"');
  });
});
