import { useEffect, useRef, useState, type Ref } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { DiffFile, DiffHunk, DiffLine } from "@archcode/protocol";

const STATUS_STYLES: Record<string, string> = {
  modified: "bg-warning-muted text-warning",
  created: "bg-success-muted text-success",
  deleted: "bg-error-muted text-error",
};

const STATUS_LABELS: Record<string, string> = {
  modified: "M",
  created: "A",
  deleted: "D",
};

export interface DiffLineNumbers {
  oldLine: string;
  newLine: string;
  nextLine: { old: number; new: number };
}

export function computeDiffLineNumbers(
  line: DiffLine,
  oldLine: number,
  newLine: number,
): DiffLineNumbers {
  if (line.type === "add") {
    return {
      oldLine: "",
      newLine: String(newLine),
      nextLine: { old: oldLine, new: newLine + 1 },
    };
  }
  if (line.type === "delete") {
    return {
      oldLine: String(oldLine),
      newLine: "",
      nextLine: { old: oldLine + 1, new: newLine },
    };
  }
  return {
    oldLine: String(oldLine),
    newLine: String(newLine),
    nextLine: { old: oldLine + 1, new: newLine + 1 },
  };
}

export function DiffLineRow({
  line,
  oldLine,
  newLine,
}: {
  line: DiffLine;
  oldLine: string;
  newLine: string;
}) {
  const bgClass =
    line.type === "add"
      ? "bg-success-muted text-success"
      : line.type === "delete"
        ? "bg-error-muted text-error"
        : "";

  const marker = line.type === "add" ? "+" : line.type === "delete" ? "-" : " ";

  const gutterBg =
    line.type === "add"
      ? "bg-success-muted-opaque"
      : line.type === "delete"
        ? "bg-error-muted-opaque"
        : "bg-bg-surface";

  const lineNum = line.type === "delete" ? oldLine : newLine;

  return (
    <div className={`flex font-mono text-[12px] leading-[18px] ${bgClass}`}>
      <div className={`sticky left-0 z-10 flex shrink-0 ${gutterBg}`}>
        <span className="w-[32px] shrink-0 select-none pr-2 text-right text-text-tertiary">
          {lineNum}
        </span>
        <span className="w-[14px] shrink-0 select-none">{marker}</span>
      </div>
      <span className="whitespace-pre">
        {line.content}
      </span>
    </div>
  );
}

export function DiffHunkBlock({ hunk }: { hunk: DiffHunk }) {
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;

  return (
    <div className="mb-px overflow-hidden rounded-md border border-border-subtle">
      <div className="sticky left-0 z-20 min-w-full cursor-default whitespace-pre bg-bg-elevated px-3 py-1 font-mono text-[12px] leading-[18px] text-text-tertiary">
        {hunk.header}
      </div>
      {hunk.lines.map((line, i) => {
        const rendered = computeDiffLineNumbers(line, oldLine, newLine);
        oldLine = rendered.nextLine.old;
        newLine = rendered.nextLine.new;
        return (
          <DiffLineRow
            key={i}
            line={line}
            oldLine={rendered.oldLine}
            newLine={rendered.newLine}
          />
        );
      })}
    </div>
  );
}

export function DiffFileAccordion({
  file,
  isExpanded,
  onToggle,
  buttonRef,
}: {
  file: DiffFile;
  isExpanded: boolean;
  onToggle: () => void;
  buttonRef?: Ref<HTMLButtonElement>;
}) {
  const status = file.status ?? "modified";

  return (
    <div className="border-b border-border-subtle" data-diff-file={file.path}>
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={isExpanded}
        className="flex min-h-10 w-full cursor-pointer items-center gap-2 bg-bg-elevated px-[11px] py-0 text-left transition-colors duration-[var(--motion-fast)] hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand"
        onClick={onToggle}
      >
        <span className="shrink-0 text-text-muted" aria-hidden="true">
          {isExpanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        </span>
        <span
          className={`shrink-0 rounded-sm px-2 py-px text-[10.5px] font-semibold leading-4 ${STATUS_STYLES[status] ?? "bg-bg-elevated text-text-tertiary"}`}
        >
          {STATUS_LABELS[status] ?? "?"}
        </span>
        <span className="truncate font-mono text-[10.5px] font-semibold leading-none text-text-primary">
          {file.path}
        </span>
        {(file.additions !== undefined || file.deletions !== undefined) && (
          <span className="ml-auto shrink-0 text-[10px] text-text-tertiary">
            {file.additions !== undefined && (
              <span className="text-success">+{file.additions}</span>
            )}
            {file.additions !== undefined && file.deletions !== undefined && " "}
            {file.deletions !== undefined && (
              <span className="text-error">-{file.deletions}</span>
            )}
          </span>
        )}
      </button>
      {isExpanded && (
        <div className="overflow-x-auto">
          {file.hunks.map((hunk, i) => (
            <DiffHunkBlock key={`${file.path}-hunk-${i}`} hunk={hunk} />
          ))}
        </div>
      )}
    </div>
  );
}

export interface DiffViewProps {
  files: DiffFile[];
  defaultExpanded?: boolean;
  defaultExpandedPath?: string;
  selectedPath?: string;
  className?: string;
}

export function DiffView({ files, defaultExpanded = false, defaultExpandedPath, selectedPath, className = "" }: DiffViewProps) {
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(
    () => new Set(defaultExpanded
      ? files.map((file) => file.path)
      : (selectedPath ?? defaultExpandedPath) === undefined
        ? []
        : [selectedPath ?? defaultExpandedPath!]),
  );
  const selectedButtonRef = useRef<HTMLButtonElement | null>(null);
  const lastRevealedPathRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (selectedPath === undefined || !files.some((file) => file.path === selectedPath)) return;
    setExpandedFiles((previous) => previous.has(selectedPath)
      ? previous
      : new Set([...previous, selectedPath]));
  }, [files, selectedPath]);

  useEffect(() => {
    if (selectedPath === undefined || !files.some((file) => file.path === selectedPath)) {
      lastRevealedPathRef.current = undefined;
      return;
    }
    if (lastRevealedPathRef.current === selectedPath) return;
    const button = selectedButtonRef.current;
    if (button === null) return;
    lastRevealedPathRef.current = selectedPath;
    button.focus({ preventScroll: true });
    button.scrollIntoView?.({ block: "start", behavior: "auto" });
  }, [files, selectedPath]);

  const toggleExpand = (path: string) => {
    setExpandedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  if (files.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-text-tertiary">No changes</p>
      </div>
    );
  }

  return (
    <div className={`h-full min-w-0 overflow-y-auto overflow-x-hidden ${className}`}>
      {files.map((file) => (
        <DiffFileAccordion
          key={file.path}
          file={file}
          isExpanded={expandedFiles.has(file.path)}
          onToggle={() => toggleExpand(file.path)}
          buttonRef={file.path === selectedPath ? selectedButtonRef : undefined}
        />
      ))}
    </div>
  );
}
