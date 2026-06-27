import { useState } from "react";
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
    <div className={`flex ${bgClass}`}>
      <div className={`sticky left-0 z-10 flex shrink-0 ${gutterBg}`}>
        <span className="w-[32px] shrink-0 text-right pr-2 text-[10px] text-text-muted select-none">
          {lineNum}
        </span>
        <span className="shrink-0 w-[14px] text-[11px] select-none">{marker}</span>
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
    <div className="border border-border-subtle rounded-sm mb-px">
      <div className="bg-bg-elevated px-3 py-1 text-[11px] text-text-muted cursor-default whitespace-pre sticky left-0 z-20 min-w-full">
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
}: {
  file: DiffFile;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const status = file.status ?? "modified";

  return (
    <div className="border-b border-border-subtle">
      <button
        className="flex w-full items-center gap-2 px-3 py-[6px] cursor-pointer text-left transition-colors duration-150 bg-bg-elevated hover:bg-bg-hover"
        onClick={onToggle}
      >
        <span className="text-text-muted shrink-0">
          {isExpanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        </span>
        <span
          className={`shrink-0 rounded-[3px] px-[6px] py-px text-[10px] font-semibold ${STATUS_STYLES[status] ?? "bg-bg-elevated text-text-muted"}`}
        >
          {STATUS_LABELS[status] ?? "?"}
        </span>
        <span className="truncate font-mono text-[12px] font-medium text-text-primary">
          {file.path}
        </span>
        {(file.additions !== undefined || file.deletions !== undefined) && (
          <span className="ml-auto shrink-0 text-[10px] text-text-muted">
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
}

export function DiffView({ files, defaultExpanded = false }: DiffViewProps) {
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(
    () => new Set(defaultExpanded ? files.map((f) => f.path) : []),
  );

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
    <div className="h-full min-w-0 overflow-y-auto overflow-x-hidden">
      {files.map((file) => (
        <DiffFileAccordion
          key={file.path}
          file={file}
          isExpanded={expandedFiles.has(file.path)}
          onToggle={() => toggleExpand(file.path)}
        />
      ))}
    </div>
  );
}