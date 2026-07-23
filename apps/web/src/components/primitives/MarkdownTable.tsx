import { Check, Copy, Download, Maximize2, X } from "lucide-react";
import {
  type ComponentPropsWithoutRef,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  TableCopyDropdown,
  TableDownloadDropdown,
  type ExtraProps,
} from "streamdown";
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
  DialogTrigger,
} from "../ui/Dialog";

type MarkdownTableProps = ComponentPropsWithoutRef<"table"> & ExtraProps;
const COPY_FEEDBACK_MS = 2_000;

function TableActionIcon({
  children,
  label,
}: {
  readonly children: ReactNode;
  readonly label: string;
}) {
  return (
    <>
      {children}
      <span className="sr-only">{label}</span>
    </>
  );
}

function TableCopyAction() {
  const [copied, setCopied] = useState(false);
  const resetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (resetTimeoutRef.current !== null) {
      globalThis.clearTimeout(resetTimeoutRef.current);
    }
  }, []);

  const showCopyFeedback = () => {
    if (resetTimeoutRef.current !== null) {
      globalThis.clearTimeout(resetTimeoutRef.current);
    }
    setCopied(true);
    resetTimeoutRef.current = globalThis.setTimeout(() => {
      setCopied(false);
      resetTimeoutRef.current = null;
    }, COPY_FEEDBACK_MS);
  };

  return (
    <TableCopyDropdown
      className="markdown-table-action"
      onCopy={showCopyFeedback}
      timeout={COPY_FEEDBACK_MS}
    >
      <TableActionIcon label={copied ? "Table copied" : "Copy table"}>
        {copied
          ? <Check aria-hidden="true" size={14} />
          : <Copy aria-hidden="true" size={14} />}
      </TableActionIcon>
    </TableCopyDropdown>
  );
}

function TableTransferActions() {
  return (
    <>
      <TableCopyAction />
      <TableDownloadDropdown className="markdown-table-action">
        <TableActionIcon label="Download table">
          <Download aria-hidden="true" size={14} />
        </TableActionIcon>
      </TableDownloadDropdown>
    </>
  );
}

function TableGrid({
  children,
  className,
  ...props
}: ComponentPropsWithoutRef<"table">) {
  return (
    <table
      {...props}
      className={`markdown-table-grid${className ? ` ${className}` : ""}`}
      data-streamdown="table"
    >
      {children}
    </table>
  );
}

export function MarkdownTable({
  children,
  className,
  id,
  node: _node,
  ...tableProps
}: MarkdownTableProps) {
  return (
    <DialogRoot>
      <div
        data-markdown-table="surface"
        data-markdown-table-context="inline"
        data-streamdown="table-wrapper"
      >
        <div data-markdown-table="toolbar">
          <span aria-hidden="true" data-markdown-table="label">Table</span>
          <div data-markdown-table="actions">
            <TableTransferActions />
            <DialogTrigger asChild>
              <button
                aria-label="View table fullscreen"
                className="markdown-table-action"
                title="View table fullscreen"
                type="button"
              >
                <Maximize2 aria-hidden="true" size={14} />
              </button>
            </DialogTrigger>
          </div>
        </div>
        <div data-markdown-table="scroll">
          <TableGrid {...tableProps} className={className} id={id}>
            {children}
          </TableGrid>
        </div>
      </div>

      <DialogContent
        className="markdown-table-dialog overflow-hidden p-0"
        size="x-large"
      >
        <div
          data-markdown-table="surface"
          data-markdown-table-context="dialog"
          data-streamdown="table-wrapper"
        >
          <div data-markdown-table="toolbar">
            <div>
              <DialogTitle data-markdown-table="label">Table</DialogTitle>
              <DialogDescription className="sr-only">
                Expanded Markdown table
              </DialogDescription>
            </div>
            <div data-markdown-table="actions">
              <TableTransferActions />
              <DialogClose asChild>
                <button
                  aria-label="Close table fullscreen"
                  className="markdown-table-action"
                  title="Close table fullscreen"
                  type="button"
                >
                  <X aria-hidden="true" size={14} />
                </button>
              </DialogClose>
            </div>
          </div>
          <div data-markdown-table="scroll">
            <TableGrid {...tableProps} className={className}>
              {children}
            </TableGrid>
          </div>
        </div>
      </DialogContent>
    </DialogRoot>
  );
}
