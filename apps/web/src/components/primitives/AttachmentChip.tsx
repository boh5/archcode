import { File, Image } from "lucide-react";
import type { AttachmentDescriptor } from "@archcode/protocol";

export function formatAttachmentSize(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KiB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function AttachmentChip({
  attachment,
  className = "",
}: {
  attachment: AttachmentDescriptor;
  className?: string;
}) {
  const Icon = attachment.kind === "image" ? Image : File;
  return (
    <span
      className={`inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-sm border border-border-subtle bg-bg-elevated px-2 py-1 text-[11px] leading-4 text-text-secondary ${className}`}
      data-testid={`attachment-chip-${attachment.id}`}
      title={`${attachment.name} · ${attachment.mediaType} · ${formatAttachmentSize(attachment.sizeBytes)}`}
    >
      <Icon aria-hidden="true" className="shrink-0 text-text-tertiary" size={12} />
      <span className="min-w-0 truncate">{attachment.name}</span>
      <span className="shrink-0 text-text-tertiary">{formatAttachmentSize(attachment.sizeBytes)}</span>
    </span>
  );
}
