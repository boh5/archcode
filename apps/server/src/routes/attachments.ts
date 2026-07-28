import {
  type AgentRuntime,
} from "@archcode/agent-core";
import { Hono } from "hono";
import { z } from "zod/v4";
import { ServerError } from "../errors";
import { resolveProject } from "../resolve";
import { zValidator } from "../validation";
import { mapAttachmentHttpError } from "./attachment-http-error";

const AttachmentParamsSchema = z.strictObject({
  slug: z.string().min(1),
  sessionId: z.string().min(1),
  attachmentId: z.uuid(),
});

export function createAttachmentsRoutes(runtime: AgentRuntime): Hono {
  const app = new Hono();

  app.put(
    "/:attachmentId",
    zValidator("param", AttachmentParamsSchema),
    async (c) => {
      const { slug, sessionId, attachmentId } = c.req.valid("param");
      const project = await resolveProject(runtime, slug);
      const name = c.req.query("name");
      const sizeBytes = parseDecimal(c.req.query("sizeBytes"), "sizeBytes");
      const contentLengthHeader = c.req.header("content-length");
      const contentLength = contentLengthHeader === undefined
        ? undefined
        : parseDecimal(contentLengthHeader, "Content-Length");

      try {
        const result = await runtime.uploadSessionAttachment({
          workspaceRoot: project.workspaceRoot,
          rootSessionId: sessionId,
          attachmentId,
          name: name ?? "",
          sizeBytes,
          mediaType: c.req.header("content-type"),
          contentLength,
          body: c.req.raw.body,
        });
        return c.json(result.descriptor, result.created ? 201 : 200);
      } catch (error) {
        throw mapAttachmentHttpError(error, sessionId)
          ?? (error instanceof Error ? error : new Error("Unknown attachment error"));
      }
    },
  );

  app.get(
    "/:attachmentId",
    zValidator("param", AttachmentParamsSchema),
    async (c) => {
      const { slug, sessionId, attachmentId } = c.req.valid("param");
      const project = await resolveProject(runtime, slug);

      try {
        const opened = await runtime.openSessionAttachment({
          workspaceRoot: project.workspaceRoot,
          rootSessionId: sessionId,
          attachmentId,
        });
        return new Response(Bun.file(opened.contentPath), {
          headers: {
            "content-type": opened.descriptor.mediaType,
            "content-length": String(opened.descriptor.sizeBytes),
            "content-disposition": attachmentDisposition(opened.descriptor.name),
            "x-content-type-options": "nosniff",
          },
        });
      } catch (error) {
        throw mapAttachmentHttpError(error, sessionId)
          ?? (error instanceof Error ? error : new Error("Unknown attachment error"));
      }
    },
  );

  return app;
}

function parseDecimal(value: string | undefined, label: string): number {
  if (value === undefined || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new ServerError(
      "ATTACHMENT_INVALID",
      `${label} must be a non-negative decimal integer`,
      400,
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new ServerError(
      "ATTACHMENT_INVALID",
      `${label} is outside the supported integer range`,
      400,
    );
  }
  return parsed;
}

export function attachmentDisposition(name: string): string {
  const asciiFilename = [...name]
    .map((character) => /[A-Za-z0-9._ -]/.test(character) ? character : "_")
    .join("")
    .trim() || "attachment";
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encoded}`;
}
